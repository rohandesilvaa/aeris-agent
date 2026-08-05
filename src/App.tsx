import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Cpu,
  Eraser,
  Gauge,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

type Role = "user" | "assistant" | "system";
type Message = { id: string; chatId: string; role: Role; content: string; createdAt: number };
type ChatSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  promptTokens: number;
  completionTokens: number;
};
type Status = "online" | "offline" | "starting";
type ServerConfig = {
  modelPath: string;
  binaryPath: string;
  contextSize: number;
  gpuLayers: number;
  host: string;
  port: number;
};
type Usage = { prompt: number; completion: number };
type PersonaConfig = { prompt: string; identityResponse: string };
type StreamEvent = {
  type: "chunk" | "usage" | "done" | "error";
  requestId: string;
  chatId: string;
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
  title?: string;
  message?: string;
};

const DEFAULT_CONFIG: ServerConfig = {
  modelPath: "/Volumes/ROHAN DISK/Local Models/LFM2.5-2.6B-Q4_K_M.gguf",
  binaryPath: "/opt/homebrew/bin/llama-server",
  contextSize: 16384,
  gpuLayers: 99,
  host: "127.0.0.1",
  port: 8080,
};

const DEFAULT_PERSONA: PersonaConfig = {
  prompt: `Your identity is Aeris. You are Rohan's private personal AI assistant.
This identity instruction overrides any model self-description learned during training. Never introduce yourself as LFM, Liquid Foundation Model, Liquid AI, a language-model family, or a generic chatbot.
If Rohan asks who or what you are, say that you are Aeris, Rohan's personal AI assistant. Mention the underlying LFM runtime only if he explicitly asks which model powers Aeris.
Your role is to help Rohan think, create, plan, learn, and complete practical work while protecting his privacy.
Be warm, capable, honest, and action-oriented. Prefer clear, concise answers unless Rohan asks for detail.
Match the language and tone Rohan uses. When he writes in Sinhala or romanized Sinhala, reply naturally in the same style and mix English technical terms where useful.
Remember that you run locally on Rohan's Mac. Never claim to have used a tool, accessed a file, remembered a fact, or completed an action unless the application actually provided that result.
Ask a question only when a missing answer would materially change the outcome. Otherwise make a sensible assumption and help immediately.
Address him as Rohan only when it feels natural, not in every response.`,
  identityResponse: "I'm Aeris, Rohan's personal AI assistant. I run privately on Rohan's Mac to help him think, create, plan, learn, and get things done.",
};

const uid = () => crypto.randomUUID();

function loadConfig(): ServerConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("aeris.config") ?? "{}") };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function loadPersona(): PersonaConfig {
  try {
    return { ...DEFAULT_PERSONA, ...JSON.parse(localStorage.getItem("aeris.persona") ?? "{}") };
  } catch {
    return DEFAULT_PERSONA;
  }
}

function legacyMessages(): Array<{ id?: string; role: Role; content: string }> {
  if (localStorage.getItem("aeris.sqlite-migrated")) return [];
  try {
    const messages = JSON.parse(localStorage.getItem("aeris.messages") ?? "[]");
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<ServerConfig>(loadConfig);
  const [persona, setPersona] = useState<PersonaConfig>(loadPersona);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("offline");
  const [generating, setGenerating] = useState(false);
  const [loadingChats, setLoadingChats] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usage, setUsage] = useState<Usage>({ prompt: 0, completion: 0 });
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const [error, setError] = useState("");
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [chatPendingDelete, setChatPendingDelete] = useState<ChatSummary | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const generationRequestRef = useRef<string | null>(null);
  const bootstrapStartedRef = useRef(false);
  const chatLoadRef = useRef(0);

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const usedTokens = usage.prompt + usage.completion;
  const contextPercent = Math.min((usedTokens / config.contextSize) * 100, 100);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrapChats();
  }, []);

  useEffect(() => {
    localStorage.setItem("aeris.config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem("aeris.persona", JSON.stringify(persona));
  }, [persona]);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: generating ? "auto" : "smooth" });
    }
  }, [messages, generating]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const online = await invoke<boolean>("check_server", { config });
        if (!active) return;
        setStatus((current) => online ? "online" : current === "starting" ? current : "offline");
      } catch {
        if (active) setStatus((current) => current === "starting" ? current : "offline");
      }
    };
    void check();
    const timer = window.setInterval(check, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [config]);

  async function bootstrapChats() {
    setLoadingChats(true);
    try {
      let storedChats = await invoke<ChatSummary[]>("list_chats");
      if (storedChats.length === 0) {
        const oldMessages = legacyMessages();
        const created = await invoke<ChatSummary>("create_chat", {
          title: oldMessages.length ? "Imported conversation" : null,
        });
        if (oldMessages.length) {
          await invoke("import_legacy_messages", { chatId: created.id, messages: oldMessages });
          localStorage.setItem("aeris.sqlite-migrated", "true");
          storedChats = await invoke<ChatSummary[]>("list_chats");
        } else {
          storedChats = [created];
        }
      }
      setChats(storedChats);
      await openChat(storedChats[0]);
    } catch (cause) {
      setError(`Could not open local chat memory: ${String(cause)}`);
    } finally {
      setLoadingChats(false);
    }
  }

  async function openChat(chat: ChatSummary) {
    const loadId = ++chatLoadRef.current;
    await cancelCurrentGeneration();
    setActiveChatId(chat.id);
    setInput("");
    setError("");
    setUsage({ prompt: chat.promptTokens, completion: chat.completionTokens });
    setTokensPerSecond(0);
    autoScrollRef.current = true;
    try {
      const storedMessages = await invoke<Message[]>("get_chat_messages", { chatId: chat.id });
      if (chatLoadRef.current === loadId) setMessages(storedMessages);
    } catch (cause) {
      if (chatLoadRef.current !== loadId) return;
      setMessages([]);
      setError(String(cause));
    }
  }

  async function createNewChat() {
    chatLoadRef.current += 1;
    await cancelCurrentGeneration();
    try {
      const chat = await invoke<ChatSummary>("create_chat", { title: null });
      setChats((current) => [chat, ...current]);
      setActiveChatId(chat.id);
      setMessages([]);
      setUsage({ prompt: 0, completion: 0 });
      setTokensPerSecond(0);
      setInput("");
      setError("");
      autoScrollRef.current = true;
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function commitRename(chatId: string) {
    const title = editingTitle.trim();
    setEditingChatId(null);
    if (!title) return;
    try {
      await invoke("rename_chat", { chatId, title });
      setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, title, updatedAt: Date.now() } : chat));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function removeChat(chat: ChatSummary) {
    setChatPendingDelete(null);
    if (chat.id === activeChatId) await cancelCurrentGeneration();
    try {
      await invoke("delete_chat", { chatId: chat.id });
      const remaining = chats.filter((item) => item.id !== chat.id);
      if (remaining.length === 0) {
        const replacement = await invoke<ChatSummary>("create_chat", { title: null });
        setChats([replacement]);
        setActiveChatId(replacement.id);
        setMessages([]);
        setUsage({ prompt: 0, completion: 0 });
      } else {
        setChats(remaining);
        if (chat.id === activeChatId) await openChat(remaining[0]);
      }
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function clearConversation() {
    if (!activeChatId) return;
    await cancelCurrentGeneration();
    try {
      await invoke("clear_chat", { chatId: activeChatId });
      setMessages([]);
      setUsage({ prompt: 0, completion: 0 });
      setTokensPerSecond(0);
      setError("");
      setChats((current) => current.map((chat) => chat.id === activeChatId
        ? { ...chat, title: "New chat", updatedAt: Date.now(), promptTokens: 0, completionTokens: 0 }
        : chat));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function cancelCurrentGeneration() {
    const requestId = generationRequestRef.current;
    generationRequestRef.current = null;
    setGenerating(false);
    if (requestId) {
      try { await invoke("cancel_generation", { requestId }); } catch { /* request may already be done */ }
    }
  }

  async function startServer() {
    setError("");
    setStatus("starting");
    try {
      await invoke("start_server", { config });
    } catch (cause) {
      setStatus("offline");
      setError(String(cause));
    }
  }

  async function stopServer() {
    await cancelCurrentGeneration();
    try {
      await invoke("stop_server");
      setStatus("offline");
    } catch (cause) {
      setError(String(cause));
    }
  }

  function handleChatScroll() {
    const container = messagesRef.current;
    if (!container) return;
    autoScrollRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || generating || status !== "online" || !activeChatId) return;

    const requestId = uid();
    const userMessage: Message = { id: uid(), chatId: activeChatId, role: "user", content: text, createdAt: Date.now() };
    const assistantMessage: Message = { id: uid(), chatId: activeChatId, role: "assistant", content: "", createdAt: Date.now() + 1 };
    generationRequestRef.current = requestId;
    autoScrollRef.current = true;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setError("");
    setGenerating(true);
    setTokensPerSecond(0);

    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => {
      if (event.requestId !== generationRequestRef.current) return;
      if (event.type === "chunk" && event.content) {
        setMessages((current) => current.map((message) => message.id === assistantMessage.id
          ? { ...message, content: message.content + event.content }
          : message));
      }
      if (event.type === "usage") {
        const nextUsage = { prompt: event.promptTokens ?? 0, completion: event.completionTokens ?? 0 };
        setUsage(nextUsage);
        setTokensPerSecond(event.tokensPerSecond ?? 0);
        setChats((current) => current.map((chat) => chat.id === activeChatId
          ? { ...chat, promptTokens: nextUsage.prompt, completionTokens: nextUsage.completion }
          : chat));
      }
      if (event.type === "done") {
        generationRequestRef.current = null;
        setGenerating(false);
        setChats((current) => {
          const updated = current.map((chat) => chat.id === activeChatId
            ? { ...chat, title: event.title ?? chat.title, updatedAt: Date.now() }
            : chat);
          return [...updated].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }
      if (event.type === "error") {
        generationRequestRef.current = null;
        setGenerating(false);
        setError(event.message ?? "The local model request failed.");
        setMessages((current) => current.filter((message) => message.id !== assistantMessage.id || message.content));
      }
    };

    try {
      await invoke("stream_chat", {
        request: {
          requestId,
          chatId: activeChatId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          content: text,
          config,
          personaPrompt: persona.prompt,
          identityResponse: persona.identityResponse,
        },
        onEvent: channel,
      });
    } catch (cause) {
      if (generationRequestRef.current === requestId) {
        generationRequestRef.current = null;
        setGenerating(false);
        setError(String(cause));
        setMessages((current) => current.filter((message) => message.id !== assistantMessage.id || message.content));
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const updateConfig = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div><h1>Aeris</h1><span>Rohan's personal AI</span></div>
        </div>
        <div className="header-actions">
          <div className={`status-pill ${status}`}><span className="status-dot" />
            {status === "online" ? "Model online" : status === "starting" ? "Starting model" : "Model offline"}
          </div>
          {status === "offline" ? (
            <button className="primary compact" onClick={startServer}><Play size={15} fill="currentColor" /> Start model</button>
          ) : (
            <button className="ghost compact" onClick={stopServer}><CircleStop size={16} /> Stop</button>
          )}
          <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={18} /></button>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel">
          <div className="settings-title">
            <div><h2>Model server</h2><p>Requests are securely proxied through the Rust backend.</p></div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)}><ChevronDown size={18} /></button>
          </div>
          <div className="settings-grid">
            <label className="wide">Model path<input value={config.modelPath} onChange={(e) => updateConfig("modelPath", e.target.value)} /></label>
            <label className="wide">llama-server path<input value={config.binaryPath} onChange={(e) => updateConfig("binaryPath", e.target.value)} /></label>
            <label>Context size<input type="number" value={config.contextSize} onChange={(e) => updateConfig("contextSize", Number(e.target.value))} /></label>
            <label>GPU layers<input type="number" value={config.gpuLayers} onChange={(e) => updateConfig("gpuLayers", Number(e.target.value))} /></label>
            <label>Host<input value={config.host} onChange={(e) => updateConfig("host", e.target.value)} /></label>
            <label>Port<input type="number" value={config.port} onChange={(e) => updateConfig("port", Number(e.target.value))} /></label>
            <div className="settings-divider wide"><span>PERSONA</span><p>These instructions shape every model response.</p></div>
            <label className="wide">Persona instructions
              <textarea value={persona.prompt} rows={8} onChange={(e) => setPersona((current) => ({ ...current, prompt: e.target.value }))} />
            </label>
            <label className="wide">Identity response
              <textarea value={persona.identityResponse} rows={3} onChange={(e) => setPersona((current) => ({ ...current, identityResponse: e.target.value }))} />
            </label>
            <div className="persona-actions wide">
              <span>Used for “Who are you?” and similar questions.</span>
              <button className="ghost compact" onClick={() => setPersona(DEFAULT_PERSONA)}>Reset persona</button>
            </div>
          </div>
        </section>
      )}

      <main className="content">
        <aside className="rail">
          <button className="new-chat-button" onClick={createNewChat}><Plus size={17} /> New chat</button>

          <div className="chat-history-heading"><span>CHATS</span><small>{chats.length}</small></div>
          <div className="chat-history">
            {loadingChats ? (
              <div className="history-loading"><LoaderCircle className="spin" size={16} /> Loading chats</div>
            ) : chats.map((chat) => (
              <div className={`chat-row ${chat.id === activeChatId ? "active" : ""}`} key={chat.id}>
                {editingChatId === chat.id ? (
                  <div className="rename-wrap">
                    <input autoFocus value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitRename(chat.id);
                        if (e.key === "Escape") setEditingChatId(null);
                      }} />
                    <button aria-label="Save title" onClick={() => commitRename(chat.id)}><Check size={13} /></button>
                    <button aria-label="Cancel rename" onClick={() => setEditingChatId(null)}><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <button className="chat-select" onClick={() => openChat(chat)}>
                      <MessageSquare size={14} /><span>{chat.title}</span>
                    </button>
                    <div className="chat-actions">
                      <button aria-label="Rename chat" onClick={() => { setEditingChatId(chat.id); setEditingTitle(chat.title); }}><Pencil size={12} /></button>
                      <button aria-label="Delete chat" onClick={() => setChatPendingDelete(chat)}><Trash2 size={12} /></button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="sidebar-metrics">
            <div className="mini-metric"><Cpu size={14} /><div><span>Context</span><strong>{usedTokens.toLocaleString()} / {config.contextSize.toLocaleString()}</strong></div></div>
            <div className="progress"><span style={{ width: `${contextPercent}%` }} /></div>
            <div className="mini-metric"><Gauge size={14} /><div><span>Generation</span><strong>{tokensPerSecond.toFixed(1)} tok/s</strong></div></div>
          </div>
          <button className="clear-button" onClick={clearConversation} disabled={!messages.length}><Eraser size={15} /> Clear current chat</button>
          <div className="model-label"><span>MODEL</span><p>LFM2.5 · 2.6B · Q4_K_M</p></div>
        </aside>

        <section className="chat-panel">
          <div className="conversation-title"><span>{activeChat?.title ?? "New chat"}</span><small>Saved locally</small></div>
          <div className="messages" ref={messagesRef} onScroll={handleChatScroll}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="orb"><Bot size={32} /></div>
                <h2>{loadingChats ? "Opening your chats…" : "Ready when you are, Rohan."}</h2>
                <p>Your private personal AI assistant. Every conversation stays in a local SQLite database on your Mac.</p>
                {status === "offline" && !loadingChats && <button className="primary" onClick={startServer}><Play size={16} fill="currentColor" /> Start local model</button>}
              </div>
            ) : messages.filter((message) => message.role !== "system").map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "user" ? <UserRound size={16} /> : <Sparkles size={16} />}</div>
                <div className="message-body">
                  <span>{message.role === "user" ? "You" : "Aeris"}</span>
                  <p>{message.content}{generating && message.id === messages[messages.length - 1]?.id && <i className="cursor" />}</p>
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="composer-wrap">
            {error && <div className="error-banner">{error}</div>}
            <form className="composer" onSubmit={sendMessage}>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={status === "online" ? "Message Aeris..." : "Start the model to begin..."}
                rows={1} disabled={status !== "online" || generating || !activeChatId} />
              <button className="send-button" type="submit" disabled={!input.trim() || status !== "online" || generating || !activeChatId}>
                {generating ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </form>
            <p className="hint">Enter to send · Shift + Enter for a new line · Stored locally in SQLite</p>
          </div>
        </section>
      </main>

      {chatPendingDelete && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setChatPendingDelete(null)}>
          <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-chat-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="delete-icon"><Trash2 size={19} /></div>
            <h2 id="delete-chat-title">Delete this chat?</h2>
            <p>“{chatPendingDelete.title}” and all of its messages will be permanently removed from local memory.</p>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setChatPendingDelete(null)}>Cancel</button>
              <button className="danger-button" onClick={() => removeChat(chatPendingDelete)}><Trash2 size={14} /> Delete chat</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
