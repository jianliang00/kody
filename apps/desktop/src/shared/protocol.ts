export type EntityId = string

export type ThreadStatus = 'idle' | 'running' | 'archived'
export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ProjectAccess = 'read_only' | 'read_write'
export type ThreadReferenceMode = 'summary' | 'full' | 'messages' | 'artifacts'

export interface GitMetadata {
  remote?: string
  branch?: string
}

export interface Project {
  id: EntityId
  name: string
  root: string
  kind: 'directory' | 'git'
  git?: GitMetadata
  created_at: string
}

export interface Workspace {
  id: EntityId
  thread_id: EntityId
  root: string
  created_at: string
}

export type ContextReference =
  | {
      kind: 'thread'
      thread_id: EntityId
      mode: ThreadReferenceMode
      message_ids?: EntityId[]
    }
  | {
      kind: 'project'
      project_id: EntityId
      access: ProjectAccess
    }

export interface Thread {
  id: EntityId
  title: string
  workspace_id: EntityId
  status: ThreadStatus
  default_references: ContextReference[]
  summary?: string
  created_at: string
  updated_at: string
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | {
      type: 'tool_result'
      tool_call_id: string
      name: string
      content: string
      is_error: boolean
      metadata?: unknown
    }

export interface ChatMessage {
  id: EntityId
  thread_id: EntityId
  turn_id?: EntityId
  role: 'system' | 'user' | 'assistant' | 'tool'
  parts: MessagePart[]
  references: ContextReference[]
  created_at: string
}

export interface Turn {
  id: EntityId
  thread_id: EntityId
  input_message_id: EntityId
  provider: string
  model: string
  temperature?: number
  max_output_tokens?: number
  status: TurnStatus
  created_at: string
  started_at?: string
  completed_at?: string
  error?: string
}

export interface ThreadSnapshot {
  thread: Thread
  workspace: Workspace
  messages: ChatMessage[]
  turns: Turn[]
  pending_approvals: PendingApproval[]
}

export interface PendingApproval {
  approval_id: EntityId
  thread_id: EntityId
  turn_id: EntityId
  tool_call_id: string
  name: string
  arguments: unknown
  reason: string
}

export interface EventEnvelope {
  id: EntityId
  thread_id: EntityId
  turn_id: EntityId
  sequence: number
  created_at: string
  event: AgentEvent
}

export type AgentEvent =
  | { type: 'turn_started' }
  | { type: 'step_started'; step: number }
  | { type: 'model_started'; provider: string; model: string }
  | { type: 'model_output_delta'; delta: string }
  | { type: 'model_reasoning_delta'; delta: string }
  | { type: 'model_completed'; stop_reason: string }
  | {
      type: 'approval_requested'
      approval_id: EntityId
      tool_call_id: string
      name: string
      arguments: unknown
      reason: string
    }
  | { type: 'approval_resolved'; approval_id: EntityId; approved: boolean }
  | { type: 'tool_started'; tool_call_id: string; name: string; arguments: unknown }
  | {
      type: 'tool_completed'
      tool_call_id: string
      name: string
      content: string
      is_error: boolean
      metadata?: unknown
    }
  | { type: 'file_changed'; project_id?: EntityId; path: string }
  | { type: 'thread_updated'; title: string }
  | { type: 'turn_completed'; final_text: string }
  | { type: 'turn_failed'; error: string }
  | { type: 'turn_cancelled' }

export interface InitializeResult {
  server_info: { name: string; version: string }
  capabilities: Record<string, unknown>
}

export interface CreatedThread {
  thread: Thread
  workspace: Workspace
  imported_project?: Project
}

export interface StartedThread extends CreatedThread {
  turn: Turn
}

export interface StartTurnInput {
  thread_id: EntityId
  message: string
  references: ContextReference[]
  provider: string
  model?: string
}

export interface RpcMethodMap {
  initialize: { params: Record<string, never>; result: InitializeResult }
  'provider/list': { params: Record<string, never>; result: { providers: string[] } }
  'project/list': { params: Record<string, never>; result: { projects: Project[] } }
  'project/import': { params: { path: string; name?: string }; result: Project }
  'thread/list': { params: Record<string, never>; result: { threads: Thread[] } }
  'thread/create': {
    params: { title: string; working_directory?: string }
    result: CreatedThread
  }
  'thread/create-and-start': {
    params: {
      client_request_id: string
      message: string
      references: ContextReference[]
      provider: string
      model?: string
      working_directory?: string
    }
    result: StartedThread
  }
  'thread/get': { params: { thread_id: EntityId }; result: ThreadSnapshot }
  'thread/reference/add': {
    params: { thread_id: EntityId; reference: ContextReference }
    result: Thread
  }
  'turn/start': { params: StartTurnInput; result: Turn }
  'turn/cancel': { params: { turn_id: EntityId }; result: { cancelled: boolean } }
  'approval/respond': {
    params: { approval_id: EntityId; approved: boolean }
    result: { resolved: boolean }
  }
}

export type RpcMethod = keyof RpcMethodMap

export interface ServerStatus {
  phase: 'starting' | 'connected' | 'disconnected' | 'error'
  detail?: string
  /** The live stream was interrupted; clients should reload durable Thread state. */
  reconcile?: boolean
}
