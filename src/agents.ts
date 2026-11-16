import type { Handoff } from "./types";

export type AgentStatus = "pending" | "working" | "done" | "error" | "stopped";
export type AgentStep = { agent: string; content: string; status: AgentStatus };
export type StoredAgentStep = { messageId: string; agent: string; content: string; position: number };
export type ReplyState = "idle" | "waiting" | "writing" | "done";

/** The saved step that lists a teammate's tool work. Matches the backend. */
const ACTIONS_STEP = "actions";

/** Saved steps for help from another teammate are named `handoff:<bot id>`. */
const HANDOFF_PREFIX = "handoff:";

/** The team, in the order it works. Ids match the Rust backend. */
export const AGENTS = [
  { id: "researcher", name: "Atlas", role: "Research", does: "Gathers facts and context" },
  { id: "analyst", name: "Vega", role: "Reasoning", does: "Works through the logic" },
  { id: "creative", name: "Nova", role: "Ideas", does: "Finds other angles" },
  { id: "critic", name: "Argus", role: "Review", does: "Checks the team's notes" },
] as const;

export const agentName = (id: string) => AGENTS.find((agent) => agent.id === id)?.name ?? id;

export function groupSteps(stored: StoredAgentStep[]): Record<string, AgentStep[]> {
  const runs: Record<string, AgentStep[]> = {};
  for (const step of stored) {
    if (step.agent === ACTIONS_STEP || step.agent.startsWith(HANDOFF_PREFIX)) continue;
    (runs[step.messageId] ??= []).push({ agent: step.agent, content: step.content, status: "done" });
  }
  return runs;
}

/** The help each reply got from other teammates. */
export function groupHandoffs(stored: StoredAgentStep[]): Record<string, Handoff[]> {
  const handoffs: Record<string, Handoff[]> = {};
  for (const step of stored) {
    if (!step.agent.startsWith(HANDOFF_PREFIX)) continue;
    try {
      const { question, answer } = JSON.parse(step.content) as { question: string; answer: string };
      (handoffs[step.messageId] ??= []).push({ botId: step.agent.slice(HANDOFF_PREFIX.length), question, answer, status: "done" });
    } catch { /* an unreadable step is skipped */ }
  }
  return handoffs;
}

/** What each reply's teammate did with its tools, one line per action. */
export function groupActions(stored: StoredAgentStep[]): Record<string, string[]> {
  const actions: Record<string, string[]> = {};
  for (const step of stored) {
    if (step.agent === ACTIONS_STEP) actions[step.messageId] = step.content.split("\n").filter(Boolean);
  }
  return actions;
}

/** A sentence for what the team is doing right now, or null when idle. */
export function teamActivity(steps: AgentStep[] | undefined, reply: ReplyState, leadName = "Aeris"): string | null {
  if (!steps) return null;
  const working = steps.filter((step) => step.status === "working").map((step) => agentName(step.agent));
  if (working.length === 1) return `${working[0]} is working`;
  if (working.length > 1) return `${working.slice(0, -1).join(", ")} and ${working[working.length - 1]} are working`;
  if (reply === "waiting") return "The team is starting";
  if (reply === "writing") return `${leadName} is writing the reply`;
  return null;
}
