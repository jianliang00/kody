# Development guide

## Prerequisites

- Rust 1.87 or newer. The pinned channel and components are defined in `rust-toolchain.toml`.
- Node.js 24 and npm.
- Git.
- Platform build tools required by Electron and Rust.

macOS release builds additionally require Xcode command-line tools, a Developer ID Application identity, and App Store Connect notarization credentials. Ordinary development builds do not.

## Bootstrap

```bash
git clone https://github.com/jianliang00/kody.git
cd kody
npm ci
cargo build --workspace
```

## Run locally

Run the Rust App Server by itself:

```bash
KODY_HOME="$PWD/.kody" cargo run -p kody-app-server
```

Run the Electron desktop app with live reload:

```bash
npm run desktop:dev
```

The desktop main process builds or locates `kody-app-server`, starts it on a random loopback port, and connects through an authenticated private control channel.

## Test and lint

Run the same checks as CI before opening a pull request:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
npm run typecheck --workspace @kody/desktop
npm test --workspace @kody/desktop
npm run test:e2e --workspace @kody/desktop
```

The Electron end-to-end test builds a development App Server and desktop bundle before launching the app. On headless Linux, CI runs it through Xvfb.

Useful focused commands:

```bash
cargo test -p kody-core --test agent_loop
cargo test -p kody-app-server --test network_boundary
npm test --workspace @kody/desktop -- Composer
```

The ignored `codex_execution_live` test launches a real installed Codex sidecar and may consume account quota. Run it only when intentionally validating the integration:

```bash
cargo test -p kody-app-server --test codex_execution_live -- --ignored --nocapture
```

## Repository conventions

- `kody-core` must remain transport-independent. HTTP, WebSocket, Electron, and Codex wire concerns belong outside it.
- Provider-specific payloads stay inside provider adapters. Runtime and tools consume provider-neutral types.
- A Thread owns one Workspace; Projects remain independent reusable assets.
- Persisted domain changes require serde defaults or an explicit state-version migration.
- Renderer code never receives provider secrets, the App Server bearer token, or Codex credentials.
- Commands that outlive one tool call must use the Process Manager rather than shell backgrounding.
- New RPCs require protocol types, server dispatch, authorization/validation, durable tests, and documentation.
- UI changes must preserve keyboard operation, visible focus, narrow-window behavior, and light/dark contrast.

## Local state

By default the standalone server stores state under `.kody` in the current directory. Set `KODY_HOME` to isolate test or development instances. The directory may contain conversation content and managed-process logs; do not commit it.

Electron stores its application state in the platform user-data directory. Provider API keys use Electron `safeStorage` and are never returned to the renderer after saving.

## Debugging

Rust logging uses `tracing`. Set `RUST_LOG` for more detail:

```bash
RUST_LOG=kody_app_server=debug,kody_core=debug cargo run -p kody-app-server
```

If the desktop cannot start the server, run the server build command directly and inspect the terminal output:

```bash
npm run build:server:dev --workspace @kody/desktop
```

For protocol debugging, call `initialize` over HTTP first, then use a WebSocket client for subscriptions and streamed Turn events. Never place real API keys or bearer tokens in issue reports or test fixtures.

## Packaging

After changing `apps/desktop/build/icon.svg`, regenerate the macOS ICNS without flattening its transparent corners:

```bash
npm run icon:mac
```

Create an unpacked desktop application:

```bash
npm run desktop:package
```

Maintainer-only signed and notarized publishing is documented in [releasing.md](releasing.md).
