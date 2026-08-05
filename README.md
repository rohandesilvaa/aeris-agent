# Aeris Local

A private Tauri desktop chat app for a local `llama-server` model.

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

The generated app is at `src-tauri/target/release/bundle/macos/Aeris Local.app`.

The default settings point to:

- Model: `/Volumes/ROHAN DISK/Local Models/LFM2.5-2.6B-Q4_K_M.gguf`
- Server: `/opt/homebrew/bin/llama-server`
- Context: `16384`
- GPU layers: `99`
- API: `127.0.0.1:8080`

Use the settings button in the title bar to change any of these values.
