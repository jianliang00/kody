# kody-app-server

`kody-app-server` exposes the Kody runtime through authenticated JSON-RPC 2.0 over HTTP and WebSocket. It also owns the optional integration with the official Codex app-server sidecar.

```bash
KODY_SERVER_TOKEN='replace-with-a-long-random-token' cargo run -p kody-app-server
```

See the [App Server protocol](../../docs/app-server-protocol.md), [development guide](../../docs/development.md), and root [README](../../README.md).

Kody is pre-1.0 and does not currently promise protocol compatibility between minor releases. This workspace crate is not published independently on crates.io.

Licensed under MIT or Apache-2.0, at your option.
