import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  BookOpen,
  CalendarClock,
  Check,
  FolderOpen,
  Hash,
  History,
  Keyboard,
  LoaderCircle,
  Mic,
  PanelRight,
  Plug,
  Pencil,
  Plus,
  Settings2,
  Square,
  Trash2,
  Users,
  Volume2,
  X,
} from "lucide-react";
import Avatar from "./components/Avatar";
import BotEditor from "./components/BotEditor";
import HoloFace, { FaceState } from "./components/HoloFace";
import Logo from "./components/Logo";
import PluginsDialog from "./components/PluginsDialog";
import RoutinesDialog from "./components/RoutinesDialog";
import SkillsDialog from "./components/SkillsDialog";
import SettingsDrawer, { CLAUDE_MODELS } from "./components/SettingsDrawer";
import TeamWork from "./components/TeamWork";
import { AGENTS, AgentStep, ReplyState, StoredAgentStep, agentName, groupActions, groupHandoffs, groupSteps, teamActivity } from "./agents";
import { blobToBase64, pickVoice, speechChunks } from "./lib/speech";
import { AERIS_BOT, AERIS_ID, EMPTY_DRAFT, botTone, clockTime, memoryLines, relativeTime } from "./team";
import type {
  Approval, Bot, BotDraft, Handoff, SkillDraft, ChatSummary, ClaudeCodeInfo, ClaudeConfig, Message, Status, StreamEvent, SystemVoice, ViewMode, VoiceConfig, VoiceState,
} from "./types";

const STARTERS = [
  "Who should I add to my team for teaching ICT?",
  "Plan my week around three priorities",
  "What do you remember about me?",
];

const VOICE_LABELS: Record<VoiceState, string> = {
  idle: "Tap the face and speak",
  listening: "Listening. Tap to send",
  transcribing: "Transcribing on this Mac",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Voice needs attention",
};

const DEFAULT_CLAUDE: ClaudeConfig = { binaryPath: "", model: "" };
const DEFAULT_VOICE: VoiceConfig = {
  whisperBinaryPath: "/opt/homebrew/bin/whisper-cli",
  whisperModelPath: "/Volumes/ROHAN DISK/Local Models/ggml-small.en-q5_1.bin",
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  language: "en",
};

const uid = () => crypto.randomUUID();

function stored<T extends object>(key: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return fallback;
  }
}

function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {streaming && <i className="cursor" />}
    </div>
  );
}

type ApprovalCardProps = { approval: Approval; name: string; onAnswer: (approvalId: string, allow: boolean) => void };

/** A file write or command waiting for a yes or no. */
function ApprovalCard({ approval, name, onAnswer }: ApprovalCardProps) {
  const wants = approval.summary.charAt(0).toLowerCase() + approval.summary.slice(1);
  return (
    <div className="approval" role="group" aria-label={`${name} is asking for approval`}>
      <p>{name} wants to {wants}</p>
      {approval.detail && <pre>{approval.detail}</pre>}
      <div>
        <button className="primary compact" onClick={() => onAnswer(approval.id, true)}>Allow</button>
        <button className="ghost compact" onClick={() => onAnswer(approval.id, false)}>Don't allow</button>
      </div>
    </div>
  );
}

export default function App() {
  // Team and threads
  const [bots, setBots] = useState<Bot[]>([AERIS_BOT]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeBotId, setActiveBotId] = useState(() => localStorage.getItem("aeris.active-bot") ?? AERIS_ID);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  // Reply in progress
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [teamMode, setTeamMode] = useState(() => localStorage.getItem("aeris.team-mode") === "on");
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentStep[]>>({});
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [replyState, setReplyState] = useState<ReplyState>("idle");
  const [actions, setActions] = useState<Record<string, string[]>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [handoffs, setHandoffs] = useState<Record<string, Handoff[]>>({});
  const [groupDraft, setGroupDraft] = useState<{ title: string; members: string[] } | null>(null);
  const [groupError, setGroupError] = useState("");
  // `draft` is a skill proposed from a thread, waiting to be reviewed.
  const [skillsOpen, setSkillsOpen] = useState<{ draft: SkillDraft | null } | null>(null);
  const [draftingSkill, setDraftingSkill] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  // Threads a routine wrote to while they were not on screen.
  const [unread, setUnread] = useState<string[]>([]);
  const activeChatRef = useRef<string | null>(null);
  const [usage, setUsage] = useState({ prompt: 0, completion: 0 });
  const [tokensPerSecond, setTokensPerSecond] = useState(0);
  const [error, setError] = useState("");
  // Claude Code
  const [status, setStatus] = useState<Status>("starting");
  const [claude, setClaude] = useState<ClaudeConfig>(() => stored("aeris.claude", DEFAULT_CLAUDE));
  const [claudeInfo, setClaudeInfo] = useState<ClaudeCodeInfo | null>(null);
  const [instructions, setInstructions] = useState(() => localStorage.getItem("aeris.instructions") ?? "");
  const [defaultInstructions, setDefaultInstructions] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem("aeris.workspace") ?? "");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  // Voice
  const [viewMode, setViewMode] = useState<ViewMode>("text");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig>(() => ({ ...stored("aeris.voice", DEFAULT_VOICE), language: "en" }));
  const [voices, setVoices] = useState<SystemVoice[]>([]);
  const [speechVoice, setSpeechVoice] = useState(() => localStorage.getItem("aeris.speech-voice") ?? "");
  const [readAloud, setReadAloud] = useState(() => localStorage.getItem("aeris.read-aloud") === "on");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // Panels and dialogs
  const [profileOpen, setProfileOpen] = useState(() => localStorage.getItem("aeris.profile") !== "closed");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [botDraft, setBotDraft] = useState<BotDraft | null>(null);
  const [botError, setBotError] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [threadToDelete, setThreadToDelete] = useState<ChatSummary | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const generationRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimeoutRef = useRef<number | null>(null);
  const bootstrappedRef = useRef(false);
  const chatLoadRef = useRef(0);
  const statusRef = useRef<Status>("starting");
  const speechRunRef = useRef(0);

  const activeBot = bots.find((bot) => bot.id === activeBotId) ?? AERIS_BOT;
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const threads = chats.filter((chat) => chat.botId === activeBot.id);
  const groups = chats.filter((chat) => chat.members.length > 0);
  // A group thread is open when the active thread has members.
  const group = activeChat?.members.length ? activeChat : null;
  const groupMembers = group ? group.members.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot)) : [];
  const lead = groupMembers[0] ?? activeBot;
  const tone = botTone(activeBot.id);
  const lastReply = [...messages].reverse().find((message) => message.role === "assistant");
  const replyStreaming = generating && Boolean(lastReply?.content);
  const faceState: FaceState = status === "offline" ? "offline"
    : voiceState === "listening" ? "listening"
    : voiceState === "speaking" || replyStreaming ? "speaking"
    : generating || voiceState === "transcribing" || voiceState === "thinking" ? "thinking"
    : "idle";
  const activity = generating ? teamActivity(liveRunId ? agentRuns[liveRunId] : undefined, replyState, activeBot.name) : null;
  const asking = generating ? Object.values(handoffs).flat().find((handoff) => handoff.status === "working") : undefined;
  const presence = status === "offline" ? "Offline"
    : status === "starting" ? "Connecting"
    : approvals.length > 0 ? "Needs your approval"
    : asking ? `Asking ${bots.find((bot) => bot.id === asking.botId)?.name ?? "a teammate"}`
    : activity ?? (faceState === "listening" ? "Listening" : faceState === "speaking" ? "Replying" : faceState === "thinking" ? "Thinking" : "Ready");
  const modelName = CLAUDE_MODELS.find((model) => model.value === claude.model)?.label ?? claude.model;
  const remembered = memoryLines(activeBot.memory);
  const ready = status === "online";

  // ---- Persistence of small preferences ----
  useEffect(() => { localStorage.setItem("aeris.claude", JSON.stringify(claude)); }, [claude]);
  useEffect(() => { localStorage.setItem("aeris.instructions", instructions); }, [instructions]);
  useEffect(() => { localStorage.setItem("aeris.voice", JSON.stringify(voiceConfig)); }, [voiceConfig]);
  useEffect(() => { localStorage.setItem("aeris.team-mode", teamMode ? "on" : "off"); }, [teamMode]);
  useEffect(() => { localStorage.setItem("aeris.active-bot", activeBotId); }, [activeBotId]);
  useEffect(() => { localStorage.setItem("aeris.profile", profileOpen ? "open" : "closed"); }, [profileOpen]);
  useEffect(() => {
    localStorage.setItem("aeris.speech-voice", speechVoice);
    localStorage.setItem("aeris.read-aloud", readAloud ? "on" : "off");
  }, [speechVoice, readAloud]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { activeChatRef.current = activeChatId; }, [activeChatId]);

  // Routines run in the backend with nobody at the keyboard, so it needs
  // these settings itself.
  useEffect(() => {
    void invoke("sync_settings", {
      settings: { claudeBinaryPath: claude.binaryPath, claudeModel: claude.model, personaPrompt: instructions, workspaceDir },
    }).catch(() => {});
  }, [claude, instructions, workspaceDir]);

  // When a routine finishes, show its thread as new, or refresh it if open.
  useEffect(() => {
    const stop = listen<{ chatId: string | null }>("routine-finished", async ({ payload }) => {
      try {
        setChats(await invoke<ChatSummary[]>("list_chats"));
        void refreshBots();
        if (!payload.chatId) return;
        if (payload.chatId === activeChatRef.current) {
          setMessages(await invoke<Message[]>("get_chat_messages", { chatId: payload.chatId }));
        } else {
          setUnread((current) => current.includes(payload.chatId!) ? current : [...current, payload.chatId!]);
        }
      } catch { /* the next refresh will catch up */ }
    }).catch(() => () => {});
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);

  // Resolve the workspace folder (and create it) whenever the setting changes.
  useEffect(() => {
    localStorage.setItem("aeris.workspace", workspaceDir);
    let active = true;
    invoke<string>("workspace_path", { configured: workspaceDir })
      .then((path) => { if (active) { setWorkspacePath(path); setWorkspaceError(""); } })
      .catch((cause) => { if (active) setWorkspaceError(String(cause)); });
    return () => { active = false; };
  }, [workspaceDir]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void bootstrap();
    void invoke<string>("default_persona").then(setDefaultInstructions).catch(() => {});
  }, []);

  // Voices come from macOS itself, so ones downloaded in System Settings are
  // included. Reloaded whenever Settings opens, to pick up new downloads.
  useEffect(() => {
    void invoke<SystemVoice[]>("list_voices")
      .then((installed) => setVoices(installed.filter((voice) => voice.locale.startsWith("en"))))
      .catch(() => setVoices([]));
  }, [settingsOpen]);

  useEffect(() => () => {
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    void invoke("stop_speaking").catch(() => {});
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) bottomRef.current?.scrollIntoView({ behavior: generating ? "auto" : "smooth" });
  }, [messages, generating, agentRuns]);

  // Claude Code is the only model; keep an eye on whether it is signed in.
  useEffect(() => {
    let active = true;
    const check = async () => {
      const info = await readClaudeStatus();
      if (active) applyClaudeStatus(info);
    };
    setStatus("starting");
    void check();
    const timer = window.setInterval(check, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [claude.binaryPath]);

  async function readClaudeStatus(): Promise<ClaudeCodeInfo> {
    try {
      return await invoke<ClaudeCodeInfo>("check_claude_code", { binaryPath: claude.binaryPath });
    } catch (cause) {
      return { installed: false, loggedIn: false, message: String(cause) };
    }
  }

  function applyClaudeStatus(info: ClaudeCodeInfo) {
    setClaudeInfo(info);
    setStatus(info.installed && info.loggedIn ? "online" : "offline");
  }

  async function checkClaude() {
    setStatus("starting");
    applyClaudeStatus(await readClaudeStatus());
  }

  // ---- Team and threads ----
  async function bootstrap() {
    setLoading(true);
    try {
      const storedBots = await invoke<Bot[]>("list_bots");
      let storedChats = await invoke<ChatSummary[]>("list_chats");
      const botId = storedBots.some((bot) => bot.id === activeBotId) ? activeBotId : AERIS_ID;
      let first = storedChats.find((chat) => chat.botId === botId);
      if (!first) {
        first = await invoke<ChatSummary>("create_chat", { title: null, botId });
        storedChats = [first, ...storedChats];
      }
      setBots(storedBots);
      setChats(storedChats);
      setActiveBotId(botId);
      await openThread(first);
    } catch (cause) {
      setError(`Could not open your team: ${String(cause)}`);
    } finally {
      setLoading(false);
    }
  }

  async function refreshBots() {
    try {
      setBots(await invoke<Bot[]>("list_bots"));
    } catch { /* the list on screen stays as it is */ }
  }

  async function openThread(chat: ChatSummary) {
    const loadId = ++chatLoadRef.current;
    await cancelReply();
    setActiveChatId(chat.id);
    setUnread((current) => current.filter((id) => id !== chat.id));
    setThreadsOpen(false);
    setInput("");
    setError("");
    setUsage({ prompt: chat.promptTokens, completion: chat.completionTokens });
    setTokensPerSecond(0);
    autoScrollRef.current = true;
    try {
      const storedMessages = await invoke<Message[]>("get_chat_messages", { chatId: chat.id });
      const storedSteps = await invoke<StoredAgentStep[]>("get_agent_steps", { chatId: chat.id }).catch(() => []);
      if (chatLoadRef.current !== loadId) return;
      setMessages(storedMessages);
      setAgentRuns(groupSteps(storedSteps));
      setActions(groupActions(storedSteps));
      setHandoffs(groupHandoffs(storedSteps));
      setApprovals([]);
      setLiveRunId(null);
      setReplyState("idle");
    } catch (cause) {
      if (chatLoadRef.current !== loadId) return;
      setMessages([]);
      setError(String(cause));
    }
  }

  async function selectBot(botId: string, knownChats: ChatSummary[] = chats) {
    setActiveBotId(botId);
    try {
      let chat = knownChats.find((item) => item.botId === botId);
      if (!chat) {
        chat = await invoke<ChatSummary>("create_chat", { title: null, botId });
        setChats([chat, ...knownChats]);
      }
      await openThread(chat);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function createGroup() {
    if (!groupDraft) return;
    try {
      const chat = await invoke<ChatSummary>("create_group", { title: groupDraft.title, members: groupDraft.members });
      setChats((current) => [chat, ...current]);
      setGroupDraft(null);
      setViewMode("text");
      await openThread(chat);
    } catch (cause) {
      setGroupError(String(cause));
    }
  }

  // Asks Claude to write up this thread's process as a skill to review.
  async function saveAsSkill() {
    if (!activeChatId || draftingSkill) return;
    setDraftingSkill(true);
    setError("");
    try {
      setSkillsOpen({ draft: await invoke<SkillDraft>("draft_skill", { chatId: activeChatId }) });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDraftingSkill(false);
    }
  }

  async function openRoutineThread(chatId: string) {
    setRoutinesOpen(false);
    try {
      const fresh = await invoke<ChatSummary[]>("list_chats");
      setChats(fresh);
      const chat = fresh.find((item) => item.id === chatId);
      if (!chat) return;
      setViewMode("text");
      if (!chat.members.length) setActiveBotId(chat.botId);
      await openThread(chat);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function newThread() {
    try {
      const chat = await invoke<ChatSummary>("create_chat", { title: null, botId: activeBot.id });
      setChats((current) => [chat, ...current]);
      await openThread(chat);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function commitRename(chatId: string) {
    const title = renameText.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await invoke("rename_chat", { chatId, title });
      setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, title } : chat));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function deleteThread(chat: ChatSummary) {
    setThreadToDelete(null);
    try {
      await invoke("delete_chat", { chatId: chat.id });
      const remaining = chats.filter((item) => item.id !== chat.id);
      setChats(remaining);
      if (chat.id === activeChatId) await selectBot(chat.members.length ? activeBotId : chat.botId, remaining);
    } catch (cause) {
      setError(String(cause));
    }
  }

  // Opens the editor with the stored teammate, so the memory shown is current.
  async function editBot(botId: string) {
    setBotError("");
    try {
      const fresh = await invoke<Bot[]>("list_bots");
      setBots(fresh);
      const bot = fresh.find((item) => item.id === botId);
      if (bot) setBotDraft({ ...bot });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function saveBot() {
    if (!botDraft) return;
    const { id, ...fields } = botDraft;
    try {
      if (id) {
        const updated = await invoke<Bot>("update_bot", { botId: id, input: fields });
        setBots((current) => current.map((bot) => bot.id === id ? updated : bot));
        setBotDraft(null);
      } else {
        const created = await invoke<Bot>("create_bot", { input: fields });
        setBots((current) => [...current, created]);
        setBotDraft(null);
        await selectBot(created.id);
      }
    } catch (cause) {
      setBotError(String(cause));
    }
  }

  async function deleteBot(botId: string) {
    try {
      await invoke("delete_bot", { botId });
      const remaining = chats.filter((chat) => chat.botId !== botId);
      setBots((current) => current.filter((bot) => bot.id !== botId));
      setChats(remaining);
      setBotDraft(null);
      if (activeBotId === botId) await selectBot(AERIS_ID, remaining);
    } catch (cause) {
      setBotError(String(cause));
    }
  }

  // ---- Sending and stopping a reply ----
  function stopLiveAgents() {
    setAgentRuns((current) => Object.fromEntries(Object.entries(current).map(([id, steps]) => [
      id,
      steps.map((step) => step.status === "working" || step.status === "pending" ? { ...step, status: "stopped" as const } : step),
    ])));
    setHandoffs((current) => Object.fromEntries(Object.entries(current).map(([id, items]) => [
      id,
      items.map((item) => item.status === "working" ? { ...item, status: "error" as const } : item),
    ])));
    setReplyState("idle");
    setApprovals([]);
  }

  function answerApproval(approvalId: string, allow: boolean) {
    setApprovals((current) => current.filter((approval) => approval.id !== approvalId));
    void invoke("answer_approval", { approvalId, allow }).catch((cause) => setError(String(cause)));
  }

  function openWorkspace() {
    void invoke("open_workspace", { configured: workspaceDir }).catch((cause) => setError(String(cause)));
  }

  async function cancelReply() {
    cancelRecording();
    const requestId = generationRef.current;
    generationRef.current = null;
    setGenerating(false);
    stopSpeaking();
    if (!requestId) return;
    stopLiveAgents();
    setMessages((current) => current.filter((message) => message.role !== "assistant" || message.content));
    try { await invoke("cancel_generation", { requestId }); } catch { /* the reply may already be finished */ }
  }

  async function sendMessage(event?: FormEvent, spoken?: string) {
    event?.preventDefault();
    const text = (spoken ?? input).trim();
    if (!text || generating || !ready || !activeChatId) return;

    const chatId = activeChatId;
    const requestId = uid();
    const userMessage: Message = { id: uid(), chatId, role: "user", content: text, createdAt: Date.now() };
    const reply: Message = { id: uid(), chatId, role: "assistant", content: "", createdAt: Date.now() + 1, botId: group ? lead.id : activeBot.id };
    const withSpecialists = teamMode && !group;
    // In a group several teammates may reply; this is the one writing now.
    let writingId = reply.id;
    generationRef.current = requestId;
    autoScrollRef.current = true;
    setMessages((current) => [...current, userMessage, reply]);
    setInput("");
    setError("");
    setGenerating(true);
    setTokensPerSecond(0);
    if (viewMode === "voice") setVoiceState("thinking");
    if (withSpecialists) {
      setAgentRuns((current) => ({ ...current, [reply.id]: AGENTS.map((agent) => ({ agent: agent.id, content: "", status: "pending" as const })) }));
      setLiveRunId(reply.id);
      setReplyState("waiting");
    } else {
      setLiveRunId(null);
      setReplyState("idle");
    }
    const updateAgent = (agentId: string, change: (step: AgentStep) => AgentStep) =>
      setAgentRuns((current) => ({
        ...current,
        [reply.id]: (current[reply.id] ?? []).map((step) => step.agent === agentId ? change(step) : step),
      }));
    const fail = (message: string) => {
      generationRef.current = null;
      setGenerating(false);
      stopLiveAgents();
      setError(message);
      if (viewMode === "voice") setVoiceState("error");
      setMessages((current) => current.filter((message) => message.role !== "assistant" || message.content));
    };

    const channel = new Channel<StreamEvent>();
    let fullReply = "";
    channel.onmessage = (streamEvent) => {
      if (streamEvent.requestId !== generationRef.current) return;
      if (streamEvent.type === "agent" && streamEvent.agent) {
        const chunk = streamEvent.content ?? "";
        if (streamEvent.status === "start") updateAgent(streamEvent.agent, (step) => ({ ...step, status: "working" }));
        if (streamEvent.status === "chunk") updateAgent(streamEvent.agent, (step) => ({ ...step, content: step.content + chunk }));
        if (streamEvent.status === "done") updateAgent(streamEvent.agent, (step) => ({ ...step, status: "done" }));
        if (streamEvent.status === "error") updateAgent(streamEvent.agent, (step) => ({ ...step, status: "error", content: chunk }));
      }
      if (streamEvent.type === "message" && streamEvent.messageId) {
        const { messageId, agent: botId } = streamEvent;
        writingId = messageId;
        setMessages((current) => current.some((message) => message.id === messageId)
          ? current.map((message) => message.id === messageId ? { ...message, botId } : message)
          : [...current, { id: messageId, chatId, role: "assistant", content: "", createdAt: Date.now(), botId }]);
      }
      if (streamEvent.type === "handoff" && streamEvent.agent) {
        const { agent: botId, status: step, content = "" } = streamEvent;
        const id = writingId;
        setHandoffs((current) => {
          const items = current[id] ?? [];
          if (step === "start") return { ...current, [id]: [...items, { botId, question: content, answer: "", status: "working" }] };
          // Later events belong to the newest handoff to that teammate.
          const index = items.map((item) => item.botId).lastIndexOf(botId);
          return {
            ...current,
            [id]: items.map((item, position) => position !== index ? item
              : step === "chunk" ? { ...item, answer: item.answer + content }
              : step === "done" ? { ...item, status: "done" }
              : { ...item, status: "error", answer: content }),
          };
        });
      }
      if (streamEvent.type === "tool" && streamEvent.content) {
        const line = streamEvent.content;
        const id = writingId;
        setActions((current) => ({ ...current, [id]: [...(current[id] ?? []), line] }));
      }
      if (streamEvent.type === "approval" && streamEvent.approvalId) {
        const approval: Approval = { id: streamEvent.approvalId, tool: streamEvent.tool ?? "", summary: streamEvent.content ?? "", detail: streamEvent.message ?? "" };
        setApprovals((current) => [...current, approval]);
        // Reading stops while a teammate waits, so the question is not missed.
        if (viewMode === "voice") setVoiceState("idle");
      }
      if (streamEvent.type === "chunk" && streamEvent.content) {
        const chunk = streamEvent.content;
        if (withSpecialists) setReplyState("writing");
        fullReply += chunk;
        const id = writingId;
        setMessages((current) => current.map((message) => message.id === id ? { ...message, content: message.content + chunk } : message));
      }
      if (streamEvent.type === "usage") {
        const next = { prompt: streamEvent.promptTokens ?? 0, completion: streamEvent.completionTokens ?? 0 };
        setUsage(next);
        setTokensPerSecond(streamEvent.tokensPerSecond ?? 0);
        setChats((current) => current.map((chat) => chat.id === chatId ? { ...chat, promptTokens: next.prompt, completionTokens: next.completion } : chat));
      }
      if (streamEvent.type === "done") {
        generationRef.current = null;
        setGenerating(false);
        if (withSpecialists) setReplyState("done");
        setApprovals([]);
        if ((viewMode === "voice" || readAloud) && fullReply.trim()) speak(fullReply, reply.id);
        else if (viewMode === "voice") setVoiceState("idle");
        setChats((current) => [...current.map((chat) => chat.id === chatId ? { ...chat, title: streamEvent.title ?? chat.title, updatedAt: Date.now() } : chat)]
          .sort((a, b) => b.updatedAt - a.updatedAt));
        // Memory is revised in the background just after the reply.
        window.setTimeout(() => void refreshBots(), 8_000);
      }
      if (streamEvent.type === "error") fail(streamEvent.message ?? "The reply failed.");
    };

    try {
      await invoke("stream_chat", {
        request: {
          requestId,
          chatId,
          userMessageId: userMessage.id,
          assistantMessageId: reply.id,
          content: text,
          personaPrompt: instructions,
          claudeBinaryPath: claude.binaryPath,
          claudeModel: claude.model,
          teamMode: withSpecialists,
          workspaceDir,
        },
        onEvent: channel,
      });
    } catch (cause) {
      if (generationRef.current === requestId) fail(String(cause));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function handleScroll() {
    const container = messagesRef.current;
    if (container) autoScrollRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  // ---- Speaking replies ----
  function stopSpeaking() {
    speechRunRef.current += 1;
    void invoke("stop_speaking").catch(() => {});
    setSpeakingId(null);
    setVoiceState("idle");
  }

  function speak(text: string, messageId: string | null = null) {
    const passage = speechChunks(text).join("\n");
    if (!passage) {
      setVoiceState("idle");
      return;
    }
    const run = ++speechRunRef.current;
    setSpeakingId(messageId);
    setVoiceState("speaking");
    const finish = () => {
      if (speechRunRef.current !== run) return; // something newer is being read
      setSpeakingId(null);
      setVoiceState("idle");
    };
    invoke<boolean>("speak", { text: passage, voice: pickVoice(voices, speechVoice)?.name ?? "" })
      .then(finish)
      .catch((cause) => {
        finish();
        setError(`Could not read the reply aloud: ${String(cause)}`);
      });
  }

  // ---- Voice input ----
  async function startRecording() {
    setError("");
    setVoiceTranscript("");
    stopSpeaking();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Microphone recording is not available in this window.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      micStreamRef.current = stream;
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (dataEvent) => { if (dataEvent.data.size) audioChunksRef.current.push(dataEvent.data); };
      recorder.onstop = () => void transcribe(recorder.mimeType || mimeType || "audio/webm");
      recorderRef.current = recorder;
      recorder.start(250);
      recordingTimeoutRef.current = window.setTimeout(stopRecording, 60_000);
      setVoiceState("listening");
    } catch (cause) {
      setVoiceState("error");
      setError(`Microphone error: ${String(cause)}`);
    }
  }

  function releaseMicrophone() {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseMicrophone();
    setVoiceState("transcribing");
  }

  function cancelRecording() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    releaseMicrophone();
    recorderRef.current = null;
    audioChunksRef.current = [];
  }

  async function transcribe(mimeType: string) {
    try {
      const transcript = await invoke<string>("transcribe_audio", {
        audioBase64: await blobToBase64(new Blob(audioChunksRef.current, { type: mimeType })),
        mimeType,
        config: voiceConfig,
      });
      if (statusRef.current !== "online") throw new Error("Claude Code went offline before the message could be sent.");
      setVoiceTranscript(transcript);
      setVoiceState("thinking");
      await sendMessage(undefined, transcript);
    } catch (cause) {
      setVoiceState("error");
      setError(String(cause));
    } finally {
      audioChunksRef.current = [];
      recorderRef.current = null;
    }
  }

  function toggleVoice() {
    if (voiceState === "listening") stopRecording();
    else if (voiceState === "speaking") stopSpeaking();
    else if (!generating && voiceState !== "transcribing") void startRecording();
  }

  function openVoice() {
    setViewMode("voice");
    setError("");
    void invoke("prepare_voice_server", { config: voiceConfig }).catch((cause) => {
      setVoiceState("error");
      setError(`Voice engine error: ${String(cause)}`);
    });
  }

  const voiceBusy = !ready || voiceState === "transcribing" || voiceState === "thinking";

  return (
    <div className={`app ${profileOpen ? "with-profile" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><Logo size={26} /><span>Aeris Bot</span></div>

        <nav className="team" aria-label="Your team">
          {bots.map((bot) => {
            const latest = chats.find((chat) => chat.botId === bot.id && chat.title !== "New chat");
            const working = generating && !group && bot.id === activeBot.id;
            return (
              <div className={`mate ${bot.id === activeBot.id && !group ? "active" : ""}`} key={bot.id}>
                <button className="mate-main" onClick={() => void selectBot(bot.id)}>
                  <Avatar botId={bot.id} name={bot.name} working={working} />
                  <span className="mate-text">
                    <strong>{bot.name}</strong>
                    <small>{working ? presence : latest?.title ?? (bot.title || "Teammate")}</small>
                  </span>
                  {chats.some((chat) => chat.botId === bot.id && unread.includes(chat.id))
                    ? <i className="unread" aria-label="New reply from a routine" />
                    : latest && !working && <time>{relativeTime(latest.updatedAt)}</time>}
                </button>
                <button className="mate-edit" aria-label={`Edit ${bot.name}`} onClick={() => void editBot(bot.id)}><Pencil size={12} /></button>
              </div>
            );
          })}
          <button className="add-mate" onClick={() => { setBotError(""); setBotDraft({ ...EMPTY_DRAFT }); }}>
            <span><Plus size={15} /></span> Add a teammate
          </button>

          {bots.length > 1 && <>
            <h2 className="team-heading">Groups</h2>
            {groups.map((chat) => (
              <div className={`mate ${chat.id === activeChatId ? "active" : ""}`} key={chat.id}>
                <button className="mate-main" onClick={() => { setViewMode("text"); void openThread(chat); }}>
                  <span className="avatar group" aria-hidden="true"><Hash size={15} /></span>
                  <span className="mate-text">
                    <strong>{chat.title}</strong>
                    <small>{chat.members.map((id) => bots.find((bot) => bot.id === id)?.name).filter(Boolean).join(", ")}</small>
                  </span>
                </button>
              </div>
            ))}
            <button className="add-mate" onClick={() => { setGroupError(""); setGroupDraft({ title: "", members: [] }); }}>
              <span><Plus size={15} /></span> New group
            </button>
          </>}
        </nav>

        <div className="sidebar-tools">
          <button onClick={() => setSkillsOpen({ draft: null })}><BookOpen size={15} /> Skills</button>
          <button onClick={() => setRoutinesOpen(true)}><CalendarClock size={15} /> Routines</button>
          <button onClick={() => setPluginsOpen(true)}><Plug size={15} /> Plugins</button>
        </div>
        <div className="sidebar-foot">
          <button className={`claude-state ${status}`} onClick={() => setSettingsOpen(true)}>
            <i />
            {status === "online" ? "Claude Code ready" : status === "starting" ? "Checking Claude Code" : claudeInfo?.installed ? "Claude Code signed out" : "Claude Code not found"}
          </button>
          <button className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button>
        </div>
      </aside>

      <section className="conversation">
        <header className="conv-head">
          {group
            ? <span className="avatar group large" aria-hidden="true"><Hash size={18} /></span>
            : <Avatar botId={activeBot.id} name={activeBot.name} size={38} working={generating} />}
          <div className="conv-title">
            <h1>{group ? group.title : activeBot.name}</h1>
            <p><span>{group ? groupMembers.map((bot) => bot.name).join(", ") : activeBot.title || "Teammate"}</span><span className={`presence ${faceState}`}>{presence}</span></p>
          </div>
          <div className="conv-actions">
            {group && <button className="ghost compact" onClick={() => setThreadToDelete(group)}><Trash2 size={13} /> Delete group</button>}
            {!group && <div className="threads">
              <button className="ghost compact" aria-expanded={threadsOpen} onClick={() => setThreadsOpen((open) => !open)}>
                <History size={14} /> Threads <small>{threads.length}</small>
              </button>
              {threadsOpen && <>
                <div className="pop-shield" onMouseDown={() => setThreadsOpen(false)} />
                <div className="pop" role="dialog" aria-label={`Threads with ${activeBot.name}`}>
                  <button className="pop-new" onClick={() => void newThread()}><Plus size={14} /> New thread</button>
                  <div className="pop-list">
                    {threads.map((chat) => (
                      <div className={`thread ${chat.id === activeChatId ? "active" : ""}`} key={chat.id}>
                        {renamingId === chat.id ? (
                          <div className="thread-rename">
                            <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitRename(chat.id);
                                if (e.key === "Escape") setRenamingId(null);
                              }} />
                            <button aria-label="Save name" onClick={() => void commitRename(chat.id)}><Check size={13} /></button>
                            <button aria-label="Cancel" onClick={() => setRenamingId(null)}><X size={13} /></button>
                          </div>
                        ) : <>
                          <button className="thread-open" onClick={() => void openThread(chat)}>
                            <span>{chat.title}</span>{unread.includes(chat.id) ? <i className="unread" aria-label="New reply" /> : <time>{relativeTime(chat.updatedAt)}</time>}
                          </button>
                          <button className="thread-tool" aria-label="Rename thread" onClick={() => { setRenamingId(chat.id); setRenameText(chat.title); }}><Pencil size={12} /></button>
                          <button className="thread-tool" aria-label="Delete thread" onClick={() => { setThreadsOpen(false); setThreadToDelete(chat); }}><Trash2 size={12} /></button>
                        </>}
                      </div>
                    ))}
                  </div>
                </div>
              </>}
            </div>}
            {!group && <div className="segmented" role="tablist" aria-label="How to talk">
              <button role="tab" aria-selected={viewMode === "text"} className={viewMode === "text" ? "active" : ""}
                disabled={voiceState === "listening" || voiceState === "transcribing"}
                onClick={() => { setViewMode("text"); stopSpeaking(); }}><Keyboard size={13} /> Chat</button>
              <button role="tab" aria-selected={viewMode === "voice"} className={viewMode === "voice" ? "active" : ""} onClick={openVoice}><Mic size={13} /> Voice</button>
            </div>}
            <button className={`icon-button ${profileOpen ? "on" : ""}`} aria-label={profileOpen ? "Hide profile" : "Show profile"} aria-pressed={profileOpen} onClick={() => setProfileOpen((open) => !open)}><PanelRight size={17} /></button>
          </div>
        </header>

        {status === "offline" && (
          <div className="offline-banner">
            <p>{claudeInfo?.installed
              ? <>Claude Code is signed out. Open Terminal, run <code>claude auth login</code>, then check again.</>
              : claudeInfo?.message ?? "Claude Code was not found on this Mac."}</p>
            <button className="primary compact" onClick={() => void checkClaude()}>Check again</button>
          </div>
        )}

        {viewMode === "text" ? (
          <div className="messages" ref={messagesRef} onScroll={handleScroll}>
            {messages.length === 0 ? (
              <div className="empty">
                {group ? <span className="avatar group huge" aria-hidden="true"><Hash size={24} /></span> : <Avatar botId={activeBot.id} name={activeBot.name} size={56} />}
                <h2>{loading ? "Opening your team…" : group ? `${group.title} is ready.` : `${activeBot.name} is ready.`}</h2>
                <p>{group
                  ? `${lead.name} answers by default. Write @ and a name, such as @${(groupMembers[1] ?? lead).name}, to choose who answers.`
                  : activeBot.description || `${activeBot.name} is waiting for work.`}</p>
                {!group && activeBot.id === AERIS_ID && ready && (
                  <div className="starters">{STARTERS.map((starter) => <button key={starter} onClick={() => setInput(starter)}>{starter}</button>)}</div>
                )}
              </div>
            ) : messages.filter((message) => message.role !== "system").map((message) => {
              if (message.role === "user") {
                return <article className="msg mine" key={message.id}><p>{message.content}</p><time>{clockTime(message.createdAt)}</time></article>;
              }
              const live = generating && message.id === messages[messages.length - 1]?.id;
              const liveSteps = live && liveRunId === message.id ? agentRuns[message.id] : undefined;
              const notes = agentRuns[message.id]?.filter((step) => step.content && step.status !== "error");
              const done = actions[message.id];
              const helped = handoffs[message.id];
              const author = bots.find((bot) => bot.id === message.botId) ?? (group ? lead : activeBot);
              return (
                <article className="msg" key={message.id}>
                  <Avatar botId={author.id} name={author.name} size={30} working={live} />
                  <div className="msg-body">
                    <header><strong>{author.name}</strong><time>{clockTime(message.createdAt)}</time></header>
                    {liveSteps && <TeamWork steps={liveSteps} reply={replyState} leadName={author.name} />}
                    {helped?.map((handoff, index) => {
                      const helper = bots.find((bot) => bot.id === handoff.botId);
                      return (
                        <details className={`handoff ${handoff.status}`} key={index} open={handoff.status === "working"}>
                          <summary>
                            <Avatar botId={handoff.botId} name={helper?.name ?? "?"} size={22} working={handoff.status === "working"} />
                            <span>{handoff.status === "working" ? `Asking ${helper?.name ?? "a teammate"}` : handoff.status === "error" ? `${helper?.name ?? "A teammate"} could not help` : `Asked ${helper?.name ?? "a teammate"}`}</span>
                          </summary>
                          <p className="handoff-question">{handoff.question}</p>
                          {handoff.answer && <Markdown content={handoff.answer} />}
                        </details>
                      );
                    })}
                    {done && done.length > 0 && <ul className="actions">{done.map((line, index) => <li key={index}>{line}</li>)}</ul>}
                    {live && approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} name={author.name} onAnswer={answerApproval} />)}
                    {message.content
                      ? <Markdown content={message.content} streaming={live && approvals.length === 0} />
                      : !liveSteps && approvals.length === 0 && <p className="waiting">{done?.length ? "Working" : "Thinking"}<i className="cursor" /></p>}
                    {message.content && !live && (
                      <div className="msg-tools">
                        <button onClick={() => speakingId === message.id ? stopSpeaking() : speak(message.content, message.id)}>
                          {speakingId === message.id ? <><Square size={11} fill="currentColor" /> Stop reading</> : <><Volume2 size={14} /> Listen</>}
                        </button>
                        {message.id === lastReply?.id && (
                          <button onClick={() => void saveAsSkill()} disabled={draftingSkill}>
                            {draftingSkill ? <><LoaderCircle className="spin" size={13} /> Writing the skill</> : <><BookOpen size={13} /> Save as skill</>}
                          </button>
                        )}
                      </div>
                    )}
                    {notes && notes.length > 0 && !live && (
                      <details className="notes">
                        <summary><Users size={13} /> Worked with {notes.map((step) => agentName(step.agent)).join(", ")}</summary>
                        {notes.map((step) => <section key={step.agent}><h4>{agentName(step.agent)}</h4><Markdown content={step.content} /></section>)}
                      </details>
                    )}
                  </div>
                </article>
              );
            })}
            <div ref={bottomRef} />
          </div>
        ) : (
          <div className={`voice ${voiceState}`}>
            <button className="face-button" onClick={toggleVoice} disabled={voiceBusy} aria-label={voiceState === "listening" ? "Stop recording" : "Start speaking"}>
              <HoloFace state={faceState} tone={tone} label={activeBot.name} />
            </button>
            <h2>{activity ?? VOICE_LABELS[voiceState]}</h2>
            <p className="voice-hint">{voiceTranscript || "Recording starts when you tap, and your speech is transcribed on this Mac."}</p>
            <button className={`mic ${voiceState === "listening" ? "recording" : ""}`} onClick={toggleVoice} disabled={voiceBusy}>
              {voiceState === "listening" ? <><Square size={14} fill="currentColor" /> Send</> : <><Mic size={15} /> Speak</>}
            </button>
            {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} name={activeBot.name} onAnswer={answerApproval} />)}
            {lastReply?.content && voiceState !== "listening" && <div className="voice-reply"><Markdown content={lastReply.content} /></div>}
            {error && <div className="error-banner">{error}</div>}
          </div>
        )}

        {viewMode === "text" && (
          <div className="composer-wrap">
            {error && <div className="error-banner">{error}</div>}
            <form className="composer" onSubmit={sendMessage}>
              <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} rows={1}
                placeholder={!ready ? "Claude Code needs to be ready first" : group ? `Message ${group.title}` : `Message ${activeBot.name}`}
                disabled={!ready || generating || !activeChatId} />
              <div className="composer-bar">
                {!group && <button type="button" className={`toggle ${teamMode ? "on" : ""}`} aria-pressed={teamMode} disabled={generating}
                  onClick={() => setTeamMode((on) => !on)}><Users size={13} /> Specialists</button>}
                <span className="hint">{group ? `${lead.name} answers unless you @mention someone` : teamMode ? "Atlas, Vega, Nova and Argus work on it first, so the reply takes longer" : "Enter sends, Shift + Enter adds a line"}</span>
                {generating
                  ? <button className="send stop" type="button" aria-label="Stop" onClick={() => void cancelReply()}><Square size={13} fill="currentColor" /></button>
                  : <button className="send" type="submit" aria-label="Send" disabled={!input.trim() || !ready || !activeChatId}><ArrowUp size={17} /></button>}
              </div>
            </form>
          </div>
        )}
      </section>

      {profileOpen && group && (
        <aside className="profile">
          <span className="avatar group huge" aria-hidden="true"><Hash size={24} /></span>
          <h2 className="group-name">{group.title}</h2>
          <p className={`presence ${faceState}`}>{presence}</p>
          <section>
            <h3>Teammates</h3>
            <ul className="members">
              {groupMembers.map((bot, index) => (
                <li key={bot.id}>
                  <Avatar botId={bot.id} name={bot.name} size={28} />
                  <span><strong>{bot.name}</strong><small>{index === 0 ? "Leads this group" : bot.title || "Teammate"}</small></span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>How it works</h3>
            <p>{lead.name} answers each message and can ask the others for help. To hear from someone directly, mention them: <code>@{(groupMembers[1] ?? lead).name}</code>. Mention several and they answer in that order.</p>
          </section>
        </aside>
      )}

      {profileOpen && !group && (
        <aside className="profile">
          {viewMode === "text" && <HoloFace state={faceState} tone={tone} label={activeBot.name} />}
          <h2>{activeBot.name}</h2>
          <p className="profile-role">{activeBot.title || "Teammate"}</p>
          <p className={`presence ${faceState}`}>{presence}</p>

          <section>
            <h3>About</h3>
            <p>{activeBot.description || "No description yet."}</p>
          </section>
          <section>
            <h3>Memory</h3>
            {!activeBot.memoryEnabled ? <p className="quiet">Memory is off for {activeBot.name}.</p>
              : remembered.length === 0 ? <p className="quiet">Nothing yet. {activeBot.name} keeps lasting facts as you talk.</p>
              : <ul>{remembered.slice(0, 5).map((line) => <li key={line}>{line}</li>)}</ul>}
            {remembered.length > 5 && <p className="quiet">And {remembered.length - 5} more.</p>}
          </section>
          <section>
            <h3>Workspace</h3>
            {activeBot.workspaceEnabled
              ? <>
                <p>Can read and write files and run commands here, with your approval.</p>
                <button className="link" onClick={openWorkspace}><FolderOpen size={13} /> {workspacePath.split("/").pop() || "Workspace"}</button>
              </>
              : <p className="quiet">{activeBot.name} has no access to files or commands.</p>}
          </section>
          <section>
            <h3>This thread</h3>
            <dl>
              <div><dt>Model</dt><dd>{claude.model ? `Claude ${modelName}` : "Claude"}</dd></div>
              <div><dt>Tokens</dt><dd>{(usage.prompt + usage.completion).toLocaleString()}</dd></div>
              <div><dt>Speed</dt><dd>{tokensPerSecond ? `${tokensPerSecond.toFixed(1)} tokens/s` : "No reply yet"}</dd></div>
            </dl>
          </section>
          <button className="ghost" onClick={() => void editBot(activeBot.id)}><Pencil size={13} /> {activeBot.id === AERIS_ID ? "Edit memory" : `Edit ${activeBot.name}`}</button>
        </aside>
      )}

      {botDraft && <BotEditor draft={botDraft} error={botError} onChange={setBotDraft} onSave={() => void saveBot()} onDelete={(botId) => void deleteBot(botId)} onClose={() => setBotDraft(null)} />}

      {settingsOpen && (
        <SettingsDrawer
          claude={claude} claudeInfo={claudeInfo} onClaudeChange={setClaude} onCheckClaude={() => void checkClaude()}
          instructions={instructions} defaultInstructions={defaultInstructions} onInstructionsChange={setInstructions}
          voices={voices} speechVoice={speechVoice} onSpeechVoiceChange={setSpeechVoice}
          readAloud={readAloud} onReadAloudChange={setReadAloud}
          onPlaySample={() => speak(`Hello Rohan. This is how ${activeBot.name} sounds when reading a reply.`)}
          voice={voiceConfig} onVoiceChange={setVoiceConfig}
          workspaceDir={workspaceDir} workspacePath={workspacePath} workspaceError={workspaceError}
          onWorkspaceDirChange={setWorkspaceDir} onOpenWorkspace={openWorkspace}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {skillsOpen && <SkillsDialog initial={skillsOpen.draft} onClose={() => setSkillsOpen(null)} />}
      {pluginsOpen && <PluginsDialog onClose={() => setPluginsOpen(false)} />}
      {routinesOpen && <RoutinesDialog bots={bots} defaultBotId={activeBot.id} onOpenThread={(chatId) => void openRoutineThread(chatId)} onClose={() => setRoutinesOpen(false)} />}

      {groupDraft && (
        <div className="backdrop" role="presentation" onMouseDown={() => setGroupDraft(null)}>
          <section className="dialog editor" role="dialog" aria-modal="true" aria-labelledby="group-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="dialog-head">
              <h2 id="group-title">New group</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setGroupDraft(null)}><X size={17} /></button>
            </header>
            <div className="form">
              <label className="wide">Group name
                <input autoFocus value={groupDraft.title} maxLength={60} placeholder="Lesson planning" onChange={(e) => setGroupDraft({ ...groupDraft, title: e.target.value })} />
              </label>
              <fieldset className="wide member-picker">
                <legend>Teammates in this group. The first one you pick leads.</legend>
                {bots.map((bot) => {
                  const position = groupDraft.members.indexOf(bot.id);
                  return (
                    <label className={`member-option ${position >= 0 ? "picked" : ""}`} key={bot.id}>
                      <input type="checkbox" checked={position >= 0}
                        onChange={(e) => setGroupDraft({ ...groupDraft, members: e.target.checked ? [...groupDraft.members, bot.id] : groupDraft.members.filter((id) => id !== bot.id) })} />
                      <Avatar botId={bot.id} name={bot.name} size={28} />
                      <span><strong>{bot.name}</strong><small>{bot.title || "Teammate"}</small></span>
                      {position === 0 && <em>Leads</em>}
                    </label>
                  );
                })}
              </fieldset>
            </div>
            {groupError && <div className="error-banner">{groupError}</div>}
            <footer className="dialog-actions">
              <button className="ghost" onClick={() => setGroupDraft(null)}>Cancel</button>
              <button className="primary" onClick={() => void createGroup()} disabled={!groupDraft.title.trim() || groupDraft.members.length < 2}>Create group</button>
            </footer>
          </section>
        </div>
      )}

      {threadToDelete && (
        <div className="backdrop" role="presentation" onMouseDown={() => setThreadToDelete(null)}>
          <section className="dialog confirm" role="dialog" aria-modal="true" aria-labelledby="delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="delete-title">{threadToDelete.members.length ? "Delete this group?" : "Delete this thread?"}</h2>
            <p>"{threadToDelete.title}" and its messages will be removed from this Mac. This can't be undone. What your teammates remember stays.</p>
            <footer className="dialog-actions">
              <button className="ghost" onClick={() => setThreadToDelete(null)}>{threadToDelete.members.length ? "Keep group" : "Keep thread"}</button>
              <button className="primary danger" onClick={() => void deleteThread(threadToDelete)}><Trash2 size={14} /> {threadToDelete.members.length ? "Delete group" : "Delete thread"}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
