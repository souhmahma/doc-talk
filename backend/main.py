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

# LangChain imports
from langchain.callbacks.base import BaseCallbackHandler
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_openai import ChatOpenAI
from langchain_huggingface import HuggingFaceEmbeddings
from langchain.memory import ConversationBufferMemory
from langchain.chains import create_history_aware_retriever, create_retrieval_chain
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

load_dotenv()

# ---------- Configuration Globale ----------
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
vector_store = Chroma(embedding_function=embeddings)
memory = ConversationBufferMemory(memory_key="chat_history", return_messages=True)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

class QueueCallback(BaseCallbackHandler):
    """Capte les tokens uniquement pour le LLM auquel il est attaché."""
    def __init__(self, queue: asyncio.Queue):
        self.queue = queue
        self._loop = None

    def _put(self, item):
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self.queue.put_nowait, item)

    def on_llm_new_token(self, token: str, **kwargs):
        self._put(token)

    def on_llm_end(self, *args, **kwargs):
        self._put(None)

# ---------- Types GraphQL ----------
@strawberry.type
class UploadResult:
    filename: str
    chunks: int
    status: str

@strawberry.type
class TokenEvent:
    token: str
    done: bool

# ---------- Mutations ----------
@strawberry.type
class Mutation:
    @strawberry.mutation
    async def upload_document(self, file: Upload) -> UploadResult:
        content = await file.read()
        filename = file.filename or "document"
        suffix = ".pdf" if filename.lower().endswith(".pdf") else ".txt"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        try:
            loader = PyPDFLoader(tmp_path) if suffix == ".pdf" else TextLoader(tmp_path)
            docs = loader.load()
            splitter = RecursiveCharacterTextSplitter(chunk_size=600, chunk_overlap=100)
            chunks = splitter.split_documents(docs)
            vector_store.add_documents(chunks)
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        return UploadResult(filename=filename, chunks=len(chunks), status="indexed")

    @strawberry.mutation
    def reset_memory(self) -> str:
        memory.clear()
        return "ok"

# ---------- Subscriptions ----------
@strawberry.type
class Subscription:
    @strawberry.subscription
    async def ask(self, question: str) -> AsyncGenerator[TokenEvent, None]:
        queue: asyncio.Queue = asyncio.Queue()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()

        cb = QueueCallback(queue)
        cb._loop = loop

        llm_rewrite = ChatOpenAI(
            openai_api_key=GROQ_API_KEY,
            openai_api_base="https://api.groq.com/openai/v1",
            model_name="llama-3.3-70b-versatile",
            streaming=False,
            temperature=0,
        )

        llm_answer = ChatOpenAI(
            openai_api_key=GROQ_API_KEY,
            openai_api_base="https://api.groq.com/openai/v1",
            model_name="llama-3.3-70b-versatile",
            streaming=True,
            callbacks=[cb],
            temperature=0,
        )

        context_prompt = ChatPromptTemplate.from_messages([
            ("system", "Given the chat history and the user's latest question, formulate a standalone question. Output ONLY the reformulated question and nothing else."),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ])
        
        retriever = vector_store.as_retriever(search_kwargs={"k": 3})
        history_aware_retriever = create_history_aware_retriever(llm_rewrite, retriever, context_prompt)

        qa_prompt = ChatPromptTemplate.from_messages([
            ("system", "You are a professional assistant. Answer the question using ONLY the provided context. If the answer isn't in the context, say you don't know.\n\nContext:\n{context}"),
            MessagesPlaceholder("chat_history"),
            ("human", "{input}"),
        ])

        question_answer_chain = create_stuff_documents_chain(llm_answer, qa_prompt)
        rag_chain = create_retrieval_chain(history_aware_retriever, question_answer_chain)

        chat_history = memory.load_memory_variables({})["chat_history"]

        task = loop.run_in_executor(
            None, 
            lambda: rag_chain.invoke({"input": question, "chat_history": chat_history})
        )

        while True:
            token = await queue.get()
            if token is None:
                yield TokenEvent(token="", done=True)
                break
            yield TokenEvent(token=token, done=False)

        result = await task
        memory.save_context({"input": question}, {"output": result["answer"]})

# ---------- FastAPI Setup ----------
@strawberry.type
class Query:
    @strawberry.field
    def health(self) -> str: return "ok"

schema = strawberry.Schema(query=Query, mutation=Mutation, subscription=Subscription)
graphql_router = GraphQLRouter(schema, subscription_protocols=[GRAPHQL_TRANSPORT_WS_PROTOCOL])

app = FastAPI(title="RAG Final Groq")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(graphql_router, prefix="/graphql")