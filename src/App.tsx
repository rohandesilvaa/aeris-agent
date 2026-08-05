import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  ChevronDown,
  CircleStop,
  Cpu,
  Eraser,
  Gauge,
  LoaderCircle,
  Play,
  Send,
  Settings2,
  Sparkles,
  UserRound,
} from "lucide-react";

type Role = "user" | "assistant";
type Message = { id: string; role: Role; content: string };
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

const DEFAULT_CONFIG: ServerConfig = {
  modelPath: "/Volumes/ROHAN DISK/Local Models/LFM2.5-2.6B-Q4_K_M.gguf",
  binaryPath: "/opt/homebrew/bin/llama-server",
  contextSize: 16384,
  gpuLayers: 99,
  host: "127.0.0.1",
  port: 8080,
};

const uid = () => crypto.randomUUID();

function loadMessages(): Message[] {
  try {
    return JSON.parse(localStorage.getItem("aeris.messages") ?? "[]");
  } catch {
    return [];
  }
}

function loadConfig(): ServerConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("aeris.config") ?? "{}") };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [config, setConfig] = useState<ServerConfig>(loadConfig);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("offline");
  const [generating, setGenerating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usage, setUsage] = useState<Usage>({ prompt: 0, completion: 0 });
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const baseUrl = `http://${config.host}:${config.port}`;
  const usedTokens = usage.prompt + usage.completion;
  const contextPercent = Math.min((usedTokens / config.contextSize) * 100, 100);

  useEffect(() => {
    localStorage.setItem("aeris.messages", JSON.stringify(messages));
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    localStorage.setItem("aeris.config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1600) });
        if (active && response.ok) setStatus("online");
      } catch {
        if (active) setStatus((current) => (current === "starting" ? current : "offline"));
      }
    };
    check();
    const timer = window.setInterval(check, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [baseUrl]);

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
    abortRef.current?.abort();
    setGenerating(false);
    try {
      await invoke("stop_server");
      setStatus("offline");
    } catch (cause) {
      setError(String(cause));
    }
  }

  function clearConversation() {
    abortRef.current?.abort();
    setGenerating(false);
    setMessages([]);
    setUsage({ prompt: 0, completion: 0 });
    setTokensPerSecond(0);
    setError("");
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || generating || status !== "online") return;

    const userMessage: Message = { id: uid(), role: "user", content: text };
    const assistantMessage: Message = { id: uid(), role: "assistant", content: "" };
    const requestMessages = [...messages, userMessage].map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setError("");
    setGenerating(true);
    setTokensPerSecond(0);

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = performance.now();
    let streamedChunks = 0;

    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "local-model",
          messages: requestMessages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.7,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:") || line === "data: [DONE]") continue;
          const payload = JSON.parse(line.slice(5).trim());
          const content: string = payload.choices?.[0]?.delta?.content ?? "";
          if (content) {
            streamedChunks += 1;
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? { ...message, content: message.content + content }
                  : message,
              ),
            );
            const seconds = (performance.now() - startedAt) / 1000;
            if (seconds > 0) setTokensPerSecond(streamedChunks / seconds);
          }
          if (payload.usage) {
            const nextUsage = {
              prompt: payload.usage.prompt_tokens ?? 0,
              completion: payload.usage.completion_tokens ?? streamedChunks,
            };
            setUsage(nextUsage);
            const seconds = (performance.now() - startedAt) / 1000;
            if (seconds > 0) setTokensPerSecond(nextUsage.completion / seconds);
          }
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(String(cause));
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id && !message.content
              ? { ...message, content: "I couldn't reach the local model. Check that the server is online." }
              : message,
          ),
        );
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
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
          <div>
            <h1>Aeris</h1>
            <span>Local intelligence</span>
          </div>
        </div>

        <div className="header-actions">
          <div className={`status-pill ${status}`}>
            <span className="status-dot" />
            {status === "online" ? "Model online" : status === "starting" ? "Starting model" : "Model offline"}
          </div>
          {status === "offline" ? (
            <button className="primary compact" onClick={startServer}><Play size={15} fill="currentColor" /> Start model</button>
          ) : (
            <button className="ghost compact" onClick={stopServer}><CircleStop size={16} /> Stop</button>
          )}
          <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}>
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel">
          <div className="settings-title">
            <div><h2>Model server</h2><p>Changes apply the next time you start the model.</p></div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)}><ChevronDown size={18} /></button>
          </div>
          <div className="settings-grid">
            <label className="wide">Model path<input value={config.modelPath} onChange={(e) => updateConfig("modelPath", e.target.value)} /></label>
            <label className="wide">llama-server path<input value={config.binaryPath} onChange={(e) => updateConfig("binaryPath", e.target.value)} /></label>
            <label>Context size<input type="number" value={config.contextSize} onChange={(e) => updateConfig("contextSize", Number(e.target.value))} /></label>
            <label>GPU layers<input type="number" value={config.gpuLayers} onChange={(e) => updateConfig("gpuLayers", Number(e.target.value))} /></label>
            <label>Host<input value={config.host} onChange={(e) => updateConfig("host", e.target.value)} /></label>
            <label>Port<input type="number" value={config.port} onChange={(e) => updateConfig("port", Number(e.target.value))} /></label>
          </div>
        </section>
      )}

      <main className="content">
        <aside className="rail">
          <div className="metric-card">
            <div className="metric-heading"><Cpu size={16} /><span>Context</span></div>
            <strong>{usedTokens.toLocaleString()} <small>/ {config.contextSize.toLocaleString()}</small></strong>
            <div className="progress"><span style={{ width: `${contextPercent}%` }} /></div>
            <p>{contextPercent.toFixed(1)}% used</p>
          </div>
          <div className="metric-card">
            <div className="metric-heading"><Gauge size={16} /><span>Generation</span></div>
            <strong>{tokensPerSecond.toFixed(1)} <small>tok/s</small></strong>
            <p>{usage.completion ? `${usage.completion} tokens in last reply` : "Waiting for a response"}</p>
          </div>
          <button className="clear-button" onClick={clearConversation} disabled={!messages.length}>
            <Eraser size={16} /> Clear conversation
          </button>
          <div className="model-label"><span>MODEL</span><p>LFM2.5 · 2.6B · Q4_K_M</p></div>
        </aside>

        <section className="chat-panel">
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="orb"><Bot size={32} /></div>
                <h2>Your private AI, right here.</h2>
                <p>Everything runs locally on your Mac. Start the model, then ask anything.</p>
                {status === "offline" && <button className="primary" onClick={startServer}><Play size={16} fill="currentColor" /> Start local model</button>}
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="avatar">{message.role === "user" ? <UserRound size={16} /> : <Sparkles size={16} />}</div>
                  <div className="message-body">
                    <span>{message.role === "user" ? "You" : "Aeris"}</span>
                    <p>{message.content}{generating && message === messages[messages.length - 1] && <i className="cursor" />}</p>
                  </div>
                </article>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div className="composer-wrap">
            {error && <div className="error-banner">{error}</div>}
            <form className="composer" onSubmit={sendMessage}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={status === "online" ? "Message Aeris..." : "Start the model to begin..."}
                rows={1}
                disabled={status !== "online" || generating}
              />
              <button className="send-button" type="submit" disabled={!input.trim() || status !== "online" || generating}>
                {generating ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </form>
            <p className="hint">Enter to send · Shift + Enter for a new line · Responses stay on this device</p>
          </div>
        </section>
      </main>
    </div>
  );
}
