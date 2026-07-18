# Kody

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/jianliang00/kody/actions/workflows/ci.yml/badge.svg)](https://github.com/jianliang00/kody/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jianliang00/kody-releases?label=release)](https://github.com/jianliang00/kody-releases/releases/latest)
[![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)

Kody is a local-first coding agent platform built from scratch with Rust and Electron. It separates the agent loop, model providers, tools, persistent state, and client protocol into explicit boundaries, so the runtime can power a desktop app today and CLI, IDE, or web clients later.

> Kody is under active development. Its data model and App Server protocol are usable, but compatibility is not guaranteed before 1.0.

## Why Kody

Kody treats conversations, code assets, and execution environments as different things:

- A **Thread** is one durable, linear conversation.
- A **Project** is a reusable directory or Git repository owned by the user.
- A **Workspace** is a Thread-owned runtime directory for temporary code, logs, and artifacts.
- A **Thread reference** brings another conversation into the current context without copying it.
- A **Project reference** gives the agent explicit read-only or read-write access to a codebase.
- A **managed process** is a supervised background command that can survive across Turns while remaining owned by its Thread.

This model keeps conversation history independent from code location and makes multi-project work and cross-Thread context first-class features.

## Highlights

- Multi-step Rust agent loop with streaming model output, tool calls, cancellation, terminal state guarantees, and bounded context.
- Extensible, object-safe `ModelProvider` API with runtime provider registration and per-Turn model selection.
- Built-in OpenAI Responses and OpenAI-compatible Chat Completions adapters.
- Provider-neutral image generation with configurable image-model catalogs, an OpenAI-compatible Images adapter, durable Workspace artifacts, and in-conversation preview/download.
- Optional Codex backend that uses the official `codex app-server` protocol and the user's ChatGPT/Codex plan quota without reading or repurposing Codex credentials.
- Per-Turn permission modes: **Read only**, **Ask for commands**, and **Full access**.
- Sandboxed file-tool path resolution, explicit project access, command approvals, structured user input, and credential redaction.
- Complete managed-process lifecycle with process groups, bounded durable output, stop escalation, crash cleanup, and restart recovery.
- Versioned JSON persistence with atomic replacement and interrupted-Turn recovery.
- JSON-RPC 2.0 App Server over authenticated HTTP and WebSocket transports.
- Electron + React desktop client with provider settings, model selection, Thread/Project references, context inspection, and signed in-app updates.

## Repository layout

```text
.
├── apps/
│   └── desktop/                  # Electron main, preload, and React renderer
├── crates/
│   ├── kody-core/                # Domain model, agent loop, providers, tools, storage
│   └── kody-app-server/          # JSON-RPC server and Codex sidecar integration
├── docs/                         # Architecture, protocol, development, and release docs
├── scripts/                      # Release and update-metadata tooling
└── .github/                      # CI, release workflows, and contribution templates
```

See the [documentation index](docs/README.md) for a guided map of the project.

## Quick start

### Requirements

- Rust 1.87 or newer
- Node.js 24 and npm
- macOS, Linux, or Windows for development; signed binary releases currently target macOS

### Run the App Server

```bash
git clone https://github.com/jianliang00/kody.git
cd kody
cargo run -p kody-app-server
```

The standalone server listens on `127.0.0.1:8765` by default. For a stable client connection, provide a high-entropy token explicitly:

```bash
export KODY_SERVER_TOKEN='replace-with-a-long-random-token'
export KODY_HOME="$PWD/.kody"
cargo run -p kody-app-server
```

### Run the desktop app

```bash
npm ci
npm run desktop:dev
```

The Electron main process starts the Rust App Server on a random loopback port and owns its bearer token. Renderer code can only use the narrow, validated IPC bridge.

### Run the checks

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
npm run typecheck --workspace @kody/desktop
npm test --workspace @kody/desktop
npm run test:e2e --workspace @kody/desktop
```

More setup and debugging information is available in the [development guide](docs/development.md).

## Model providers

Desktop Settings can manage multiple named provider profiles. Every Turn selects a provider, model, and permission mode independently.

The same profile can optionally expose one or more image models. The desktop image composer selects the image provider, model, size, quality, format, and count independently from the chat model. Generated files are stored under the owning Thread Workspace's `artifacts/` directory and recorded in durable conversation state. OpenAI profiles default new configurations to `gpt-image-2`; OpenAI-compatible profiles can name any image model served by their `/images/generations` endpoint. Clearing the default image model disables image generation for that profile.

The built-in native adapters are:

- **OpenAI Responses** for streaming output, reasoning, and tool calls.
- **OpenAI-compatible Chat Completions** for compatible cloud gateways and local model servers.

The **Codex** selection is intentionally a separate external Turn backend. Kody launches the official `codex app-server` sidecar and maps its account, model, Thread, Turn, approval, tool, and structured-input events into Kody's own domain. Kody never reads `~/.codex/auth.json` or converts Codex OAuth credentials into API keys.

To implement another native provider, implement the object-safe async `ModelProvider` trait. A minimal example is in [`custom_provider.rs`](crates/kody-core/examples/custom_provider.rs).

## App Server

The server exposes JSON-RPC 2.0 at:

- `POST /v1/rpc`
- `GET /v1/artifacts/{artifact_id}`
- `GET /v1/ws` or `GET /v1/app-server`
- `GET /health`

Example:

```bash
curl http://127.0.0.1:8765/v1/rpc \
  -H "Authorization: Bearer $KODY_SERVER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Starting a Turn uses explicit execution choices:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "turn/start",
  "params": {
    "thread_id": "THREAD_UUID",
    "message": "Inspect the auth flow and fix the failing test",
    "provider": "openai",
    "model": "MODEL_ID",
    "permission_mode": "ask",
    "references": [
      {
        "kind": "project",
        "project_id": "PROJECT_UUID",
        "access": "read_write"
      }
    ]
  }
}
```

The complete method and event contract is documented in the [App Server protocol](docs/app-server-protocol.md).

## Security model

Kody is local-first, but model-initiated code execution is still security-sensitive.

- **Read only** exposes inspection tools only.
- **Ask for commands** allows file changes but requires approval for command execution.
- **Full access** skips Kody approval and, for Codex, selects an unrestricted sandbox policy.

Native shell execution is not an operating-system sandbox. Use a container or platform sandbox when running untrusted repositories. File tools enforce Workspace/Project boundaries and reject absolute paths, parent traversal, and symlink escapes. Provider credentials, server tokens, and user Cargo credentials are removed from tool and process environments.

Read [SECURITY.md](SECURITY.md) before deploying Kody beyond a single-user local machine, and report vulnerabilities privately through GitHub Security Advisories.

## Downloads and updates

Signed and notarized macOS builds are published in the public [Kody releases repository](https://github.com/jianliang00/kody-releases/releases/latest). Apple Silicon and Intel packages are provided separately. Installed builds can download later versions from the same GitHub Release feed without reinstalling the app.

## Documentation

- [Architecture](docs/architecture.md)
- [App Server protocol](docs/app-server-protocol.md)
- [Development guide](docs/development.md)
- [macOS release process](docs/releasing.md)
- [Desktop UI specification](apps/desktop/UI_SPEC.md)
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before contributing. Security reports must follow [SECURITY.md](SECURITY.md) rather than the public issue tracker.

## License

Kody is available under either of the following licenses, at your option:

- [Apache License, Version 2.0](LICENSE-APACHE)
- [MIT License](LICENSE-MIT)

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in Kody is dual-licensed on the same terms.
