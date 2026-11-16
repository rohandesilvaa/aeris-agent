# Aeris Bot

Rohan's private team of AI teammates, as a macOS app. Built with Tauri, Rust, React, and SQLite. Every teammate thinks with Claude through the Claude Code CLI.

## What it does

- **Teammates.** Aeris, the chief of staff, is always there. Add your own teammates, each with a name, a role, a description of what it owns, and instructions for how it works.
- **Threads.** Each teammate has its own conversation threads, stored in a local SQLite database.
- **Memory.** After each reply a teammate updates a short list of lasting facts (preferences, projects, decisions). The list is carried into every thread with that teammate, and you can read, edit, or clear it.
- **Specialists.** Turn on "Specialists" for a message and four agents work first: Atlas (research, with web search), Vega (reasoning), and Nova (ideas) run in parallel, Argus reviews their notes, and the teammate writes the final reply. Their notes are saved with the reply.
- **Handoffs.** Any teammate can ask another for help with the `ask_teammate` tool. The other teammate answers with its own instructions and memory, and the question and answer are shown and saved with the reply.
- **Groups.** A group thread has two to six teammates. The first one leads and answers by default; `@name` chooses who answers, and several mentions answer in that order. Each teammate sees the whole thread, labelled by author.
- **Skills.** A shared library of saved procedures. Teammates see each skill's name and when to use it, and load the full steps with the `use_skill` tool when a task calls for it. "Save as skill" under a reply drafts one from the thread for you to review.
- **Routines.** A routine sends a teammate the same request on a schedule (hourly, daily, Monday to Friday, or weekly) and keeps the replies in one thread. Routines run while the app is open; a missed run is caught up once at the next start. Nobody is there to approve, so commands never run in a routine, and file writes go ahead only if you turned that on for the routine.
- **Plugins.** Add outside tool servers (MCP) by command or URL. Each plugin is off, asks before every use, or is allowed without asking. Plugins are passed to Claude Code only for a teammate's own reply; Claude Code's own MCP configuration is never loaded. Keys are stored unencrypted in the app's database.
- **Workspace.** Teammates share one folder on this Mac (`~/Aeris Bot Workspace` by default). A teammate with workspace access can read files there freely; every file write and every shell command waits for your approval in the thread. Files outside the folder cannot be opened by the file tools. What a teammate did is listed above its reply.
- **Voice.** Speak to a teammate (transcribed on this Mac by `whisper-server`) and hear replies read by a macOS voice. A hologram face shows whether the teammate is listening, working, or replying.

## Model

Claude Code is the only model provider. The Rust backend runs `claude -p` and reads its JSON stream. A teammate's own reply runs in the workspace folder in Claude Code's restricted mode, with permission questions answered by the app. Specialists and memory updates run in an empty folder with no file or command tools.

Sign in once in Terminal:

```bash
claude auth login
```

Choose the Claude model in Settings. Memory updates always use Haiku.

## Development

Requirements: Node.js 20+, Rust stable, and the Claude Code CLI. Voice also needs `ffmpeg` and `whisper.cpp`.

```bash
pnpm install
```

```bash
./node_modules/.bin/tauri dev
```

To design the interface in a plain browser, run `./node_modules/.bin/vite` and open http://127.0.0.1:1420. Outside the Tauri window the app uses a simulated backend (`src/devMock.ts`).

Build the macOS app:

```bash
./node_modules/.bin/tauri build
```

The app is written to `src-tauri/target/release/bundle/macos/Aeris Bot.app`.

## Data

The database is `aeris.sqlite3` in the app's Application Support directory, under the identifier `com.rohan.aeris-local`. Chats and memory stay on this Mac. Messages are sent to Anthropic to generate replies.

## Layout

| Path | What it holds |
|---|---|
| `src/App.tsx` | App state and the three-column layout |
| `src/components/` | Hologram face, teammate editor, settings, specialists card |
| `src-tauri/src/inference.rs` | The chat command and system prompts |
| `src-tauri/src/agents.rs` | The specialist team |
| `src-tauri/src/claude_code.rs` | Running the Claude Code CLI and reading its stream |
| `src-tauri/src/memory.rs` | Long-term memory rules |
| `src-tauri/src/plugins.rs` | Plugins (MCP servers) and their access rules |
| `src-tauri/src/skills.rs` | The skills library and drafting a skill from a thread |
| `src-tauri/src/routines.rs` | Routines and their scheduler |
| `src-tauri/src/database.rs` | SQLite schema, teammates, threads |
| `src-tauri/src/voice.rs` | Local speech transcription |
