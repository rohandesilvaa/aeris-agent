# Aeris

Rohan's private personal AI agent, built with Tauri, Rust, React, SQLite, and a local `llama-server` model.

## Phase 2 features

- Multiple local chat sessions with create, switch, rename, clear, and delete actions
- SQLite-backed chat and message persistence
- Automatic migration of the original localStorage conversation
- Rust inference proxy with cancellable streaming over Tauri channels
- Per-chat context usage and generation speed
- Rust-managed `llama-server` lifecycle with one inference slot for lower memory use

The SQLite database is stored in the app's macOS Application Support directory under the original `com.rohan.aeris-local` identifier so upgrades retain existing chats. Model requests remain local and are proxied by the Rust backend; the webview does not connect to the model server directly.

## Development

Requirements: Node.js 20+, Rust stable, `llama-server`, and the GGUF model file.

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

Use the settings button in the title bar to change any of these values.
