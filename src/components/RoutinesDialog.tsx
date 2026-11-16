import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Play, Plus, Trash2, X } from "lucide-react";
import type { Bot, Routine, RoutineDraft } from "../types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function describeSchedule(routine: Pick<Routine, "schedule" | "time" | "weekday">): string {
  if (routine.schedule === "hourly") return `every hour at ${routine.time.slice(3)} minutes past`;
  if (routine.schedule === "weekdays") return `Monday to Friday at ${routine.time}`;
  if (routine.schedule === "weekly") return `every ${DAYS[routine.weekday] ?? "week"} at ${routine.time}`;
  return `every day at ${routine.time}`;
}

const when = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

type Props = { bots: Bot[]; defaultBotId: string; onOpenThread: (chatId: string) => void; onClose: () => void };

/** Work teammates do on a schedule while the app is open. */
export default function RoutinesDialog({ bots, defaultBotId, onOpenThread, onClose }: Props) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [editing, setEditing] = useState<RoutineDraft | null>(null);
  const [error, setError] = useState("");

  const load = () => invoke<Routine[]>("list_routines").then(setRoutines).catch((cause) => setError(String(cause)));
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError("");
      await load();
    } catch (cause) {
      setError(String(cause));
    }
  };
  const save = (draft: RoutineDraft) => act(async () => { await invoke("save_routine", { input: draft }); setEditing(null); });
  const blank = (): RoutineDraft => ({ botId: defaultBotId, title: "", prompt: "", schedule: "daily", time: "08:00", weekday: 0, enabled: true, allowWrites: false });

  return (
    <div className="backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog editor" role="dialog" aria-modal="true" aria-labelledby="routines-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="routines-title">{editing ? (editing.id ? "Edit routine" : "New routine") : "Routines"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </header>
        {editing ? <>
          <div className="form">
            <label>Name<input autoFocus value={editing.title} maxLength={60} placeholder="Morning plan" onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
            <label>Teammate
              <select value={editing.botId} onChange={(e) => setEditing({ ...editing, botId: e.target.value })}>
                {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
            </label>
            <label className="wide">What to do each time
              <textarea rows={5} value={editing.prompt} placeholder="Check the workspace notes and list today's three most important tasks." onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
            </label>
            <label>How often
              <select value={editing.schedule} onChange={(e) => setEditing({ ...editing, schedule: e.target.value as RoutineDraft["schedule"] })}>
                <option value="daily">Every day</option>
                <option value="weekdays">Monday to Friday</option>
                <option value="weekly">Once a week</option>
                <option value="hourly">Every hour</option>
              </select>
            </label>
            {editing.schedule === "weekly"
              ? <label>Day<select value={editing.weekday} onChange={(e) => setEditing({ ...editing, weekday: Number(e.target.value) })}>{DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
              : <span />}
            <label>{editing.schedule === "hourly" ? "Minutes past the hour (the hour is ignored)" : "Time"}
              <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
            </label>
            <span />
            <label className="check wide"><input type="checkbox" checked={editing.allowWrites} onChange={(e) => setEditing({ ...editing, allowWrites: e.target.checked })} /> Let this routine write files in the workspace without asking. Commands never run in a routine.</label>
            <label className="check wide"><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Turned on</label>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            {editing.id && <button className="ghost danger" onClick={() => void act(async () => { await invoke("delete_routine", { routineId: editing.id }); setEditing(null); })}><Trash2 size={14} /> Delete routine</button>}
            <button className="ghost" onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
            <button className="primary" onClick={() => void save(editing)}>Save routine</button>
          </footer>
        </> : <>
          <p className="note">A routine sends a teammate the same request on a schedule and keeps the replies in one thread. Routines run while Aeris Bot is open; if one was missed, it runs once when you next open the app.</p>
          <ul className="library">
            {routines.map((routine) => {
              const bot = bots.find((item) => item.id === routine.botId);
              return (
                <li key={routine.id} className={routine.enabled ? "" : "off"}>
                  <span>
                    <strong>{routine.title}</strong>
                    <small>{bot?.name ?? "A removed teammate"}, {describeSchedule(routine)}</small>
                    <small>{routine.lastStatus === "Running" ? "Running now"
                      : !routine.enabled ? "Turned off"
                      : `Next: ${when(routine.nextRun)}${routine.lastStatus ? `. Last run: ${routine.lastStatus.toLowerCase()}` : ""}`}</small>
                  </span>
                  {routine.chatId && <button className="ghost compact" onClick={() => onOpenThread(routine.chatId!)}>Open thread</button>}
                  <button className="icon-button" aria-label={`Run ${routine.title} now`} disabled={routine.lastStatus === "Running"} onClick={() => void act(() => invoke("run_routine_now", { routineId: routine.id }))}><Play size={14} /></button>
                  <button className="icon-button" aria-label={`Edit ${routine.title}`} onClick={() => setEditing({ ...routine })}><Pencil size={14} /></button>
                </li>
              );
            })}
            {routines.length === 0 && <li className="library-empty">No routines yet. Try a morning plan, or a weekly summary of the workspace.</li>}
          </ul>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            <button className="primary" onClick={() => setEditing(blank())}><Plus size={14} /> New routine</button>
          </footer>
        </>}
      </section>
    </div>
  );
}
