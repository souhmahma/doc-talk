import { useState, useRef, useEffect } from "react";
import { useMutation, useSubscription, gql } from "@apollo/client";

// ---------- GraphQL Operations ----------
const UPLOAD_DOCUMENT = gql`
  mutation UploadDocument($file: Upload!) {
    uploadDocument(file: $file) {
      filename
      chunks
      status
    }
  }
`;

const RESET_MEMORY = gql`
  mutation ResetMemory {
    resetMemory
  }
`;

const ASK_SUBSCRIPTION = gql`
  subscription Ask($question: String!) {
    ask(question: $question) {
      token
      done
    }
  }
`;

// ---------- App ----------
export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [docName, setDocName] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const fileRef = useRef(null);
  const bottomRef = useRef(null);

  const [uploadDocument] = useMutation(UPLOAD_DOCUMENT);
  const [resetMemory] = useMutation(RESET_MEMORY);

  // Subscription active only when a question is being asked
  const { data: subData } = useSubscription(ASK_SUBSCRIPTION, {
    variables: { question: activeQuestion ?? "" },
    skip: !activeQuestion,
  });

  // Accumulate tokens into the last assistant message
  useEffect(() => {
    if (!subData) return;
    const { token, done } = subData.ask;

    if (done) {
      setActiveQuestion(null);
      setIsStreaming(false);
      return;
    }

    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        next[next.length - 1] = { ...last, content: last.content + token };
      }
      return next;
    });
  }, [subData]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { data } = await uploadDocument({ variables: { file } });
      const r = data.uploadDocument;
      setDocName(r.filename);
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `✓ "${r.filename}" indexed — ${r.chunks} chunks ready.` },
      ]);
    } finally {
      setUploading(false);
    }
  };

  const handleAsk = () => {
    if (!input.trim() || isStreaming || !docName) return;
    const question = input.trim();
    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);
    setIsStreaming(true);
    setActiveQuestion(question);
  };

  const handleReset = async () => {
    await resetMemory();
    setMessages([]);
    setDocName(null);
    setActiveQuestion(null);
    setIsStreaming(false);
  };

  return (
    <div
      style={s.root}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
    >
      {/* Header */}
      <header style={s.header}>
        <div style={s.row}>
          <span style={s.logo}>◈ DocTalk</span>
          {docName && (
            <span style={s.docBadge}>
              <span style={{ color: "var(--green)" }}>●</span> {docName}
            </span>
          )}
        </div>
        <div style={s.row}>
          <button style={s.btnGhost} onClick={() => fileRef.current.click()} disabled={uploading}>
            {uploading ? "⟳ uploading…" : "↑ upload"}
          </button>
          {messages.length > 0 && (
            <button style={{ ...s.btnGhost, color: "var(--muted)" }} onClick={handleReset}>
              ✕ reset
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.md" hidden
          onChange={(e) => handleFile(e.target.files[0])} />
      </header>

      {/* Messages */}
      <main style={s.main}>
        {messages.length === 0 ? (
          <div style={s.empty}>
            <p style={s.emptyTitle}>Drop a document</p>
            <p style={s.emptyHint}>PDF or text — then ask questions</p>
            <div style={{
              ...s.dropZone,
              borderColor: dragging ? "var(--accent)" : "var(--border)",
              background: dragging ? "var(--accent-dim)" : "transparent",
            }}>
              {dragging ? "Release here" : "⊕ drag & drop"}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => <Message key={i} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </main>

      {/* Input */}
      <div style={s.form}>
        <input
          style={s.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
          placeholder={docName ? "Ask a question…" : "Upload a document first"}
          disabled={!docName || isStreaming}
        />
        <button
          style={{ ...s.btnSend, opacity: (!input.trim() || isStreaming || !docName) ? 0.3 : 1 }}
          onClick={handleAsk}
          disabled={!input.trim() || isStreaming || !docName}
        >
          →
        </button>
      </div>
    </div>
  );
}

function Message({ msg }) {
  if (msg.role === "system") return <div style={s.systemMsg}>{msg.content}</div>;
  const isUser = msg.role === "user";
  return (
    <div style={{ ...s.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
      {!isUser && <span style={s.roleTag}>ai</span>}
      <div style={{
        ...s.bubble,
        background: isUser ? "var(--accent-dim)" : "var(--surface)",
        borderLeftColor: "var(--accent)",
      }}>
        {msg.content || <span style={{ color: "var(--muted)" }}>▋</span>}
      </div>
      {isUser && <span style={s.roleTag}>you</span>}
    </div>
  );
}

const s = {
  root: { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: "860px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--border)", gap: "12px" },
  row: { display: "flex", alignItems: "center", gap: "10px" },
  logo: { fontFamily: "var(--font-display)", fontSize: "18px", fontWeight: 600, color: "var(--accent)" },
  gqlBadge: { fontSize: "10px", background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent)", padding: "2px 7px", borderRadius: "3px", letterSpacing: "0.05em" },
  docBadge: { fontSize: "12px", color: "var(--muted)", display: "flex", alignItems: "center", gap: "5px" },
  btnGhost: { background: "transparent", border: "1px solid var(--border)", color: "var(--text)", padding: "5px 12px", fontSize: "12px", borderRadius: "4px" },
  main: { flex: 1, overflowY: "auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: "16px" },
  empty: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px" },
  emptyTitle: { fontFamily: "var(--font-display)", fontSize: "28px", fontWeight: 300, fontStyle: "italic" },
  emptyHint: { color: "var(--muted)", fontSize: "13px" },
  dropZone: { marginTop: "20px", border: "1px dashed", padding: "28px 60px", borderRadius: "6px", color: "var(--muted)", fontSize: "13px", transition: "all 0.15s", textAlign: "center" },
  msgRow: { display: "flex", alignItems: "flex-start", gap: "10px" },
  roleTag: { fontSize: "10px", color: "var(--muted)", padding: "3px 0", minWidth: "24px", textAlign: "center", marginTop: "2px" },
  bubble: { maxWidth: "72%", padding: "10px 14px", borderRadius: "4px", border: "1px solid var(--border)", borderLeftWidth: "2px", lineHeight: 1.65, whiteSpace: "pre-wrap", fontSize: "13.5px" },
  systemMsg: { textAlign: "center", color: "var(--green)", fontSize: "12px", padding: "6px", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" },
  form: { display: "flex", gap: "8px", padding: "14px 20px", borderTop: "1px solid var(--border)" },
  input: { flex: 1, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", padding: "10px 14px", borderRadius: "4px", fontSize: "13.5px", outline: "none" },
  btnSend: { background: "var(--accent)", border: "none", color: "#1a1100", width: "42px", borderRadius: "4px", fontSize: "18px", fontWeight: 700, transition: "opacity 0.15s" },
};
