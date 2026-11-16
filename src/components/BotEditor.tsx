import { Trash2, X } from "lucide-react";
import type { BotDraft } from "../types";
import { AERIS_ID, TEMPLATES } from "../team";

type Props = {
  draft: BotDraft;
  error: string;
  onChange: (draft: BotDraft) => void;
  onSave: () => void;
  onDelete: (botId: string) => void;
  onClose: () => void;
};

/** Create or edit a teammate: who it is, how it works, what it remembers. */
export default function BotEditor({ draft, error, onChange, onSave, onDelete, onClose }: Props) {
  const isAeris = draft.id === AERIS_ID;
  return (
    <div className="backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="editor-title">{draft.id ? `Edit ${draft.name || "teammate"}` : "Add a teammate"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="form">
          {!draft.id && (
            <div className="templates wide">
              <span>Start from</span>
              {TEMPLATES.map((template) => (
                <button key={template.name} onClick={() => onChange({ ...draft, ...template })}>{template.title}</button>
              ))}
            </div>
          )}
          {isAeris ? (
            <p className="note wide">Aeris is your chief of staff. Its instructions are in Settings. Here you can see and change what it remembers.</p>
          ) : <>
            <label>Name<input autoFocus value={draft.name} maxLength={40} placeholder="Scout" onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
            <label>Role<input value={draft.title} maxLength={60} placeholder="Researcher" onChange={(e) => onChange({ ...draft, title: e.target.value })} /></label>
            <label className="wide">What this teammate is responsible for
              <textarea rows={2} value={draft.description} placeholder="One job, in a sentence or two." onChange={(e) => onChange({ ...draft, description: e.target.value })} />
            </label>
            <label className="wide">How it should work
              <textarea rows={6} value={draft.instructions} placeholder="Tone, format, steps to follow, things to avoid." onChange={(e) => onChange({ ...draft, instructions: e.target.value })} />
            </label>
          </>}
          <label className="check wide"><input type="checkbox" checked={draft.workspaceEnabled} onChange={(e) => onChange({ ...draft, workspaceEnabled: e.target.checked })} /> Can work in the workspace folder: read and write files, run commands. You approve each write and command.</label>
          <label className="check wide"><input type="checkbox" checked={draft.memoryEnabled} onChange={(e) => onChange({ ...draft, memoryEnabled: e.target.checked })} /> Remember things across threads</label>
          {draft.memoryEnabled && (
            <label className="wide">Memory
              <textarea rows={5} value={draft.memory} placeholder="Nothing remembered yet. This fills in as you talk, and you can edit or clear it." onChange={(e) => onChange({ ...draft, memory: e.target.value })} />
            </label>
          )}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <footer className="dialog-actions">
          {draft.id && !isAeris && (
            <button className="ghost danger" onClick={() => onDelete(draft.id!)}><Trash2 size={14} /> Remove teammate and threads</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={onSave}>{draft.id ? "Save changes" : "Add teammate"}</button>
        </footer>
      </section>
    </div>
  );
}
