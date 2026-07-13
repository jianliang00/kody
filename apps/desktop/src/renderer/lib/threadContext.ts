import type {
  ContextReference,
  EventEnvelope,
  PendingApproval,
  ThreadSnapshot,
  Turn
} from '@shared/protocol'

export type ThreadContextReference = Extract<ContextReference, { kind: 'thread' }>
export type ProjectContextReference = Extract<ContextReference, { kind: 'project' }>

export interface RunningToolActivity {
  key: string
  turnId: string
  toolCallId: string
  name: string
  detail?: string
  target?: string
  kind: 'command' | 'tool'
}

export interface ThreadContextView {
  threadReferences: ThreadContextReference[]
  projectReferences: ProjectContextReference[]
  pendingReferences: ContextReference[]
  activeTurns: Turn[]
  runningTools: RunningToolActivity[]
  pendingApprovals: PendingApproval[]
}

/** Mirrors the runtime context builder: defaults first, then linear history, last value wins. */
export function collectEffectiveReferences(snapshot: ThreadSnapshot): {
  threads: ThreadContextReference[]
  projects: ProjectContextReference[]
} {
  const threads = new Map<string, ThreadContextReference>()
  const projects = new Map<string, ProjectContextReference>()
  const references = snapshot.thread.default_references.concat(
    snapshot.messages.flatMap((message) => message.references)
  )

  for (const reference of references) {
    if (reference.kind === 'thread') threads.set(reference.thread_id, reference)
    else projects.set(reference.project_id, reference)
  }

  return { threads: [...threads.values()], projects: [...projects.values()] }
}

export function deriveRunningTools(
  snapshot: ThreadSnapshot,
  events: EventEnvelope[]
): RunningToolActivity[] {
  const activeTurnIds = new Set(
    snapshot.turns
      .filter((turn) => turn.status === 'queued' || turn.status === 'running')
      .map((turn) => turn.id)
  )
  const running = new Map<string, RunningToolActivity>()

  for (const envelope of events) {
    if (!activeTurnIds.has(envelope.turn_id)) continue
    const keyFor = (toolCallId: string): string => `${envelope.turn_id}:${toolCallId}`
    if (envelope.event.type === 'tool_started') {
      const args = objectArguments(envelope.event.arguments)
      running.set(keyFor(envelope.event.tool_call_id), {
        key: keyFor(envelope.event.tool_call_id),
        turnId: envelope.turn_id,
        toolCallId: envelope.event.tool_call_id,
        name: envelope.event.name,
        detail: stringArgument(args, 'command') ?? stringArgument(args, 'path'),
        target: stringArgument(args, 'cwd') ?? stringArgument(args, 'project_id'),
        kind: envelope.event.name === 'shell' ? 'command' : 'tool'
      })
    } else if (envelope.event.type === 'tool_completed') {
      running.delete(keyFor(envelope.event.tool_call_id))
    } else if (
      envelope.event.type === 'turn_completed'
      || envelope.event.type === 'turn_failed'
      || envelope.event.type === 'turn_cancelled'
    ) {
      for (const [key, activity] of running) {
        if (activity.turnId === envelope.turn_id) running.delete(key)
      }
    }
  }

  return [...running.values()]
}

export function deriveThreadContext(
  snapshot: ThreadSnapshot,
  events: EventEnvelope[],
  pendingReferences: ContextReference[]
): ThreadContextView {
  const effective = collectEffectiveReferences(snapshot)
  return {
    threadReferences: effective.threads,
    projectReferences: effective.projects,
    pendingReferences,
    activeTurns: snapshot.turns.filter((turn) => turn.status === 'queued' || turn.status === 'running'),
    runningTools: deriveRunningTools(snapshot, events),
    pendingApprovals: snapshot.pending_approvals
  }
}

function objectArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] : undefined
}
