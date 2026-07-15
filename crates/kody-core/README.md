# kody-core

`kody-core` is Kody's transport-independent Rust runtime. It contains the domain model, agent loop, provider abstraction, context resolver, tools, managed processes, events, and state-store interfaces.

The crate is designed to be embedded without HTTP, WebSocket, Electron, or provider-specific wire dependencies. See the repository [architecture guide](../../docs/architecture.md) and the [`custom_provider` example](examples/custom_provider.rs).

Kody is pre-1.0 and does not currently promise API compatibility between minor releases. This workspace crate is not published independently on crates.io.

Licensed under MIT or Apache-2.0, at your option.
