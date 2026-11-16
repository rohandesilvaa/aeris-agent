import type { Bot, BotDraft } from "./types";

export type Tone = [number, number, number];

export const AERIS_ID = "aeris";
export const AERIS_BOT: Bot = {
  id: AERIS_ID,
  name: "Aeris",
  title: "Chief of staff",
  description: "Keeps the big picture and helps with anything.",
  instructions: "",
  memory: "",
  memoryEnabled: true,
  workspaceEnabled: true,
  createdAt: 0,
};
export const EMPTY_DRAFT: BotDraft = { id: null, name: "", title: "", description: "", instructions: "", memory: "", memoryEnabled: true, workspaceEnabled: true };

/** Starting points for a new teammate. Each one does a single job. */
export const TEMPLATES: Array<Pick<Bot, "name" | "title" | "description" | "instructions">> = [
  {
    name: "Scout",
    title: "Researcher",
    description: "Finds and checks facts before Rohan relies on them.",
    instructions: "Search the web for anything that may have changed. Answer with what is known, how sure you are, and what is still unverified. Keep it short and link your sources.",
  },
  {
    name: "Guru",
    title: "Lesson planner",
    description: "Plans Grade 10 ICT lessons and notes for Sinhala-medium classes.",
    instructions: "Write lesson notes as short bullet points in simple Sinhala, with English technical terms in brackets. For each lesson give objectives, key points, one class activity, and three revision questions.",
  },
  {
    name: "Quill",
    title: "Writer",
    description: "Drafts and edits posts, emails, and documents in Rohan's voice.",
    instructions: "Write plainly and get to the point. Offer one strong draft instead of several options. When editing, change as little as needed and say what you changed.",
  },
  {
    name: "Forge",
    title: "Engineer",
    description: "Helps design, write, and debug code for Rohan's projects.",
    instructions: "Ask for the error text or the code before guessing. Explain the cause in one or two sentences, then give the smallest change that fixes it, as a complete code block.",
  },
  {
    name: "Compass",
    title: "Planner",
    description: "Turns goals into weekly plans and keeps track of what was decided.",
    instructions: "Break goals into tasks small enough to finish in one sitting. Put the most important task first, give each a rough time, and end with the single next action.",
  },
];

// Aeris is always ice blue. Other teammates take one of the remaining colours
// from their id, so a teammate keeps its colour for life.
const PALETTE: Tone[] = [
  [142, 222, 255],
  [134, 239, 190],
  [190, 170, 255],
  [255, 162, 190],
  [202, 238, 132],
];

export function botTone(botId: string): Tone {
  if (botId === AERIS_ID) return PALETTE[0];
  let hash = 0;
  for (const character of botId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PALETTE[1 + (hash % (PALETTE.length - 1))];
}

export const toneCss = (tone: Tone, alpha = 1) => `rgba(${tone[0]}, ${tone[1]}, ${tone[2]}, ${alpha})`;

export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const clockTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Memory is stored as bullet lines; this returns them without the bullets. */
export const memoryLines = (memory: string) =>
  memory.split("\n").map((line) => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
