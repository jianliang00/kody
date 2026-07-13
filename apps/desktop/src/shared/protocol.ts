export type EntityId = string

export type ThreadStatus = 'idle' | 'running' | 'archived'
export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ProjectAccess = 'read_only' | 'read_write'
export type ThreadReferenceMode = 'summary' | 'full' | 'messages' | 'artifacts'
export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'stopped' | 'failed' | 'lost'
export type ProcessOutputStream = 'stdout' | 'stderr'
export type ProviderAuthState = 'not_required' | 'configured' | 'missing' | 'unknown'

export interface ProviderCapabilities {
  streaming: boolean
  reasoning: boolean
  tools: boolean
  model_catalog: boolean
  custom_models: boolean
}

/** Public provider metadata. Credentials never cross the app-server boundary. */
export interface ProviderDescriptor {
  id: string
  display_name: string
  kind: string
  auth: ProviderAuthState
  capabilities: ProviderCapabilities
  default_model?: string
}

export interface ModelDescriptor {
  id: string
  display_name: string
  owned_by?: string
  created_at?: number
  is_default?: boolean
  description?: string
  default_reasoning_effort?: string
  reasoning_efforts?: string[]
}

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
  external_thread_ids?: Record<string, string>
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

export interface ProcessOrigin {
  turn_id: EntityId
  tool_call_id: string
}

/** Durable lifecycle metadata for a command supervised by Kody. */
export interface ManagedProcess {
  id: EntityId
  thread_id: EntityId
  origin: ProcessOrigin
  spec_fingerprint: string
  project_id?: EntityId
  command: string
  cwd: string
  pid?: number
  process_group_id?: number
  status: ProcessStatus
  exit_code?: number
  error?: string
  output_truncated: boolean
  output_start_cursor: number
  output_end_cursor: number
  last_event_sequence: number
  created_at: string
  started_at?: string
  completed_at?: string
}

export interface ProcessOutputChunk {
  stream: ProcessOutputStream
  cursor: number
  next_cursor: number
  bytes: number[]
  text: string
}

/** A bounded page from the merged stdout/stderr stream. */
export interface ProcessOutputPage {
  process_id: EntityId
  requested_cursor: number
  start_cursor: number
  next_cursor: number
  end_cursor: number
  truncated: boolean
  has_more: boolean
  chunks: ProcessOutputChunk[]
}

export interface ProcessEventEnvelope {
  id: EntityId
  thread_id: EntityId
  process_id: EntityId
  sequence: number
  created_at: string
  event: ProcessEvent
}

export type ProcessEvent =
  | { type: 'started'; pid: number; process_group_id?: number }
  | {
      type: 'output'
      stream: ProcessOutputStream
      cursor: number
      next_cursor: number
    }
  | { type: 'stopping' }
  | { type: 'exited'; exit_code?: number }
  | { type: 'stopped'; exit_code?: number; forced: boolean }
  | { type: 'failed'; error: string }
  | { type: 'lost'; reason: string }

export interface ThreadSnapshot {
  thread: Thread
  workspace: Workspace
  messages: ChatMessage[]
  turns: Turn[]
  pending_approvals: PendingApproval[]
  pending_user_inputs: PendingUserInput[]
  processes: ManagedProcess[]
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

export interface UserInputOption {
  label: string
  description: string
}

export interface UserInputQuestion {
  id: string
  header: string
  question: string
  is_other: boolean
  is_secret: boolean
  options?: UserInputOption[]
}

/** Reconnectable question metadata. Submitted answers are never stored here. */
export interface PendingUserInput {
  interaction_id: EntityId
  thread_id: EntityId
  turn_id: EntityId
  item_id: string
  questions: UserInputQuestion[]
}

export interface UserInputAnswer {
  answers: string[]
}

export type UserInputAnswers = Record<string, UserInputAnswer>

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
  | {
      type: 'user_input_requested'
      interaction_id: EntityId
      item_id: string
      questions: UserInputQuestion[]
    }
  | { type: 'user_input_resolved'; interaction_id: EntityId; cancelled: boolean }
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
  'provider/list': { params: Record<string, never>; result: { providers: ProviderDescriptor[] } }
  'provider/models': {
    params: { provider_id: string }
    result: { models: ModelDescriptor[] }
  }
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
  'user-input/respond': {
    params: { interaction_id: EntityId; answers: UserInputAnswers; cancelled: boolean }
    result: { resolved: boolean }
  }
  'process/list': {
    params: { thread_id: EntityId }
    result: { processes: ManagedProcess[] }
  }
  'process/get': {
    params: { thread_id: EntityId; process_id: EntityId }
    result: ManagedProcess
  }
  'process/read-output': {
    params: { thread_id: EntityId; process_id: EntityId; after_cursor?: number; limit?: number }
    result: ProcessOutputPage
  }
  'process/stop': {
    params: { thread_id: EntityId; process_id: EntityId }
    result: ManagedProcess
  }
}

export type RpcMethod = keyof RpcMethodMap

export interface ServerStatus {
  phase: 'starting' | 'connected' | 'disconnected' | 'error'
  detail?: string
  /** The live stream was interrupted; clients should reload durable Thread state. */
  reconcile?: boolean
}
