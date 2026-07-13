# App Server protocol

The server exposes JSON-RPC 2.0 at:

- HTTP: `POST /v1/rpc`
- WebSocket: `GET /v1/ws` or `GET /v1/app-server`
- Health: `GET /health`

HTTP requires `Authorization: Bearer <token>` and `Content-Type: application/json`. Native WebSocket clients may use the same Authorization header or `?token=<token>`. If a WebSocket request contains `Origin`, that exact value must appear in `CODY_ALLOWED_ORIGINS`.

## Methods

| Method | Purpose |
|---|---|
| `initialize` | Server information and capabilities |
| `provider/list` | Structured, credential-free descriptors for registered Providers |
| `provider/models` | Structured model catalog for one Provider |
| `provider/health` | Sanitized health/auth reachability for one Provider |
| `provider/configure`, `provider/remove` | Privileged runtime configuration for native Providers |
| `codex/account/read`, `codex/account/rate-limits` | Codex sidecar account status and plan limits |
| `codex/account/login/start`, `codex/account/login/cancel`, `codex/account/logout` | Privileged ChatGPT account lifecycle owned by the Codex sidecar |
| `tool/list` | Model-visible tool definitions |
| `project/create` | Create a directory and import it as a Project |
| `project/import` | Import an existing directory/Git repository |
| `project/get`, `project/list` | Read Project state |
| `thread/create` | Create a Thread and its Workspace; optional `working_directory` auto-imports a Project |
| `thread/create-and-start` | Idempotently create a Thread/Workspace and prepare its first Turn from one draft request |
| `thread/get`, `thread/list`, `thread/messages` | Read Thread state/history; `thread/get` also returns pending approvals, pending structured user input, and authoritative managed-process snapshots |
| `thread/reference/add` | Add a persistent default Thread or Project reference |
| `turn/start`, `turn/get`, `turn/cancel` | Run and control an Agent Turn |
| `approval/respond` | Resolve a pending command-execution approval |
| `user-input/respond` | Resolve or cancel a pending structured question without persisting answer values |
| `process/list`, `process/get` | Read managed processes owned by a Thread |
| `process/read-output` | Read a bounded stdout/stderr page from a byte cursor |
| `process/stop` | Gracefully stop a process group, escalating if necessary |
| `thread/subscribe`, `thread/unsubscribe` | WebSocket-only event subscription controls |

Dot aliases such as `turn.start` are accepted for application methods. WebSocket `thread/create-and-start` subscribes before the prepared Turn begins; `turn/start`, `thread/get`, `thread/messages`, and all process methods also implicitly subscribe that connection to the Thread.

`provider/configure`, `provider/remove`, `provider/health`, and all `codex/account/*` methods are privileged control-plane methods. They still require the App Server Bearer Token, and the Electron generic Renderer RPC bridge intentionally excludes them. The desktop main process exposes only narrow, validated settings/account IPC operations. A newly entered API key crosses a dedicated write request once, but persisted keys are never returned to Renderer web content; App Server and Codex credentials never cross that boundary.

## Provider and model catalogs

`provider/list` returns public descriptors rather than bare IDs:

```json
{
  "providers": [
    {
      "id": "team-openai",
      "display_name": "Team OpenAI",
      "kind": "openai_responses",
      "auth": "configured",
      "capabilities": {
        "streaming": true,
        "reasoning": true,
        "tools": true,
        "model_catalog": true,
        "custom_models": true
      },
      "default_model": "gpt-example"
    },
    {
      "id": "codex",
      "display_name": "Codex (ChatGPT account)",
      "kind": "codex_app_server",
      "auth": "configured",
      "capabilities": {
        "streaming": true,
        "reasoning": true,
        "tools": true,
        "model_catalog": true,
        "custom_models": false
      }
    }
  ]
}
```

Authentication states are `not_required`, `configured`, `missing`, or `unknown`. Capability flags are presentation/discovery hints, not authorization. `provider/models` takes `{"provider_id":"team-openai"}` and returns:

```json
{
  "models": [
    {
      "id": "gpt-example",
      "display_name": "GPT Example",
      "is_default": true,
      "description": "General coding model",
      "default_reasoning_effort": "medium",
      "reasoning_efforts": ["low", "medium", "high"],
      "owned_by": "openai",
      "created_at": 1780000000
    }
  ]
}
```

Only `id`, `display_name`, and `is_default` are guaranteed; the remaining model metadata is optional. Model IDs are opaque and must be returned unchanged in `turn/start` or `thread/create-and-start`. If a Turn omits `model`, the selected Provider must advertise a `default_model`; otherwise preparation fails.

The privileged native Provider configuration request is:

```json
{
  "jsonrpc": "2.0",
  "id": "configure-provider",
  "method": "provider/configure",
  "params": {
    "id": "team-openai",
    "display_name": "Team OpenAI",
    "kind": "openai",
    "base_url": "https://api.openai.com/v1",
    "api_key": "WRITE_ONLY_SECRET",
    "default_model": "gpt-example",
    "custom_models": ["gpt-example"]
  }
}
```

`kind: "openai"` selects the streaming OpenAI Responses adapter. `kind: "openai-compatible"` selects bounded, non-streaming `/chat/completions` and requires `base_url`. The response is the public Provider descriptor and never echoes `api_key`. Reconfiguring an ID atomically replaces it for future Turns; a queued/running Turn retains its original adapter lease. `echo` and `codex` are built-ins and cannot be configured, replaced, or removed through these methods. `provider/remove` takes `{"provider_id":"team-openai"}` and returns `{"removed":true}`.

`provider/health` takes the same `provider_id` shape and returns a sanitized object such as `{"status":"healthy"}` or `{"status":"unavailable","message":"..."}`. Status values are `healthy`, `degraded`, and `unavailable`.

## Codex account and execution backend

The `codex` catalog entry is backed by the official `codex app-server`; it is not a raw `ModelProvider.complete` implementation. Selecting `provider: "codex"` routes the whole Turn through the external backend, which starts or resumes an opaque Codex Thread, passes the explicitly selected model and bounded Cody context, and bridges Codex messages, reasoning, tools, file changes, approvals, and structured questions into Cody events.

The account authority remains inside the official sidecar. Cody never reads `~/.codex/auth.json`, receives OAuth/refresh tokens, or treats a ChatGPT token as an API key. `codex/account/login/start` supports `{"mode":"browser"}` and `{"mode":"device_code"}`. Browser results include `login_id` and `auth_url`; device-code results include `login_id`, `user_code`, and `verification_url`. Trusted clients must allowlist the returned OpenAI/ChatGPT HTTPS host before opening it. A login can be cancelled with `{"login_id":"..."}`, and `codex/account/logout` takes `{}`.

`codex/account/read` returns only public account metadata, whether OpenAI authentication is required, and the selected binary path/version. `codex/account/rate-limits` returns the sidecar's structured plan limits. When signed in with ChatGPT, Codex Turns consume the Codex quota available to that account; separately configured API-key Providers remain API-usage based.

Binary selection and the `fast`/`flex` service-tier override are trusted host configuration (`CODY_CODEX_PATH`, `CODY_CODEX_SERVICE_TIER`), not JSON-RPC or Renderer options.

## Draft-first Thread creation

Desktop clients should keep a new conversation entirely local until the first message. Send that message with a stable `client_request_id`:

```json
{
  "jsonrpc": "2.0",
  "id": "start-draft",
  "method": "thread/create-and-start",
  "params": {
    "client_request_id": "LOCAL_DRAFT_UUID",
    "message": "Implement OAuth login",
    "provider": "openai",
    "model": "gpt-example",
    "working_directory": "/absolute/path/to/repo",
    "references": []
  }
}
```

The result contains `thread`, `workspace`, optional `imported_project`, and `turn`. Concurrent retries with the same request ID and payload return the same entities in their latest durable state and do not execute another Turn; reusing the ID with another payload is rejected. If Turn preparation fails, entities created by this request are compensated before the error is returned. The process-local idempotency record is intentionally not a cross-restart transaction log. The placeholder title is replaced after the first completed Turn; `thread_updated` announces the generated title.

## References

Thread reference shapes are intentionally flat:

```json
{"kind":"thread","thread_id":"UUID","mode":"summary"}
{"kind":"thread","thread_id":"UUID","mode":"full"}
{"kind":"thread","thread_id":"UUID","mode":"artifacts"}
{
  "kind":"thread",
  "thread_id":"UUID",
  "mode":"messages",
  "message_ids":["MESSAGE_UUID"]
}
```

Project references are:

```json
{"kind":"project","project_id":"UUID","access":"read_only"}
{"kind":"project","project_id":"UUID","access":"read_write"}
```

## Turn events

Events are WebSocket JSON-RPC notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "turn/event",
  "params": {
    "id": "EVENT_UUID",
    "thread_id": "THREAD_UUID",
    "turn_id": "TURN_UUID",
    "sequence": 4,
    "created_at": "2026-07-12T10:00:00Z",
    "event": {
      "type": "model_output_delta",
      "delta": "Inspecting the project"
    }
  }
}
```

Event types currently include:

- `turn_started`, `step_started`
- `model_started`, `model_output_delta`, `model_reasoning_delta`, `model_completed`
- `approval_requested`, `approval_resolved`
- `user_input_requested`, `user_input_resolved`
- `tool_started`, `tool_completed`, `file_changed`
- `thread_updated`
- `turn_completed`, `turn_failed`, `turn_cancelled`

When `approval_requested` arrives, respond with:

```json
{
  "jsonrpc": "2.0",
  "id": "approve-1",
  "method": "approval/respond",
  "params": {
    "approval_id": "APPROVAL_UUID",
    "approved": true
  }
}
```

Events are live and held in a bounded process-local broadcast buffer. They are not replayed after reconnect/restart; use `thread/get` and `turn/get` to reconcile state. `thread/get.pending_approvals` contains actionable approvals still waiting in the current server process, so a renderer reconnect does not strand a Turn. A full server restart fails interrupted Turns during recovery, so no stale approval remains actionable. A slow subscriber receives `server/event_gap` with `stream: "turn"` and the skipped count.

## Structured user input

An external backend may pause a Turn; the `event` field of its `turn/event` envelope contains a reconnectable request:

```json
{
  "type": "user_input_requested",
  "interaction_id": "INTERACTION_UUID",
  "item_id": "BACKEND_ITEM_ID",
  "questions": [
    {
      "id": "deployment",
      "header": "Target",
      "question": "Which deployment target should be used?",
      "is_other": true,
      "is_secret": false,
      "options": [
        {"label":"Staging","description":"Deploy to the staging environment"},
        {"label":"Production","description":"Deploy to production"}
      ]
    }
  ]
}
```

If the live event was missed, the same public metadata appears in `thread/get.pending_user_inputs`. Submitted answers never appear there. Resolve the request with a complete question-ID map:

```json
{
  "jsonrpc": "2.0",
  "id": "answer-1",
  "method": "user-input/respond",
  "params": {
    "interaction_id": "INTERACTION_UUID",
    "answers": {
      "deployment": {"answers":["Staging"]}
    },
    "cancelled": false
  }
}
```

To cancel, send `"answers": {}` and `"cancelled": true`. The server validates bounds, question coverage, and offered choices without including answer values in validation errors. It removes the answer from broker state before delivering it through a private one-shot channel to the waiting backend. `user_input_resolved` contains only `interaction_id` and `cancelled`; secret and non-secret answers are never copied into events, Thread snapshots, or conversation persistence.

## Managed process events and output

Managed processes can outlive the Turn that started them, so they use a separate notification and sequence space:

```json
{
  "jsonrpc": "2.0",
  "method": "process/event",
  "params": {
    "id": "EVENT_UUID",
    "thread_id": "THREAD_UUID",
    "process_id": "PROCESS_UUID",
    "sequence": 3,
    "created_at": "2026-07-13T10:00:00Z",
    "event": {
      "type": "output",
      "stream": "stderr",
      "cursor": 12,
      "next_cursor": 18
    }
  }
}
```

Lifecycle types are `started`, `stopping`, `exited`, `stopped`, `failed`, and `lost`; `output` only announces an available byte range so the event buffer never duplicates command output. Cursors count bytes across the merged stdout/stderr stream. Clients call `process/read-output` with the previous `next_cursor`; its chunks carry exact bytes plus a lossy UTF-8 convenience string. The response also reports `start_cursor`, `end_cursor`, `has_more`, and whether the requested cursor was evicted. `thread/get.processes[*].output_truncated` separately records whether any earlier bytes have been evicted.

Output notifications are hints, not an unbounded transport log. Reconnect and `server/event_gap` with `stream: "process"` are reconciled through `thread/get` plus `process/read-output`.

## Errors

The server uses standard JSON-RPC codes where applicable:

- `-32700`: parse error
- `-32600`: invalid request
- `-32601`: method not found
- `-32602`: invalid params
- `-32603`: internal error
- `-32004`: entity/provider/tool not found
- `-32009`: state conflict
- `-32020`: Provider failure
- `-32021`: tool failure
- `-32800`: cancelled
