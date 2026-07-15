# Kody documentation

This directory contains the design and operating documentation for Kody. Start with the architecture guide if you are changing domain behavior, or the development guide if you are setting up the repository for the first time.

| Document | Audience | Contents |
|---|---|---|
| [Architecture](architecture.md) | Runtime and client contributors | Domain ownership, agent loop, providers, persistence, processes, and security boundaries |
| [App Server protocol](app-server-protocol.md) | Client and integration authors | JSON-RPC methods, events, authentication, permission modes, and error behavior |
| [Development guide](development.md) | All contributors | Toolchain setup, common commands, tests, repository conventions, and debugging |
| [macOS release process](releasing.md) | Maintainers | Signing, notarization, release secrets, publishing, and updater behavior |
| [Desktop UI specification](../apps/desktop/UI_SPEC.md) | Desktop contributors | Product model, layout, interaction rules, visual direction, and accessibility |

The project overview and quick start live in the root [README](../README.md). A full Simplified Chinese overview is available in [README.zh-CN.md](../README.zh-CN.md).
