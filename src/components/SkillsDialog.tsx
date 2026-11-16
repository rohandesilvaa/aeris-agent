import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import type { Skill, SkillDraft } from "../types";

const EMPTY: SkillDraft = { name: "", description: "", instructions: "" };

type Props = { initial: SkillDraft | null; onClose: () => void };

/** The team's shared library of saved procedures. */
export default function SkillsDialog({ initial, onClose }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<SkillDraft | null>(initial);
  const [error, setError] = useState("");

  const load = () => invoke<Skill[]>("list_skills").then(setSkills).catch((cause) => setError(String(cause)));
  useEffect(() => { void load(); }, []);

  async function save() {
    if (!editing) return;
    try {
      await invoke("save_skill", { input: editing });
      setEditing(null);
      setError("");
      await load();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function remove(skillId: string) {
    try {
      await invoke("delete_skill", { skillId });
      setEditing(null);
      await load();
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <div className="backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog editor" role="dialog" aria-modal="true" aria-labelledby="skills-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="skills-title">{editing ? (editing.id ? "Edit skill" : "New skill") : "Skills"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </header>
        {editing ? <>
          <div className="form">
            <label className="wide">Name<input autoFocus value={editing.name} maxLength={60} placeholder="Lesson notes" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="wide">When to use it
              <input value={editing.description} maxLength={300} placeholder="When Rohan asks for notes for a new lesson." onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <label className="wide">Steps to follow
              <textarea rows={11} value={editing.instructions} placeholder={"1. Ask for the topic if it is missing.\n2. …"} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} />
            </label>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            {editing.id && <button className="ghost danger" onClick={() => void remove(editing.id!)}><Trash2 size={14} /> Delete skill</button>}
            <button className="ghost" onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
            <button className="primary" onClick={() => void save()}>Save skill</button>
          </footer>
        </> : <>
          <p className="note">A skill is a procedure you saved. Every teammate can load one when a task calls for it, or when you name it.</p>
          <ul className="library">
            {skills.map((skill) => (
              <li key={skill.id}>
                <span><strong>{skill.name}</strong><small>{skill.description || "No description"}</small></span>
                <button className="icon-button" aria-label={`Edit ${skill.name}`} onClick={() => setEditing({ ...skill })}><Pencil size={14} /></button>
              </li>
            ))}
            {skills.length === 0 && <li className="library-empty">No skills yet. Write one, or use "Save as skill" under a reply that went well.</li>}
          </ul>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            <button className="primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={14} /> New skill</button>
          </footer>
        </>}
      </section>
    </div>
  );
}
