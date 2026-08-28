import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  Cloud,
  Cpu,
  Eraser,
  Gauge,
  Keyboard,
  LoaderCircle,
  MessageSquare,
  Mic,
  Pencil,
  Play,
  Plus,
  Send,
  Settings2,
  HardDrive,
  Sparkles,
  Square,
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
type ModelProvider = "local" | "custom";
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
type ViewMode = "text" | "voice";
type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
type VoiceConfig = {
  whisperBinaryPath: string;
  whisperModelPath: string;
  ffmpegPath: string;
  language: string;
};
type CustomModelInfo = {
  configured: boolean;
  online: boolean;
  modelId?: string;
  baseUrl?: string;
  message: string;
};
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

const VOICE_LABELS: Record<VoiceState, string> = {
  idle: "Tap the core and speak",
  listening: "Listening… tap to send",
  transcribing: "Transcribing locally…",
  thinking: "Aeris is thinking…",
  speaking: "Aeris is speaking…",
  error: "Voice needs attention",
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

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  whisperBinaryPath: "/opt/homebrew/bin/whisper-cli",
  whisperModelPath: "/Volumes/ROHAN DISK/Local Models/ggml-small.en-q5_1.bin",
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  language: "en",
};

const uid = () => crypto.randomUUID();

function loadConfig(): ServerConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("aeris.config") ?? "{}") };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function loadProvider(): ModelProvider {
  return localStorage.getItem("aeris.model-provider") === "custom" ? "custom" : "local";
}

function loadPersona(): PersonaConfig {
  try {
    return { ...DEFAULT_PERSONA, ...JSON.parse(localStorage.getItem("aeris.persona") ?? "{}") };
  } catch {
    return DEFAULT_PERSONA;
  }
}

function loadVoiceConfig(): VoiceConfig {
  try {
    const stored = { ...DEFAULT_VOICE_CONFIG, ...JSON.parse(localStorage.getItem("aeris.voice") ?? "{}") };
    if (stored.whisperModelPath.endsWith("/ggml-small.bin")) {
      stored.whisperModelPath = DEFAULT_VOICE_CONFIG.whisperModelPath;
    }
    stored.language = "en";
    return stored;
  } catch {
    return DEFAULT_VOICE_CONFIG;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read microphone audio."));
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
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

function MarkdownMessage({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {streaming && <i className="cursor" />}
    </div>
  );
}

export default function App() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<ServerConfig>(loadConfig);
  const [provider, setProvider] = useState<ModelProvider>(loadProvider);
  const [customModel, setCustomModel] = useState<CustomModelInfo | null>(null);
  const [persona, setPersona] = useState<PersonaConfig>(loadPersona);
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(loadVoiceConfig);
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const bootstrapStartedRef = useRef(false);
  const chatLoadRef = useRef(0);
  const statusRef = useRef<Status>("offline");

  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const usedTokens = usage.prompt + usage.completion;
  const contextPercent = Math.min((usedTokens / config.contextSize) * 100, 100);
  const customModelName = customModel?.modelId?.split("/").pop()?.replace(/\.gguf$/i, "") ?? "Kaggle API model";

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrapChats();
  }, []);

  useEffect(() => {
    localStorage.setItem("aeris.config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem("aeris.model-provider", provider);
  }, [provider]);

  useEffect(() => {
    localStorage.setItem("aeris.persona", JSON.stringify(persona));
  }, [persona]);

  useEffect(() => {
    localStorage.setItem("aeris.voice", JSON.stringify(voiceConfig));
  }, [voiceConfig]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => () => {
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    window.speechSynthesis?.cancel();
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: generating ? "auto" : "smooth" });
    }
  }, [messages, generating]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      if (provider === "custom") {
        try {
          const info = await invoke<CustomModelInfo>("check_custom_model");
          if (!active) return;
          setCustomModel(info);
          setStatus(info.online ? "online" : "offline");
          return;
        } catch (cause) {
          if (active) {
            setStatus("offline");
            setCustomModel({ configured: false, online: false, message: String(cause) });
          }
          return;
        }
      }
      try {
        const online = await invoke<boolean>("check_server", { config });
        if (!active) return;
        setStatus((current) => online ? "online" : current === "starting" ? current : "offline");
      } catch {
        if (active) setStatus((current) => current === "starting" ? current : "offline");
      }
    };
    setStatus("starting");
    void check();
    const timer = window.setInterval(check, provider === "custom" ? 10_000 : 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [config, provider]);

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
    cancelVoiceRecording();
    const requestId = generationRequestRef.current;
    generationRequestRef.current = null;
    setGenerating(false);
    window.speechSynthesis?.cancel();
    setVoiceState("idle");
    if (requestId) {
      try { await invoke("cancel_generation", { requestId }); } catch { /* request may already be done */ }
    }
  }

  async function startServer() {
    setError("");
    setStatus("starting");
    try {
      if (provider === "custom") {
        const info = await invoke<CustomModelInfo>("check_custom_model");
        setCustomModel(info);
        setStatus(info.online ? "online" : "offline");
        if (!info.online) setError(info.message);
        return;
      }
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

  async function sendMessage(event?: FormEvent, voiceText?: string) {
    event?.preventDefault();
    const text = (voiceText ?? input).trim();
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
    if (viewMode === "voice") setVoiceState("thinking");
    setTokensPerSecond(0);

    const channel = new Channel<StreamEvent>();
    let completeResponse = "";
    channel.onmessage = (event) => {
      if (event.requestId !== generationRequestRef.current) return;
      if (event.type === "chunk" && event.content) {
        completeResponse += event.content;
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
        if (viewMode === "voice" && completeResponse.trim()) speakResponse(completeResponse);
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
        if (viewMode === "voice") setVoiceState("error");
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
          provider,
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
        if (viewMode === "voice") setVoiceState("error");
        setMessages((current) => current.filter((message) => message.id !== assistantMessage.id || message.content));
      }
    }
  }

  async function startVoiceRecording() {
    setError("");
    setVoiceTranscript("");
    window.speechSynthesis?.cancel();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Microphone recording is not available in this WebView.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      mediaStreamRef.current = stream;
      const preferredType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onstop = () => void transcribeRecording(recorder.mimeType || preferredType || "audio/webm");
      mediaRecorderRef.current = recorder;
      recorder.start(250);
      recordingTimeoutRef.current = window.setTimeout(stopVoiceRecording, 60_000);
      setVoiceState("listening");
    } catch (cause) {
      setVoiceState("error");
      setError(`Microphone error: ${String(cause)}`);
    }
  }

  function stopVoiceRecording() {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    setVoiceState("transcribing");
  }

  function cancelVoiceRecording() {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
  }

  async function transcribeRecording(mimeType: string) {
    try {
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      const transcript = await invoke<string>("transcribe_audio", {
        audioBase64: await blobToBase64(blob),
        mimeType,
        config: voiceConfig,
      });
      if (statusRef.current !== "online") throw new Error("The local model went offline before the voice message could be sent.");
      setVoiceTranscript(transcript);
      setVoiceState("thinking");
      await sendMessage(undefined, transcript);
    } catch (cause) {
      setVoiceState("error");
      setError(String(cause));
    } finally {
      audioChunksRef.current = [];
      mediaRecorderRef.current = null;
    }
  }

  function speakResponse(text: string) {
    if (!("speechSynthesis" in window)) {
      setVoiceState("idle");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 0.92;
    utterance.onstart = () => setVoiceState("speaking");
    utterance.onend = () => setVoiceState("idle");
    utterance.onerror = () => setVoiceState("idle");
    window.speechSynthesis.speak(utterance);
  }

  function toggleVoice() {
    if (voiceState === "listening") stopVoiceRecording();
    else if (voiceState === "speaking") { window.speechSynthesis.cancel(); setVoiceState("idle"); }
    else if (!generating && voiceState !== "transcribing") void startVoiceRecording();
  }

  function openVoiceMode() {
    setViewMode("voice");
    setError("");
    void invoke("prepare_voice_server", { config: voiceConfig }).catch((cause) => {
      setVoiceState("error");
      setError(`Voice engine error: ${String(cause)}`);
    });
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
          <label className="provider-picker" aria-label="Model provider">
            {provider === "local" ? <HardDrive size={14} /> : <Cloud size={14} />}
            <select value={provider} onChange={(event) => setProvider(event.target.value as ModelProvider)}>
              <option value="local">Local Model</option>
              <option value="custom">Custom Model</option>
            </select>
          </label>
          <div className={`status-pill ${status}`}><span className="status-dot" />
            {status === "online" ? `${provider === "custom" ? "Custom" : "Local"} online` : status === "starting" ? "Checking model" : "Model offline"}
          </div>
          {status === "offline" && (
            <button className="primary compact" onClick={startServer}><Play size={15} fill="currentColor" /> {provider === "custom" ? "Retry" : "Start model"}</button>
          )}
          {status === "online" && provider === "local" && (
            <button className="ghost compact" onClick={stopServer}><CircleStop size={16} /> Stop</button>
          )}
          <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={18} /></button>
        </div>
      </header>

      {settingsOpen && (
        <section className="settings-panel">
          <div className="settings-title">
            <div><h2>Aeris settings</h2><p>Model credentials and requests stay behind the Rust backend.</p></div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)}><ChevronDown size={18} /></button>
          </div>
          <div className="settings-grid">
            <div className="settings-divider wide"><span>MODEL PROVIDER</span><p>Choose the on-device LFM or your Kaggle-hosted API.</p></div>
            <div className="provider-cards wide">
              <button className={provider === "local" ? "active" : ""} onClick={() => setProvider("local")}><HardDrive size={17} /><span><strong>Local Model</strong><small>Private · runs on this Mac</small></span></button>
              <button className={provider === "custom" ? "active" : ""} onClick={() => setProvider("custom")}><Cloud size={17} /><span><strong>Custom Model</strong><small>Kaggle API · configured via .env</small></span></button>
            </div>
            {provider === "local" ? <>
              <div className="settings-divider wide"><span>LOCAL MODEL SETTINGS</span><p>llama-server runs only on this Mac.</p></div>
              <label className="wide">Model path<input value={config.modelPath} onChange={(e) => updateConfig("modelPath", e.target.value)} /></label>
              <label className="wide">llama-server path<input value={config.binaryPath} onChange={(e) => updateConfig("binaryPath", e.target.value)} /></label>
              <label>Context size<input type="number" value={config.contextSize} onChange={(e) => updateConfig("contextSize", Number(e.target.value))} /></label>
              <label>GPU layers<input type="number" value={config.gpuLayers} onChange={(e) => updateConfig("gpuLayers", Number(e.target.value))} /></label>
              <label>Host<input value={config.host} onChange={(e) => updateConfig("host", e.target.value)} /></label>
              <label>Port<input type="number" value={config.port} onChange={(e) => updateConfig("port", Number(e.target.value))} /></label>
            </> : <>
              <div className="settings-divider wide"><span>CUSTOM MODEL SETTINGS</span><p>Kaggle API credentials load securely from .env.</p></div>
              <div className={`custom-model-summary wide ${customModel?.online ? "online" : "offline"}`}>
                <span>{customModel?.online ? "Connected" : customModel?.configured ? "Unavailable" : "Not configured"}</span>
                <strong>{customModelName}</strong>
                <small>{customModel?.message ?? "Add BASE URL and API KEY to .env"}</small>
              </div>
              <label className="wide">API base URL<input value={customModel?.baseUrl ?? "Read from .env"} readOnly /></label>
              <label className="wide">Detected model<input value={customModel?.modelId ?? "Waiting for /v1/models"} readOnly /></label>
              <div className="custom-model-actions wide">
                <span>The API key is never shown or stored in the webview.</span>
                <button className="ghost compact" onClick={startServer}>Refresh connection</button>
              </div>
            </>}
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
            <div className="settings-divider wide"><span>LOCAL VOICE</span><p>English Whisper stays loaded locally on port 8092 for faster replies.</p></div>
            <label className="wide">whisper-cli path<input value={voiceConfig.whisperBinaryPath} onChange={(e) => setVoiceConfig((current) => ({ ...current, whisperBinaryPath: e.target.value }))} /></label>
            <label className="wide">Whisper model path<input value={voiceConfig.whisperModelPath} onChange={(e) => setVoiceConfig((current) => ({ ...current, whisperModelPath: e.target.value }))} /></label>
            <label className="wide">ffmpeg path<input value={voiceConfig.ffmpegPath} onChange={(e) => setVoiceConfig((current) => ({ ...current, ffmpegPath: e.target.value }))} /></label>
            <label>Speech language<input value={voiceConfig.language} readOnly /></label>
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
          <div className="model-label"><span>MODEL</span><p>{provider === "custom" ? customModelName : "LFM2.5 · 2.6B · Q4_K_M"}</p></div>
        </aside>

        <section className="chat-panel">
          <div className="conversation-title">
            <div className="conversation-meta"><span>{activeChat?.title ?? "New chat"}</span><small>SQLite · Saved locally</small></div>
            <div className="mode-tabs" role="tablist" aria-label="Conversation mode">
              <button className={viewMode === "text" ? "active" : ""} disabled={voiceState === "listening" || voiceState === "transcribing"}
                onClick={() => { setViewMode("text"); window.speechSynthesis?.cancel(); setVoiceState("idle"); }}><Keyboard size={13} /> Text</button>
              <button className={viewMode === "voice" ? "active" : ""} onClick={openVoiceMode}><Mic size={13} /> Voice</button>
            </div>
          </div>
          {viewMode === "text" ? <div className="messages" ref={messagesRef} onScroll={handleChatScroll}>
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="orb"><Bot size={32} /></div>
                <h2>{loadingChats ? "Opening your chats…" : "Ready when you are, Rohan."}</h2>
                <p>Your private personal AI assistant. Every conversation stays in a local SQLite database on your Mac.</p>
                {status === "offline" && !loadingChats && <button className="primary" onClick={startServer}><Play size={16} fill="currentColor" /> {provider === "custom" ? "Retry Custom Model" : "Start local model"}</button>}
              </div>
            ) : messages.filter((message) => message.role !== "system").map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "user" ? <UserRound size={16} /> : <Sparkles size={16} />}</div>
                <div className="message-body">
                  <span>{message.role === "user" ? "You" : "Aeris"}</span>
                  {message.role === "assistant" ? (
                    <MarkdownMessage content={message.content} streaming={generating && message.id === messages[messages.length - 1]?.id} />
                  ) : <p>{message.content}</p>}
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div> : <div className={`voice-stage ${voiceState}`}>
            <div className="voice-ambient one" /><div className="voice-ambient two" />
            <button className="voice-core-button" onClick={toggleVoice}
              disabled={status !== "online" || voiceState === "transcribing" || voiceState === "thinking"}
              aria-label={voiceState === "listening" ? "Stop recording" : "Start voice input"}>
              <span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit orbit-three" />
              <span className="core-glow"><span className="core-center">{voiceState === "listening" ? <Square size={18} fill="currentColor" /> : <Mic size={23} />}</span></span>
            </button>
            <div className="voice-wave" aria-hidden="true">
              {Array.from({ length: 28 }, (_, index) => <i key={index} style={{ animationDelay: `${index * -0.055}s` }} />)}
            </div>
            <h2>{VOICE_LABELS[voiceState]}</h2>
            <p className="voice-transcript">{voiceTranscript || "Your voice is recorded only after you tap. Transcription stays local."}</p>
            {messages.filter((message) => message.role === "assistant").slice(-1)[0]?.content && voiceState !== "listening" && (
              <div className="voice-response"><MarkdownMessage content={messages.filter((message) => message.role === "assistant").slice(-1)[0].content} /></div>
            )}
            {error && <div className="error-banner voice-error">{error}</div>}
            {status === "offline" && <button className="primary voice-start" onClick={startServer}><Play size={15} fill="currentColor" /> {provider === "custom" ? "Retry Custom Model" : "Start local model"}</button>}
          </div>}

          {viewMode === "text" && <div className="composer-wrap">
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
          </div>}
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
