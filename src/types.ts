export type Role = "user" | "assistant" | "system";
/** `botId` is the teammate who wrote an assistant message. */
export type Message = { id: string; chatId: string; role: Role; content: string; createdAt: number; botId?: string };

/** A teammate: a named Bot with its own instructions, threads and memory. */
export type Bot = {
  id: string;
  name: string;
  title: string;
  description: string;
  instructions: string;
  memory: string;
  memoryEnabled: boolean;
  /** May work with files and commands in the workspace folder. */
  workspaceEnabled: boolean;
  createdAt: number;
};
export type BotDraft = Omit<Bot, "id" | "createdAt"> & { id: string | null };

/** One conversation thread: with a single teammate, or a group when
 * `members` lists several (the first one leads). */
export type ChatSummary = {
  id: string;
  botId: string;
  members: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  promptTokens: number;
  completionTokens: number;
};

export type Status = "online" | "offline" | "starting";
export type ClaudeConfig = { binaryPath: string; model: string };
export type ClaudeCodeInfo = { installed: boolean; loggedIn: boolean; path?: string; message: string };

/** A voice installed in macOS, as listed by the `say` command. */
export type SystemVoice = { name: string; locale: string };

/** A saved procedure any teammate can load. */
export type Skill = { id: string; name: string; description: string; instructions: string; createdAt: number };
export type SkillDraft = { id?: string; name: string; description: string; instructions: string };

/** Work a teammate does on a schedule, in its own thread. */
export type Routine = {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  schedule: "hourly" | "daily" | "weekdays" | "weekly";
  /** `HH:MM`, local time. */
  time: string;
  /** 0 is Monday. */
  weekday: number;
  enabled: boolean;
  allowWrites: boolean;
  chatId: string | null;
  lastRun: number | null;
  lastStatus: string;
  nextRun: number;
};
export type RoutineDraft = Pick<Routine, "botId" | "title" | "prompt" | "schedule" | "time" | "weekday" | "enabled" | "allowWrites"> & { id?: string };

/** An outside tool server (MCP) the team can use. */
export type Plugin = {
  id: string;
  name: string;
  kind: "command" | "url";
  /** The command line, or the URL. */
  target: string;
  /** `KEY=value` lines: environment variables or headers. */
  secrets: string;
  access: "off" | "ask" | "allow";
  createdAt: number;
};
export type PluginDraft = Omit<Plugin, "id" | "createdAt"> & { id?: string };

/** One teammate asking another for help while writing a reply. */
export type Handoff = { botId: string; question: string; answer: string; status: "working" | "done" | "error" };

/** A file write or command a teammate wants to do, waiting for an answer. */
export type Approval = { id: string; tool: string; summary: string; detail: string };

export type ViewMode = "text" | "voice";
export type VoiceState = "idle" | "listening" | "transcribing" | "thinking" | "speaking" | "error";
export type VoiceConfig = { whisperBinaryPath: string; whisperModelPath: string; ffmpegPath: string; language: string };

export type StreamEvent = {
  type: "chunk" | "usage" | "done" | "error" | "agent" | "tool" | "approval" | "message" | "handoff";
  messageId?: string;
  tool?: string;
  approvalId?: string;
  requestId: string;
  chatId: string;
  agent?: string;
  status?: "start" | "chunk" | "done" | "error";
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
  title?: string;
  message?: string;
};
