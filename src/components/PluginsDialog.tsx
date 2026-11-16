import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import type { Plugin, PluginDraft } from "../types";

const EMPTY: PluginDraft = { name: "", kind: "command", target: "", secrets: "", access: "ask" };

const STATUS_TEXT: Record<string, string> = {
  connected: "Connected",
  failed: "Could not connect",
  "needs-auth": "Needs sign-in",
  pending: "Still connecting",
  unknown: "No answer",
};

type Check = { status: string; tools: string[] } | { error: string } | "running";

/** Outside tool servers (MCP) the team can use. */
export default function PluginsDialog({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [editing, setEditing] = useState<PluginDraft | null>(null);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [error, setError] = useState("");

  const load = () => invoke<Plugin[]>("list_plugins").then(setPlugins).catch((cause) => setError(String(cause)));
  useEffect(() => { void load(); }, []);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError("");
      await load();
    } catch (cause) {
      setError(String(cause));
    }
  };

  async function test(plugin: Plugin) {
    setChecks((current) => ({ ...current, [plugin.id]: "running" }));
    try {
      const result = await invoke<{ status: string; tools: string[] }>("test_plugin", { pluginId: plugin.id });
      setChecks((current) => ({ ...current, [plugin.id]: result }));
    } catch (cause) {
      setChecks((current) => ({ ...current, [plugin.id]: { error: String(cause) } }));
    }
  }

  return (
    <div className="backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog editor" role="dialog" aria-modal="true" aria-labelledby="plugins-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="plugins-title">{editing ? (editing.id ? "Edit plugin" : "Add a plugin") : "Plugins"}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </header>
        {editing ? <>
          <div className="form">
            <label>Name<input autoFocus value={editing.name} maxLength={30} placeholder="notes" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>How it runs
              <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as PluginDraft["kind"] })}>
                <option value="command">A command on this Mac</option>
                <option value="url">A server at a URL</option>
              </select>
            </label>
            <label className="wide">{editing.kind === "command" ? "Command" : "URL"}
              <input value={editing.target} placeholder={editing.kind === "command" ? "npx -y @modelcontextprotocol/server-memory" : "https://example.com/mcp"} onChange={(e) => setEditing({ ...editing, target: e.target.value })} />
            </label>
            <label className="wide">{editing.kind === "command" ? "Environment variables, one KEY=value per line" : "Headers, one Name=value per line"}
              <textarea rows={3} value={editing.secrets} placeholder={editing.kind === "command" ? "API_KEY=…" : "Authorization=Bearer …"} onChange={(e) => setEditing({ ...editing, secrets: e.target.value })} />
            </label>
            <label className="wide">When a teammate wants to use it
              <select value={editing.access} onChange={(e) => setEditing({ ...editing, access: e.target.value as PluginDraft["access"] })}>
                <option value="ask">Ask me each time</option>
                <option value="allow">Allow without asking</option>
                <option value="off">Keep it switched off</option>
              </select>
            </label>
            <p className="note wide">Keys you enter are stored in the app's database on this Mac, not encrypted. What a plugin returns is sent to Anthropic as part of the conversation.</p>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            {editing.id && <button className="ghost danger" onClick={() => void act(async () => { await invoke("delete_plugin", { pluginId: editing.id }); setEditing(null); })}><Trash2 size={14} /> Remove plugin</button>}
            <button className="ghost" onClick={() => { setEditing(null); setError(""); }}>Cancel</button>
            <button className="primary" onClick={() => void act(async () => { await invoke("save_plugin", { input: editing }); setEditing(null); })}>Save plugin</button>
          </footer>
        </> : <>
          <p className="note">A plugin gives every teammate extra tools from a tool server (MCP), such as a notes app or an issue tracker. Scheduled routines can only use plugins set to "Allow", because nobody is there to answer.</p>
          <ul className="library">
            {plugins.map((plugin) => {
              const check = checks[plugin.id];
              return (
                <li key={plugin.id} className={plugin.access === "off" ? "off" : ""}>
                  <span>
                    <strong>{plugin.name}</strong>
                    <small>{plugin.target}</small>
                    {check && check !== "running" && (
                      <small className={"error" in check || check.status !== "connected" ? "bad" : "good"}>
                        {"error" in check ? check.error
                          : `${STATUS_TEXT[check.status] ?? check.status}${check.tools.length ? `. Tools: ${check.tools.join(", ")}` : ""}`}
                      </small>
                    )}
                  </span>
                  <select aria-label={`Access for ${plugin.name}`} value={plugin.access}
                    onChange={(e) => void act(() => invoke("save_plugin", { input: { ...plugin, access: e.target.value } }))}>
                    <option value="ask">Ask each time</option>
                    <option value="allow">Allow</option>
                    <option value="off">Off</option>
                  </select>
                  <button className="ghost compact" disabled={check === "running"} onClick={() => void test(plugin)}>
                    {check === "running" ? <><LoaderCircle className="spin" size={13} /> Testing</> : "Test"}
                  </button>
                  <button className="icon-button" aria-label={`Edit ${plugin.name}`} onClick={() => setEditing({ ...plugin })}><Pencil size={14} /></button>
                </li>
              );
            })}
            {plugins.length === 0 && <li className="library-empty">No plugins yet. Add a tool server by its command or URL.</li>}
          </ul>
          {error && <div className="error-banner">{error}</div>}
          <footer className="dialog-actions">
            <button className="primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={14} /> Add a plugin</button>
          </footer>
        </>}
      </section>
    </div>
  );
}
