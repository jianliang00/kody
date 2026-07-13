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
| `provider/list` | Registered Provider IDs |
| `tool/list` | Model-visible tool definitions |
| `project/create` | Create a directory and import it as a Project |
| `project/import` | Import an existing directory/Git repository |
| `project/get`, `project/list` | Read Project state |
| `thread/create` | Create a Thread and its Workspace; optional `working_directory` auto-imports a Project |
| `thread/create-and-start` | Idempotently create a Thread/Workspace and prepare its first Turn from one draft request |
| `thread/get`, `thread/list`, `thread/messages` | Read Thread state/history; `thread/get` also returns current pending approvals |
| `thread/reference/add` | Add a persistent default Thread or Project reference |
| `turn/start`, `turn/get`, `turn/cancel` | Run and control an Agent Turn |
| `approval/respond` | Resolve a pending Shell approval |
| `thread/subscribe`, `thread/unsubscribe` | WebSocket-only event subscription controls |

Dot aliases such as `turn.start` are accepted for application methods. WebSocket `thread/create-and-start` subscribes before the prepared Turn begins; `turn/start`, `thread/get`, and `thread/messages` also implicitly subscribe that connection to the Thread.

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
- `model_started`, `model_output_delta`, `model_completed`
- `approval_requested`, `approval_resolved`
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

Events are live and held in a bounded process-local broadcast buffer. They are not replayed after reconnect/restart; use `thread/get` and `turn/get` to reconcile state. `thread/get.pending_approvals` contains actionable approvals still waiting in the current server process, so a renderer reconnect does not strand a Turn. A full server restart fails interrupted Turns during recovery, so no stale approval remains actionable. A slow subscriber may receive `server/event_gap` with the skipped count.

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
