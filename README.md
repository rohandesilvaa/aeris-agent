# Aeris

Rohan's private personal AI agent, built with Tauri, Rust, React, SQLite, and a local `llama-server` model.

## Custom Model provider

Aeris can switch between the on-device LFM and an OpenAI-compatible Custom Model API hosted from a Kaggle notebook. Select **Custom Model** in the title bar or Settings. The Rust backend reads credentials from `.env`, discovers the model through `/v1/models`, and proxies streaming `/v1/chat/completions` responses without exposing the API key to the webview or localStorage.

Local Model and Custom Model have separate conditional settings panels. Regardless of the selected provider, chat sessions and completed responses are stored in the same local SQLite database on the Mac.

Assistant messages render safe GitHub-Flavored Markdown, including headings, lists, blockquotes, fenced code blocks, links, and tables. Raw HTML from model output is not executed.

Copy `.env.example` to `.env` and set `CUSTOM_MODEL_BASE_URL` and `CUSTOM_MODEL_API_KEY`. `CUSTOM_MODEL_ID` is optional. The existing human-readable `BASE URL:` and `API KEY:` labels are also supported.

## Phase 2 features

- Multiple local chat sessions with create, switch, rename, clear, and delete actions
- SQLite-backed chat and message persistence
- Automatic migration of the original localStorage conversation
- Rust inference proxy with cancellable streaming over Tauri channels
- Per-chat context usage and generation speed
- Rust-managed `llama-server` lifecycle with one inference slot for lower memory use

## Voice mode

- Dedicated Text and Voice tabs
- Animated Aeris voice core with listening, transcribing, thinking, and speaking states
- Push-to-talk microphone recording
- Fully local English transcription through a persistent `whisper-server` on `127.0.0.1:8092`
- CPU-only `small.en-q5_1` inference to balance accuracy and speed without competing with the LFM server for Metal memory
- macOS speech synthesis for spoken Aeris responses
- Editable Whisper binary, multilingual model, ffmpeg, and language settings

The SQLite database is stored in the app's macOS Application Support directory under the original `com.rohan.aeris-local` identifier so upgrades retain existing chats. Model requests remain local and are proxied by the Rust backend; the webview does not connect to the model server directly.

## Development

Requirements: Node.js 20+, Rust stable, `llama-server`, the GGUF model file, `ffmpeg`, and `whisper-cli` from `whisper.cpp`.

```bash
pnpm install
pnpm tauri dev
```

Create an optimized macOS app with:

```bash
pnpm tauri build
```

The generated app is at `src-tauri/target/release/bundle/macos/Aeris.app`.

The default settings point to:

- Model: `/Volumes/ROHAN DISK/Local Models/LFM2.5-2.6B-Q4_K_M.gguf`
- Server: `/opt/homebrew/bin/llama-server`
- Context: `16384`
- GPU layers: `99`
- API: `127.0.0.1:8080`
- Whisper: `/opt/homebrew/bin/whisper-cli`
- Whisper model: `/Volumes/ROHAN DISK/Local Models/ggml-small.en-q5_1.bin`
- ffmpeg: `/opt/homebrew/bin/ffmpeg`

Use the settings button in the title bar to change any of these values.
