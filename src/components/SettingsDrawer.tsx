import { X } from "lucide-react";
import type { ClaudeCodeInfo, ClaudeConfig, SystemVoice, VoiceConfig } from "../types";
import { pickVoice } from "../lib/speech";

export const CLAUDE_MODELS = [
  { value: "", label: "Claude Code default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

type Props = {
  claude: ClaudeConfig;
  claudeInfo: ClaudeCodeInfo | null;
  onClaudeChange: (config: ClaudeConfig) => void;
  onCheckClaude: () => void;
  instructions: string;
  defaultInstructions: string;
  onInstructionsChange: (value: string) => void;
  voices: SystemVoice[];
  speechVoice: string;
  onSpeechVoiceChange: (name: string) => void;
  readAloud: boolean;
  onReadAloudChange: (value: boolean) => void;
  onPlaySample: () => void;
  voice: VoiceConfig;
  onVoiceChange: (config: VoiceConfig) => void;
  workspaceDir: string;
  workspacePath: string;
  workspaceError: string;
  onWorkspaceDirChange: (path: string) => void;
  onOpenWorkspace: () => void;
  onClose: () => void;
};

export default function SettingsDrawer(props: Props) {
  const { claude, claudeInfo, voice } = props;
  const ready = Boolean(claudeInfo?.installed && claudeInfo.loggedIn);
  const bestVoice = pickVoice(props.voices, "");
  return (
    <div className="backdrop drawer" role="presentation" onMouseDown={props.onClose}>
      <section className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-button" aria-label="Close settings" onClick={props.onClose}><X size={17} /></button>
        </header>
        <div className="form">
          <div className="form-section wide"><h3>Claude Code</h3><p>Every teammate thinks with Claude, through the Claude Code CLI on this Mac.</p></div>
          <div className={`connection wide ${ready ? "online" : "offline"}`}>
            <span>{ready ? "Ready" : claudeInfo?.installed ? "Signed out" : claudeInfo ? "Not found" : "Checking"}</span>
            <small>{claudeInfo?.message ?? "Checking Claude Code…"}</small>
            <button className="ghost compact" onClick={props.onCheckClaude}>Check again</button>
          </div>
          <label className="wide">Model
            <select value={claude.model} onChange={(e) => props.onClaudeChange({ ...claude, model: e.target.value })}>
              {CLAUDE_MODELS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
          </label>
          <label className="wide">Claude Code CLI path
            <input value={claude.binaryPath} placeholder={claudeInfo?.path ?? "Found automatically"} onChange={(e) => props.onClaudeChange({ ...claude, binaryPath: e.target.value })} />
          </label>
          <p className="note wide">Messages go to Anthropic, including anything a teammate reads from the workspace.</p>

          <div className="form-section wide"><h3>Workspace</h3><p>One folder on this Mac that teammates share. They can read it freely; every file write and every command waits for your approval. Nothing outside it can be opened.</p></div>
          <label className="wide">Workspace folder
            <input value={props.workspaceDir} placeholder={props.workspacePath || "~/Aeris Bot Workspace"} onChange={(e) => props.onWorkspaceDirChange(e.target.value)} />
          </label>
          <div className="form-row wide">
            <span>{props.workspaceError || "Leave it empty to use the default folder in your home folder."}</span>
            <button className="ghost compact" onClick={props.onOpenWorkspace}>Show in Finder</button>
          </div>

          <div className="form-section wide"><h3>Aeris</h3><p>How your chief of staff behaves. Other teammates have their own instructions.</p></div>
          <label className="wide">Instructions
            <textarea rows={8} value={props.instructions || props.defaultInstructions} onChange={(e) => props.onInstructionsChange(e.target.value)} />
          </label>
          <div className="form-row wide">
            <span>Restores the instructions Aeris came with.</span>
            <button className="ghost compact" onClick={() => props.onInstructionsChange("")} disabled={!props.instructions}>Reset instructions</button>
          </div>

          <div className="form-section wide"><h3>Voice</h3><p>Replies are read by a macOS voice and your speech is transcribed by Whisper. Both run on this Mac, in English. Voices you download in System Settings appear here.</p></div>
          <label className="wide">Speaking voice
            <select value={props.speechVoice} onChange={(e) => props.onSpeechVoiceChange(e.target.value)}>
              <option value="">Best available{bestVoice ? ` (${bestVoice.name})` : ""}</option>
              {props.voices.map((item) => <option key={`${item.name} ${item.locale}`} value={item.name}>{item.name} ({item.locale.replace("_", "-")})</option>)}
            </select>
          </label>
          <div className="form-row wide">
            <label className="check"><input type="checkbox" checked={props.readAloud} onChange={(e) => props.onReadAloudChange(e.target.checked)} /> Read every reply aloud</label>
            <button className="ghost compact" onClick={props.onPlaySample}>Play a sample</button>
          </div>
          <label className="wide">whisper-cli path<input value={voice.whisperBinaryPath} onChange={(e) => props.onVoiceChange({ ...voice, whisperBinaryPath: e.target.value })} /></label>
          <label className="wide">Whisper model path<input value={voice.whisperModelPath} onChange={(e) => props.onVoiceChange({ ...voice, whisperModelPath: e.target.value })} /></label>
          <label className="wide">ffmpeg path<input value={voice.ffmpegPath} onChange={(e) => props.onVoiceChange({ ...voice, ffmpegPath: e.target.value })} /></label>
        </div>
      </section>
    </div>
  );
}
