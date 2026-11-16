import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENTS, AgentStep, ReplyState } from "../agents";

const STATUS_TEXT: Record<AgentStep["status"], string> = {
  pending: "Waiting",
  working: "Working",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

type Props = { steps: AgentStep[]; reply: ReplyState; leadName: string };

/** The specialists' progress, shown inside the thread while they work. */
export default function TeamWork({ steps, reply, leadName }: Props) {
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  return (
    <ol className="team-work">
      {AGENTS.map((agent) => {
        const step = steps.find((item) => item.agent === agent.id);
        const status = step?.status ?? "pending";
        const open = openAgent === agent.id && Boolean(step?.content);
        return (
          <li key={agent.id} className={`team-row ${status}`}>
            <button className="team-row-head" onClick={() => setOpenAgent(open ? null : agent.id)} disabled={!step?.content} aria-expanded={open}>
              <i className="team-dot" />
              <span className="team-name">{agent.name}<small>{agent.role}</small></span>
              <span className="team-status">{STATUS_TEXT[status]}</span>
            </button>
            {step?.content && (open
              ? <div className="team-notes-full markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{step.content}</ReactMarkdown></div>
              : status === "working" && <p className="team-preview">{step.content.replace(/[*#`>-]/g, " ").replace(/\s+/g, " ").trim()}</p>)}
          </li>
        );
      })}
      <li className={`team-row ${reply === "writing" ? "working" : reply === "done" ? "done" : "pending"}`}>
        <div className="team-row-head">
          <i className="team-dot" />
          <span className="team-name">{leadName}<small>Final reply</small></span>
          <span className="team-status">{reply === "writing" ? "Writing" : reply === "done" ? "Done" : "Waiting for the specialists"}</span>
        </div>
      </li>
    </ol>
  );
}
