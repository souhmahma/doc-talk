import os
import asyncio
import tempfile
from typing import AsyncGenerator
from dotenv import load_dotenv

import strawberry
from strawberry.fastapi import GraphQLRouter
from strawberry.file_uploads import Upload
from strawberry.subscriptions import GRAPHQL_TRANSPORT_WS_PROTOCOL
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain.callbacks.base import BaseCallbackHandler
from langchain.chains import ConversationalRetrievalChain
from langchain.memory import ConversationBufferMemory
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

load_dotenv()

# ---------- LangChain singletons ----------
embeddings = OpenAIEmbeddings()
vector_store = Chroma(embedding_function=embeddings)
memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True)


class QueueCallback(BaseCallbackHandler):

    def __init__(self, queue: asyncio.Queue):
        self.queue = queue
        self._loop = None

    def _put(self, item):
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self.queue.put_nowait, item)

    def on_llm_new_token(self, token: str, **kwargs):
        self._put(token)

    def on_llm_end(self, *args, **kwargs):
        self._put(None)  # sentinel


# ---------- GraphQL Types ----------
@strawberry.type
class UploadResult:
    filename: str
    chunks: int
    status: str


@strawberry.type
class TokenEvent:
    token: str
    done: bool


# ---------- Mutation ----------
@strawberry.type
class Mutation:
    @strawberry.mutation
    async def upload_document(self, file: Upload) -> UploadResult:
        """Index a file into ChromaDB"""
        content = await file.read()
        filename = file.filename or "document"
        suffix = ".pdf" if filename.lower().endswith(".pdf") else ".txt"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        loader = PyPDFLoader(tmp_path) if suffix == ".pdf" else TextLoader(tmp_path)
        docs = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = splitter.split_documents(docs)
        vector_store.add_documents(chunks)
        os.unlink(tmp_path)

        return UploadResult(filename=filename, chunks=len(chunks), status="indexed")

    @strawberry.mutation
    def reset_memory(self) -> str:
        memory.clear()
        return "ok"


# ---------- Subscription ----------
@strawberry.type
class Subscription:
    @strawberry.subscription
    async def ask(self, question: str) -> AsyncGenerator[TokenEvent, None]:
        """
        Stream the RAG response tokens
        """
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        cb = QueueCallback(queue)
        cb._loop = loop

        llm = ChatOpenAI(
            model="gpt-4o-mini",
            streaming=True,
            callbacks=[cb],
            temperature=0,
        )
        chain = ConversationalRetrievalChain.from_llm(
            llm=llm,
            retriever=vector_store.as_retriever(search_kwargs={"k": 4}),
            memory=memory,
            verbose=False,
        )

        task = loop.run_in_executor(
            None, lambda: chain.invoke({"question": question})
        )

        while True:
            token = await queue.get()
            if token is None:
                yield TokenEvent(token="", done=True)
                break
            yield TokenEvent(token=token, done=False)

        await task


# ---------- Query ----------
@strawberry.type
class Query:
    @strawberry.field
    def health(self) -> str:
        return "ok"


# ---------- App ----------
schema = strawberry.Schema(
    query=Query,
    mutation=Mutation,
    subscription=Subscription,
)

graphql_router = GraphQLRouter(
    schema,
    subscription_protocols=[GRAPHQL_TRANSPORT_WS_PROTOCOL],
)

app = FastAPI(title="RAG GraphQL API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(graphql_router, prefix="/graphql")
