import type {
  CodexAccountStatus,
  KodyDesktopBridge,
  ProviderProfileRecord
} from '@shared/bridge'
import type {
  ChatMessage,
  ContextReference,
  EventEnvelope,
  ManagedProcess,
  ProcessEventEnvelope,
  Project,
  RpcMethod,
  RpcMethodMap,
  ServerStatus,
  Thread,
  ThreadSnapshot,
  Turn
} from '@shared/protocol'

const now = Date.now()
const iso = (offsetMinutes = 0): string => new Date(now + offsetMinutes * 60_000).toISOString()
const id = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`

const seedProjects: Project[] = [
  {
    id: 'project-kody',
    name: 'kody',
    root: '/Users/demo/Code/kody',
    kind: 'git',
    git: { remote: 'github.com/example/kody', branch: 'ui/electron-shell' },
    created_at: iso(-14_400)
  },
  {
    id: 'project-atlas',
    name: 'atlas-api',
    root: '/Users/demo/Code/atlas-api',
    kind: 'git',
    git: { remote: 'github.com/example/atlas-api', branch: 'main' },
    created_at: iso(-8_200)
  },
  {
    id: 'project-notes',
    name: 'product-notes',
    root: '/Users/demo/Documents/product-notes',
    kind: 'directory',
    created_at: iso(-3_200)
  }
]

const seedThreads: Thread[] = [
  {
    id: 'thread-electron',
    title: 'Shape the Electron workspace',
    workspace_id: 'workspace-electron',
    status: 'idle',
    default_references: [
      { kind: 'project', project_id: 'project-kody', access: 'read_write' }
    ],
    summary: 'A focused pass on the desktop shell, bridge boundary, and renderer experience.',
    created_at: iso(-1_520),
    updated_at: iso(-8)
  },
  {
    id: 'thread-agent-loop',
    title: 'Design the agent loop',
    workspace_id: 'workspace-loop',
    status: 'idle',
    default_references: [],
    summary: 'Provider-neutral model turns, tool execution, approvals, and terminal states.',
    created_at: iso(-4_200),
    updated_at: iso(-1_400)
  },
  {
    id: 'thread-context',
    title: 'Context reference semantics',
    workspace_id: 'workspace-context',
    status: 'idle',
    default_references: [],
    summary: 'Thread and Project mentions remain independent, explicit, and composable.',
    created_at: iso(-3_800),
    updated_at: iso(-2_000)
  }
]

const seedMessages: ChatMessage[] = [
  {
    id: 'message-electron-user',
    thread_id: 'thread-electron',
    turn_id: 'turn-electron-1',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Create a calm desktop workspace that keeps conversations and code assets independent.'
      }
    ],
    references: [
      { kind: 'thread', thread_id: 'thread-context', mode: 'summary' },
      { kind: 'project', project_id: 'project-kody', access: 'read_write' }
    ],
    created_at: iso(-20)
  },
  {
    id: 'message-electron-assistant',
    thread_id: 'thread-electron',
    turn_id: 'turn-electron-1',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text:
          'I mapped the experience around three independent surfaces:\n\n- **Assets** for durable Threads and reusable Projects\n- **Conversation** for the linear working record\n- **Context** for the ephemeral Workspace, references, and activity\n\nThe composer treats `@thread` and `@project` as structured context, so the visible prompt stays readable while access remains explicit.'
      }
    ],
    references: [],
    created_at: iso(-8)
  }
]

const seedTurns: Turn[] = [
  {
    id: 'turn-electron-1',
    thread_id: 'thread-electron',
    input_message_id: 'message-electron-user',
    provider: 'echo',
    model: 'kody-demo',
    status: 'completed',
    created_at: iso(-20),
    started_at: iso(-20),
    completed_at: iso(-8)
  }
]

interface PendingApproval {
  approvalId: string
  turnId: string
  threadId: string
  command: string
  toolCallId: string
  resolved: boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function pathName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Imported project'
}

function createMockStore() {
  const projects = clone(seedProjects)
  const threads = clone(seedThreads)
  const snapshots = new Map<string, ThreadSnapshot>()
  const events = new Set<(event: EventEnvelope) => void>()
  const processEvents = new Set<(event: ProcessEventEnvelope) => void>()
  const statusListeners = new Set<(status: ServerStatus) => void>()
  const timers = new Map<string, number[]>()
  const approvals = new Map<string, PendingApproval>()
  const sequence = new Map<string, number>()
  const startedRequests = new Map<string, RpcMethodMap['thread/create-and-start']['result']>()

  for (const thread of threads) {
    snapshots.set(thread.id, {
      thread,
      workspace: {
        id: thread.workspace_id,
        thread_id: thread.id,
        root: `/tmp/kody/workspaces/${thread.id}`,
        created_at: thread.created_at
      },
      messages: thread.id === 'thread-electron' ? clone(seedMessages) : [],
      turns: thread.id === 'thread-electron' ? clone(seedTurns) : [],
      pending_approvals: [],
      pending_user_inputs: [],
      processes: []
    })
  }

  const emit = (threadId: string, turnId: string, event: EventEnvelope['event']): void => {
    const nextSequence = (sequence.get(turnId) ?? 0) + 1
    sequence.set(turnId, nextSequence)
    const envelope: EventEnvelope = {
      id: id('event'),
      thread_id: threadId,
      turn_id: turnId,
      sequence: nextSequence,
      created_at: new Date().toISOString(),
      event
    }
    events.forEach((listener) => listener(clone(envelope)))
  }

  const emitProcess = (
    process: ManagedProcess,
    event: ProcessEventEnvelope['event']
  ): void => {
    process.last_event_sequence += 1
    const envelope: ProcessEventEnvelope = {
      id: id('process-event'),
      thread_id: process.thread_id,
      process_id: process.id,
      sequence: process.last_event_sequence,
      created_at: new Date().toISOString(),
      event
    }
    processEvents.forEach((listener) => listener(clone(envelope)))
  }

  const schedule = (turnId: string, delay: number, callback: () => void): void => {
    const timer = window.setTimeout(callback, delay)
    timers.set(turnId, [...(timers.get(turnId) ?? []), timer])
  }

  const clearTurnTimers = (turnId: string): void => {
    for (const timer of timers.get(turnId) ?? []) window.clearTimeout(timer)
    timers.delete(turnId)
  }

  const finish = (threadId: string, turnId: string, response: string): void => {
    const snapshot = snapshots.get(threadId)
    if (!snapshot) return
    const turn = snapshot.turns.find((item) => item.id === turnId)
    if (!turn || turn.status === 'cancelled') return

    turn.status = 'completed'
    turn.completed_at = new Date().toISOString()
    snapshot.thread.status = 'idle'
    snapshot.thread.updated_at = turn.completed_at
    let generatedTitle: string | undefined
    if (snapshot.thread.title === 'New thread') {
      const firstPrompt = snapshot.messages
        .find((message) => message.role === 'user')
        ?.parts.find((part) => part.type === 'text')
      if (firstPrompt?.type === 'text') {
        generatedTitle = Array.from(firstPrompt.text.trim().split(/\r?\n/, 1)[0] ?? '')
          .slice(0, 60)
          .join('') || 'New thread'
        snapshot.thread.title = generatedTitle
      }
    }
    snapshot.messages.push({
      id: id('message'),
      thread_id: threadId,
      turn_id: turnId,
      role: 'assistant',
      parts: [{ type: 'text', text: response }],
      references: [],
      created_at: turn.completed_at
    })
    emit(threadId, turnId, { type: 'model_output_delta', delta: response })
    emit(threadId, turnId, { type: 'model_completed', stop_reason: 'end_turn' })
    emit(threadId, turnId, { type: 'turn_completed', final_text: response })
    if (generatedTitle && generatedTitle !== 'New thread') {
      emit(threadId, turnId, { type: 'thread_updated', title: generatedTitle })
    }
    clearTurnTimers(turnId)
  }

  const runTurn = (threadId: string, turnId: string, prompt: string): void => {
    emit(threadId, turnId, { type: 'turn_started' })
    schedule(turnId, 180, () => emit(threadId, turnId, { type: 'step_started', step: 1 }))
    schedule(turnId, 360, () =>
      emit(threadId, turnId, { type: 'model_started', provider: 'echo', model: 'kody-demo' })
    )
    schedule(turnId, 640, () =>
      emit(threadId, turnId, {
        type: 'model_reasoning_delta',
        delta: 'Inspecting the active references and current workspace…'
      })
    )

    const requiresApproval = /shell|command|cargo|test|build/i.test(prompt)
    if (requiresApproval) {
      const approvalId = id('approval')
      const command = prompt.toLocaleLowerCase().includes('build') ? 'cargo build --workspace' : 'cargo test --workspace'
      approvals.set(approvalId, {
        approvalId,
        turnId,
        threadId,
        command,
        toolCallId: id('tool-call'),
        resolved: false
      })
      schedule(turnId, 980, () =>
        emit(threadId, turnId, {
          type: 'approval_requested',
          approval_id: approvalId,
          tool_call_id: approvals.get(approvalId)?.toolCallId ?? `tool-${approvalId}`,
          name: 'shell',
          arguments: { command, cwd: '/Users/demo/Code/kody' },
          reason: 'This command executes inside the referenced Project and may create build artifacts.'
        })
      )
      return
    }

    schedule(turnId, 1_120, () =>
      finish(
        threadId,
        turnId,
        'I reviewed the current context and prepared the next change. The Thread remains the durable record; Project access is scoped only to this turn.'
      )
    )
  }

  const rpc = async <M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> => {
    await new Promise((resolve) => window.setTimeout(resolve, 90))

    switch (method) {
      case 'initialize':
        return {
          server_info: { name: 'kody-browser-mock', version: '0.1.1' },
          capabilities: {
            approvals: true,
            context_references: true,
            managed_processes: true,
            process_output: true
          }
        } as RpcMethodMap[M]['result']
      case 'provider/list':
        return {
          providers: [
            {
              id: 'echo',
              display_name: 'Echo demo',
              kind: 'echo',
              auth: 'not_required',
              capabilities: {
                streaming: true,
                reasoning: false,
                tools: true,
                model_catalog: false,
                custom_models: false
              },
              default_model: 'kody-demo'
            },
            {
              id: 'codex',
              display_name: 'Codex account',
              kind: 'codex',
              auth: 'configured',
              capabilities: {
                streaming: true,
                reasoning: true,
                tools: true,
                model_catalog: true,
                custom_models: false
              },
              default_model: 'codex-default'
            }
          ]
        } as RpcMethodMap[M]['result']
      case 'provider/models': {
        const input = params as RpcMethodMap['provider/models']['params']
        return {
          models: input.provider_id === 'codex'
            ? [
                { id: 'codex-default', display_name: 'Codex default', is_default: true },
                { id: 'codex-fast', display_name: 'Codex fast' }
              ]
            : [{ id: 'kody-demo', display_name: 'Kody demo', is_default: true }]
        } as RpcMethodMap[M]['result']
      }
      case 'project/list':
        return { projects: clone(projects) } as RpcMethodMap[M]['result']
      case 'thread/list':
        return {
          threads: clone(threads).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        } as RpcMethodMap[M]['result']
      case 'project/import': {
        const input = params as RpcMethodMap['project/import']['params']
        const existing = projects.find((project) => project.root === input.path)
        if (existing) return clone(existing) as RpcMethodMap[M]['result']
        const project: Project = {
          id: id('project'),
          name: input.name?.trim() || pathName(input.path),
          root: input.path,
          kind: input.path.toLocaleLowerCase().includes('git') ? 'git' : 'directory',
          created_at: new Date().toISOString()
        }
        projects.unshift(project)
        return clone(project) as RpcMethodMap[M]['result']
      }
      case 'thread/create': {
        const input = params as RpcMethodMap['thread/create']['params']
        let importedProject: Project | undefined
        const defaultReferences: ContextReference[] = []
        if (input.working_directory) {
          importedProject = projects.find((project) => project.root === input.working_directory)
          if (!importedProject) {
            importedProject = {
              id: id('project'),
              name: pathName(input.working_directory),
              root: input.working_directory,
              kind: 'directory',
              created_at: new Date().toISOString()
            }
            projects.unshift(importedProject)
          }
          defaultReferences.push({
            kind: 'project',
            project_id: importedProject.id,
            access: 'read_write'
          })
        }
        const createdAt = new Date().toISOString()
        const thread: Thread = {
          id: id('thread'),
          title: input.title.trim() || 'Untitled thread',
          workspace_id: id('workspace'),
          status: 'idle',
          default_references: defaultReferences,
          created_at: createdAt,
          updated_at: createdAt
        }
        threads.unshift(thread)
        const snapshot: ThreadSnapshot = {
          thread,
          workspace: {
            id: thread.workspace_id,
            thread_id: thread.id,
            root: `/tmp/kody/workspaces/${thread.id}`,
            created_at: createdAt
          },
          messages: [],
          turns: [],
          pending_approvals: [],
          pending_user_inputs: [],
          processes: []
        }
        snapshots.set(thread.id, snapshot)
        return {
          thread: clone(thread),
          workspace: clone(snapshot.workspace),
          imported_project: importedProject ? clone(importedProject) : undefined
        } as RpcMethodMap[M]['result']
      }
      case 'thread/create-and-start': {
        const input = params as RpcMethodMap['thread/create-and-start']['params']
        const existing = startedRequests.get(input.client_request_id)
        if (existing) return clone(existing) as RpcMethodMap[M]['result']
        const created = await rpc('thread/create', {
          title: 'New thread',
          working_directory: input.working_directory
        })
        const turn = await rpc('turn/start', {
          thread_id: created.thread.id,
          message: input.message,
          references: input.references,
          provider: input.provider,
          model: input.model
        })
        const started = { ...created, turn }
        startedRequests.set(input.client_request_id, clone(started))
        return clone(started) as RpcMethodMap[M]['result']
      }
      case 'thread/get': {
        const input = params as RpcMethodMap['thread/get']['params']
        const snapshot = snapshots.get(input.thread_id)
        if (!snapshot) throw new Error(`Thread ${input.thread_id} was not found`)
        return clone(snapshot) as RpcMethodMap[M]['result']
      }
      case 'thread/reference/add': {
        const input = params as RpcMethodMap['thread/reference/add']['params']
        const snapshot = snapshots.get(input.thread_id)
        if (!snapshot) throw new Error(`Thread ${input.thread_id} was not found`)
        const key = input.reference.kind === 'thread'
          ? `thread:${input.reference.thread_id}`
          : `project:${input.reference.project_id}`
        snapshot.thread.default_references = [
          ...snapshot.thread.default_references.filter((reference) => {
            const currentKey = reference.kind === 'thread'
              ? `thread:${reference.thread_id}`
              : `project:${reference.project_id}`
            return currentKey !== key
          }),
          input.reference
        ]
        return clone(snapshot.thread) as RpcMethodMap[M]['result']
      }
      case 'user-input/respond': {
        const input = params as RpcMethodMap['user-input/respond']['params']
        const snapshot = [...snapshots.values()].find((item) => (
          item.pending_user_inputs.some((interaction) => interaction.interaction_id === input.interaction_id)
        ))
        if (!snapshot) throw new Error('This question was already resolved.')
        snapshot.pending_user_inputs = snapshot.pending_user_inputs.filter(
          (interaction) => interaction.interaction_id !== input.interaction_id
        )
        emit(snapshot.thread.id, snapshot.turns.at(-1)?.id ?? 'turn-user-input', {
          type: 'user_input_resolved',
          interaction_id: input.interaction_id,
          cancelled: input.cancelled
        })
        return { resolved: true } as RpcMethodMap[M]['result']
      }
      case 'turn/start': {
        const input = params as RpcMethodMap['turn/start']['params']
        const snapshot = snapshots.get(input.thread_id)
        if (!snapshot) throw new Error(`Thread ${input.thread_id} was not found`)
        const createdAt = new Date().toISOString()
        const message: ChatMessage = {
          id: id('message'),
          thread_id: input.thread_id,
          turn_id: undefined,
          role: 'user',
          parts: [{ type: 'text', text: input.message }],
          references: clone(input.references),
          created_at: createdAt
        }
        const turn: Turn = {
          id: id('turn'),
          thread_id: input.thread_id,
          input_message_id: message.id,
          provider: input.provider,
          model: input.model || 'kody-demo',
          status: 'running',
          created_at: createdAt,
          started_at: createdAt
        }
        message.turn_id = turn.id
        snapshot.messages.push(message)
        snapshot.turns.push(turn)
        snapshot.thread.status = 'running'
        snapshot.thread.updated_at = createdAt
        window.setTimeout(() => runTurn(input.thread_id, turn.id, input.message), 0)
        return clone(turn) as RpcMethodMap[M]['result']
      }
      case 'turn/cancel': {
        const input = params as RpcMethodMap['turn/cancel']['params']
        let cancelled = false
        for (const snapshot of snapshots.values()) {
          const turn = snapshot.turns.find((item) => item.id === input.turn_id)
          if (!turn || turn.status !== 'running') continue
          clearTurnTimers(turn.id)
          turn.status = 'cancelled'
          turn.completed_at = new Date().toISOString()
          snapshot.thread.status = 'idle'
          emit(snapshot.thread.id, turn.id, { type: 'turn_cancelled' })
          cancelled = true
          break
        }
        return { cancelled } as RpcMethodMap[M]['result']
      }
      case 'approval/respond': {
        const input = params as RpcMethodMap['approval/respond']['params']
        const approval = approvals.get(input.approval_id)
        if (!approval || approval.resolved) {
          return { resolved: false } as RpcMethodMap[M]['result']
        }
        approval.resolved = true
        emit(approval.threadId, approval.turnId, {
          type: 'approval_resolved',
          approval_id: approval.approvalId,
          approved: input.approved
        })
        if (input.approved) {
          emit(approval.threadId, approval.turnId, {
            type: 'tool_started',
            tool_call_id: approval.toolCallId,
            name: 'shell',
            arguments: { command: approval.command, cwd: '/Users/demo/Code/kody' }
          })
          schedule(approval.turnId, 520, () => {
            emit(approval.threadId, approval.turnId, {
              type: 'tool_completed',
              tool_call_id: approval.toolCallId,
              name: 'shell',
              content: 'Finished successfully in 0.42s',
              is_error: false
            })
            emit(approval.threadId, approval.turnId, {
              type: 'file_changed',
              project_id: 'project-kody',
              path: 'apps/desktop/src/renderer/App.tsx'
            })
            finish(
              approval.threadId,
              approval.turnId,
              'The command completed successfully. I verified the referenced Project and recorded the changed file in this Thread’s activity.'
            )
          })
        } else {
          finish(
            approval.threadId,
            approval.turnId,
            'I left the workspace unchanged because shell access was denied. I can continue with read-only inspection or propose the command for you to run manually.'
          )
        }
        return { resolved: true } as RpcMethodMap[M]['result']
      }
      case 'process/list': {
        const input = params as RpcMethodMap['process/list']['params']
        const snapshot = snapshots.get(input.thread_id)
        if (!snapshot) throw new Error(`Thread ${input.thread_id} was not found`)
        return { processes: clone(snapshot.processes) } as RpcMethodMap[M]['result']
      }
      case 'process/get': {
        const input = params as RpcMethodMap['process/get']['params']
        const snapshot = snapshots.get(input.thread_id)
        const process = snapshot?.processes.find((item) => item.id === input.process_id)
        if (!process) throw new Error(`Process ${input.process_id} was not found in this Thread`)
        return clone(process) as RpcMethodMap[M]['result']
      }
      case 'process/read-output': {
        const input = params as RpcMethodMap['process/read-output']['params']
        const snapshot = snapshots.get(input.thread_id)
        const process = snapshot?.processes.find((item) => item.id === input.process_id)
        if (!process) throw new Error(`Process ${input.process_id} was not found in this Thread`)
        const requestedCursor = input.after_cursor ?? process.output_start_cursor
        return {
          process_id: process.id,
          requested_cursor: requestedCursor,
          start_cursor: Math.max(requestedCursor, process.output_start_cursor),
          next_cursor: process.output_end_cursor,
          end_cursor: process.output_end_cursor,
          truncated: requestedCursor < process.output_start_cursor,
          has_more: false,
          chunks: []
        } as RpcMethodMap[M]['result']
      }
      case 'process/stop': {
        const input = params as RpcMethodMap['process/stop']['params']
        const snapshot = snapshots.get(input.thread_id)
        const process = snapshot?.processes.find((item) => item.id === input.process_id)
        if (!process) throw new Error(`Process ${input.process_id} was not found in this Thread`)
        if (process.status === 'starting' || process.status === 'running' || process.status === 'stopping') {
          process.status = 'stopped'
          process.completed_at = new Date().toISOString()
          emitProcess(process, { type: 'stopped', forced: false })
        }
        return clone(process) as RpcMethodMap[M]['result']
      }
      default:
        throw new Error(`Browser mock does not implement ${String(method)}`)
    }
  }

  return {
    rpc,
    projects,
    threads,
    snapshots,
    events,
    processEvents,
    statusListeners
  }
}

export function createMockBridge(): KodyDesktopBridge {
  const store = createMockStore()
  let providerProfiles: ProviderProfileRecord[] = []
  let codexAccount: CodexAccountStatus = {
    state: 'signed-in',
    accountLabel: 'preview@example.test',
    detail: 'Browser preview account'
  }
  const connectedStatus: ServerStatus = {
    phase: 'connected',
    detail: 'Browser preview · in-memory server'
  }

  return {
    rpc: store.rpc,
    copyText: async (text) => navigator.clipboard?.writeText(text),
    pickDirectory: async () => '/Users/demo/Code/new-project',
    getServerStatus: async () => connectedStatus,
    getProviderSettings: async () => ({
      profiles: clone(providerProfiles),
      credentialStorage: { available: true, backend: 'browser-preview' }
    }),
    upsertProviderProfile: async (input) => {
      const existing = input.id
        ? providerProfiles.find((profile) => profile.id === input.id)
        : undefined
      const now = new Date().toISOString()
      const profile: ProviderProfileRecord = {
        id: existing?.id ?? id('provider'),
        name: input.name,
        kind: input.kind,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        defaultModel: input.defaultModel,
        customModels: input.customModels ?? [],
        hasSecret: input.clearSecret ? false : Boolean(input.secret || existing?.hasSecret),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      providerProfiles = [profile, ...providerProfiles.filter((item) => item.id !== profile.id)]
      return clone(profile)
    },
    deleteProviderProfile: async (profileId) => {
      providerProfiles = providerProfiles.filter((profile) => profile.id !== profileId)
    },
    getCodexAccountStatus: async () => clone(codexAccount),
    connectCodexAccount: async () => {
      codexAccount = {
        state: 'signed-in',
        accountLabel: 'preview@example.test',
        detail: 'Browser preview account'
      }
      return { mode: 'browser' }
    },
    disconnectCodexAccount: async () => {
      codexAccount = { state: 'signed-out' }
    },
    onEvent: (listener) => {
      store.events.add(listener)
      return () => store.events.delete(listener)
    },
    onProcessEvent: (listener) => {
      store.processEvents.add(listener)
      return () => store.processEvents.delete(listener)
    },
    onServerStatus: (listener) => {
      store.statusListeners.add(listener)
      return () => store.statusListeners.delete(listener)
    },
    onCommand: () => () => undefined,
    windowAction: async () => undefined,
    platform: navigator.userAgent.includes('Mac')
      ? 'darwin'
      : navigator.userAgent.includes('Win')
        ? 'win32'
        : 'linux'
  }
}

let browserBridge: KodyDesktopBridge | undefined

function createDisconnectedBridge(): KodyDesktopBridge {
  const status: ServerStatus = {
    phase: 'disconnected',
    detail: 'The desktop preload bridge is unavailable.'
  }
  return {
    rpc: async () => {
      throw new Error(status.detail)
    },
    copyText: async () => {
      throw new Error(status.detail)
    },
    pickDirectory: async () => null,
    getServerStatus: async () => status,
    getProviderSettings: async () => {
      throw new Error(status.detail)
    },
    upsertProviderProfile: async () => {
      throw new Error(status.detail)
    },
    deleteProviderProfile: async () => {
      throw new Error(status.detail)
    },
    getCodexAccountStatus: async () => ({ state: 'unavailable', detail: status.detail }),
    connectCodexAccount: async () => {
      throw new Error(status.detail)
    },
    disconnectCodexAccount: async () => {
      throw new Error(status.detail)
    },
    onEvent: () => () => undefined,
    onProcessEvent: () => () => undefined,
    onServerStatus: (listener) => {
      listener(status)
      return () => undefined
    },
    onCommand: () => () => undefined,
    windowAction: async () => undefined,
    platform: 'linux'
  }
}

export function getKodyBridge(): KodyDesktopBridge {
  if (window.kody) return window.kody
  const isDevelopment = Boolean(
    (import.meta as ImportMeta & { env?: Record<string, string | boolean | undefined> }).env?.DEV
  )
  browserBridge ??= isDevelopment ? createMockBridge() : createDisconnectedBridge()
  return browserBridge
}
