# Architecture

## Boundaries

```mermaid
flowchart LR
    Client["CLI / Desktop / IDE"] -->|"JSON-RPC HTTP or WS"| Server["cody-app-server"]
    Server --> Engine["CodyEngine"]
    Engine --> Runtime["AgentRuntime"]
    Runtime --> Context["ContextBuilder"]
    Runtime --> Providers["ProviderRegistry"]
    Runtime --> Tools["ToolRegistry"]
    Runtime --> Events["EventHub"]
    Tools --> Processes["ProcessManager"]
    Processes --> ProcessEvents["ProcessEventHub"]
    Processes --> ProcessLogs["bounded durable logs"]
    Context --> Store["StateStore"]
    Runtime --> Store
    Processes --> Store
    Store --> Json["atomic state.json"]
    Events -->|"turn/event"| Client
    ProcessEvents -->|"process/event"| Client
```

`cody-core` does not depend on HTTP or WebSocket. The App Server is a transport adapter over `CodyEngine`, so a desktop application can embed the engine and subscribe to the same events directly.

## Domain relationships

```mermaid
erDiagram
    THREAD ||--|| WORKSPACE : owns
    THREAD ||--o{ TURN : contains
    THREAD ||--o{ MESSAGE : records
    THREAD ||--o{ MANAGED_PROCESS : owns
    TURN ||--o{ MANAGED_PROCESS : originates
    PROJECT o|--o{ MANAGED_PROCESS : runs_in
    TURN ||--|| MESSAGE : input
    MESSAGE }o--o{ THREAD : references
    MESSAGE }o--o{ PROJECT : references
```

The important ownership rules are:

1. A Thread owns exactly one Workspace. Project paths are never repurposed as the Workspace.
2. A Project is a durable user asset and may be referenced by many Threads.
3. References are stored on the user message where they were mentioned. Later turns fold earlier references into the Thread context. A Project supplied during `thread/create` is stored in `Thread.default_references`.
4. Referenced Thread messages are resolved at prompt-build time and remain owned by their source Thread.
5. A Thread has at most one active Turn. Store-level compare-and-set transitions enforce this independently of the server task map.
6. A desktop draft is not a domain entity. `thread/create-and-start` materializes Thread, Workspace, optional Project, user Message, and first Turn only on Send; its client request ID is process-locally idempotent.
7. A Managed Process belongs to one Thread and records the Turn/tool-call origin that created it. Its lifecycle is independent from that Turn, so cancellation never implicitly kills a successfully started process.

## Agent loop

```mermaid
flowchart TD
    Prepare["Validate input and atomically claim Thread"] --> Context["Resolve history, references, projects"]
    Context --> Model["Provider.complete"]
    Model --> Validate["Validate neutral model response"]
    Validate --> Calls{"Tool calls?"}
    Calls -->|No| Complete["Atomically complete Turn"]
    Calls -->|Yes| Approval{"Command-execution approval required?"}
    Approval -->|Denied| Observation["Persist denied ToolResult"]
    Approval -->|Approved / not needed| Execute["Execute bounded tool"]
    Execute --> Observation["Persist ToolResult"]
    Observation --> Context
```

Every model/tool/terminal transition emits a sequenced `EventEnvelope`. Cancellation is checked before provider calls, after provider responses, while waiting for approval, and inside built-in tools. Provider and tool panics inside the loop are converted into a failed Turn; terminal cleanup releases the Thread reservation.

After the first successful Turn, title enrichment runs outside the terminal path. `ThreadTitleGenerator` is replaceable by a provider-backed implementation, while the deterministic local generator is always available as fallback. A title failure never changes the completed Turn result.

## Managed process lifecycle

`start_process` is an explicit model tool rather than shell syntax hidden behind `&`. The manager assigns one actor to each child, starts it in an independent Unix process group, continuously drains both output pipes, and persists a bounded binary log addressed by byte cursor. A forked parent-death guardian sits in its own session and watches a CLOEXEC lifeline; if the app server crashes or is force-killed, the guardian kills the registered process group. `list_processes`, `read_process_output`, and `stop_process` complete the model-visible lifecycle; equivalent read/stop RPCs serve clients.

Process events have a per-process sequence and a separate broadcast channel, so long-running output cannot consume the bounded Turn event buffer. Lifecycle notifications trigger a durable `thread/get` reconciliation, while output notifications only advance a cursor; clients fetch bytes in bounded pages. A graceful app-server shutdown cancels active Turns first, then sends `SIGTERM` to every managed group and escalates to `SIGKILL` after the configured grace period.

The command must remain in the foreground of its managed process group. The supervisor owns crash cleanup and treats output pipes that do not close within the bounded drain period as a lifecycle failure rather than hanging shutdown indefinitely.

## Provider abstraction

`ModelProvider` consumes provider-neutral `ModelRequest` values and returns `ModelResponse`. Provider-specific authentication, URL formats and wire payloads remain inside the adapter. `ModelDeltaSink` allows a streaming Provider to emit text/tool deltas while non-streaming Providers can emit their completed output through the same path.

Provider selection and model selection are separate:

- `provider` selects a registered adapter instance.
- `model` is opaque to the core and passed to that adapter.
- If omitted, `ModelProvider::default_model` is used.

## Context construction

The default builder combines:

1. System instructions and authoritative Workspace/Project bindings.
2. Direct referenced Thread data as prior user-level JSON reference messages.
3. The current Thread's linear message history.

Referenced content is never inserted into the system instruction and is JSON escaped to reduce delimiter/prompt-injection elevation. Current history is retained in complete Turn groups so a ToolResult is not separated from its ToolCall. Independent budgets cap current history, each reference, total reference material, and reference counts.

## State and recovery

`JsonFileStore` uses an in-memory candidate for each mutation, validates it, writes a versioned same-directory temporary snapshot, calls `fsync`, atomically renames it, then publishes the candidate to readers. A failed write leaves live state unchanged. On startup, malformed snapshots and broken relationships fail closed.

If the app server stopped after a Turn was queued or running, `CodyEngine::new` marks that Turn failed with a restart reason and returns its Thread to idle. Managed process metadata is recovered independently: an active record from an interrupted runtime becomes `Lost` and an old PID is never re-adopted or signalled, avoiding PID-reuse hazards. Process output lives outside `state.json` in a bounded, permission-restricted log.

For multi-process or remote deployments, implement the same `StateStore` trait with transactional compare-and-set semantics in SQLite/Postgres rather than sharing the JSON file.
