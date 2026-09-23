# FRP Client

[🇨🇳 中文](README.md) · 🇺🇸 **English**

> A lightweight, efficient desktop client for [frp](https://github.com/fatedier/frp), built with Rust + Tauri 2.

FRP Client is a native desktop app for managing **multiple local frpc instances** and **remote frpc** daemons, replacing frp's built-in web console. It reads and writes frpc's TOML config directly and calls frpc's webServer API, so creating, editing, deleting tunnels and making them take effect all happen in one unified interface.

A single binary of about 5 MB (compressed ~2 MB), with no runtime dependencies beyond the system webview.

## Preview

### Tunnel Manager

One tab per device; the status dot reflects each frpc console's connectivity and tunnel health in real time (green = reachable and healthy, yellow = some tunnel has errors, red = console unreachable).

![Tunnel Manager](docs/screenshots/tunnels.png)

### Config Preview

"How the App connects to this device" and "this device's own frpc config" are presented and edited separately; a backup is taken before every write and an automatic rollback happens on failure.

![Config Preview](docs/screenshots/config.png)

### Tunnel Editor

Create and edit share one dialog, with preset chips for common addresses and ports; field labels follow the UI language (中文 / English) while real TOML key names are shown alongside in small gray text.

![Tunnel Dialog](docs/screenshots/modal.png)

## Features

- **Multi-target management**: switch freely between several local frpc instances and remote frpc consoles; local instances are auto-discovered (by scanning running frpc `-c` arguments, LaunchAgent plists and common config paths)
- **Dual-mode tunnel CRUD**:
  - When frpc has `[store]` enabled (store capability is probed automatically), tunnel add/edit/delete goes straight through `/api/store` REST — **effective immediately, no restart**
  - Without store, the staged-TOML flow applies: edit locally, save once to take effect
  - Both sources are merged into one effective view (store wins on name conflicts)
- **Visual form ⇄ raw TOML**: two-way conversion between the form and TOML; switching tabs is blocked while conversion fails, and the raw text is always the single source of truth
- **Safe writes**: backup before save, atomic replace, automatic rollback if the readiness probe fails 15 seconds after restart
- **Local console-address guard**: prevents accidentally writing a remote address into the local frpc's `webServer.addr`, which would stop the service from starting
- **Runtime monitoring**: batch concurrent health checks for every device; for local frpc it also shows memory / CPU usage rings, uptime, binary version compared against the latest GitHub release (optional update check)
- **Process takeover**: any local frpc instance can be started / stopped / restarted from the App — LaunchAgent-managed ones go through `launchctl`, unmanaged ones are located by their `-c` config path, killed and relaunched; badges honestly distinguish "managed" from "standalone process"
- **AI orchestration**: describe your need in natural language ("map port 3000 via tcp to 18080, plus an http tunnel on blog.example.com") and the selected model generates tunnel drafts, written to the current device only after per-line confirmation; supports multiple OpenAI-compatible profiles (built-in DeepSeek / Kimi / Bailian / Ollama presets) with connectivity tests and a model dropdown fed by `/models`; API keys stay in the local `app.toml`, and the context sent to the model contains only public tunnel parameters — never tokens or passwords
- **Local-only credentials**: device credentials live only in `~/.config/frp-client/app.toml` (mode 0600), never uploaded and never written into your config repo
- **Logs page**: view local frpc's stdout / stderr, paged backwards from the end of the file by byte ranges, with "load earlier" appending pages without duplicates or gaps
- **Internationalization**: the UI ships in Simplified Chinese and English, switched with one click via the globe button in the sidebar and persisted to the local `app.toml`; static strings go through a dictionary while dynamic strings and all backend toasts/errors are bilingual; protocol names and real TOML key names (tcp / http / webServer, etc.) are intentionally left untranslated

## Platform Support

| Platform | Package | Notes |
| --- | --- | --- |
| macOS 12+ | `.dmg` / `.app` | Apple Silicon and Intel |
| Windows 10+ | `.msi` / `.exe` (NSIS) | x64 |
| Linux | `.deb` / `.rpm` / AppImage | x86_64 |

The Releases page provides three-platform installers built by CI (see `.github/workflows`).

## Build & Development

Prerequisites:

- [Rust](https://rustup.rs) (stable)
- Tauri 2 CLI: `cargo install tauri-cli --locked`
- Per-platform system dependencies are listed in the [official Tauri docs](https://tauri.app/start/prerequisites/); Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` etc.

```bash
# development mode (hot reload)
cargo tauri dev

# release build (produces installers)
cargo tauri build

# tests
cargo test --release
```

The frontend is a zero-build static page (`frontend/`, vanilla JS + CSS) — no Node.js toolchain required.

## How It Works

```
┌─────────────┐   webServer API    ┌──────────   control channel    ──────────┐
│  FRP Client │ ─────────────────► │   frpc   │ ────────────► │   frps   │
└─────────────┘   /api/config      └──────────┘               └──────────┘
       │          /api/store (opt)       ▲
       └──── TOML read/write + process management ────────┘
```

- For each target frpc, the App reads status and config, hot-reloads or writes new config through its `webServer` (typically 127.0.0.1:7400 or similar)
- Local instances additionally expose process-level info (PID, memory, CPU, uptime) and start / stop / restart (launchctl when managed, otherwise kill by `-c` path + relaunch)
- Remote instances are monitored and hot-reloaded only (the frpc API has no start endpoint, so remote stop is not offered)

## Design Principles

- Creating / editing a single tunnel happens inside its dialog; only the touched fields are saved, no full-page refresh
- Local-only information (usage, version, uptime) appears in exactly one place: the sidebar footer
- Remote devices never show a version (the frpc console has no version endpoint and we won't add another channel)
- UI labels follow the interface language (中文 / English), with real TOML / app.toml key names alongside in small gray text

## Roadmap

- [x] Local frpc process takeover (kill by `-c` path + relaunch)
- [x] Paged log loading
- [x] AI orchestration: tunnel config drafts from natural language (applied line by line after confirmation)
- [x] Internationalization (中文 / English, one-click switch in the sidebar, persisted locally)

## License

[MIT](LICENSE)
