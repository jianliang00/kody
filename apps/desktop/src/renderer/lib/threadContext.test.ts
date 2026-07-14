import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  ContextReference,
  EventEnvelope,
  ThreadSnapshot,
  Turn
} from '@shared/protocol'
import { collectEffectiveReferences, deriveRunningTools, deriveThreadContext } from './threadContext'

const now = '2026-07-13T00:00:00.000Z'

function turn(id: string, status: Turn['status'] = 'running'): Turn {
  return {
    id,
    thread_id: 'thread-current',
    input_message_id: `message-${id}`,
    provider: 'echo',
    model: 'echo',
    permission_mode: 'ask',
    status,
    created_at: now
  }
}

function message(id: string, references: ContextReference[]): ChatMessage {
  return {
    id,
    thread_id: 'thread-current',
    role: 'user',
    parts: [{ type: 'text', text: id }],
    references,
    created_at: now
  }
}

function snapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    thread: {
      id: 'thread-current',
      title: 'Current',
      workspace_id: 'workspace-current',
      status: 'running',
      default_references: [],
      created_at: now,
      updated_at: now
    },
    workspace: {
      id: 'workspace-current',
      thread_id: 'thread-current',
      root: '/tmp/workspace-current',
      created_at: now
    },
    messages: [],
    turns: [],
    pending_approvals: [],
    pending_user_inputs: [],
    processes: [],
    ...overrides
  }
}

function event(
  id: string,
  turnId: string,
  value: EventEnvelope['event'],
  sequence: number
): EventEnvelope {
  return {
    id,
    thread_id: 'thread-current',
    turn_id: turnId,
    sequence,
    created_at: now,
    event: value
  }
}

describe('Thread context derivation', () => {
  it('deduplicates effective references with linear history taking precedence', () => {
    const current = snapshot({
      thread: {
        ...snapshot().thread,
        default_references: [
          { kind: 'project', project_id: 'project-a', access: 'read_write' },
          { kind: 'thread', thread_id: 'thread-design', mode: 'summary' }
        ]
      },
      messages: [
        message('first', [
          { kind: 'project', project_id: 'project-a', access: 'read_only' },
          { kind: 'thread', thread_id: 'thread-review', mode: 'full' }
        ]),
        message('second', [
          { kind: 'thread', thread_id: 'thread-design', mode: 'artifacts' }
        ])
      ]
    })

    const effective = collectEffectiveReferences(current)
    expect(effective.projects).toEqual([
      { kind: 'project', project_id: 'project-a', access: 'read_only' }
    ])
    expect(effective.threads).toEqual([
      { kind: 'thread', thread_id: 'thread-design', mode: 'artifacts' },
      { kind: 'thread', thread_id: 'thread-review', mode: 'full' }
    ])

    const pending: ContextReference[] = [
      { kind: 'project', project_id: 'project-next', access: 'read_only' }
    ]
    const context = deriveThreadContext(current, [], pending)
    expect(context.projectReferences).toHaveLength(1)
    expect(context.pendingReferences).toEqual(pending)
  })

  it('tracks only unfinished tools from active Turns using a Turn-scoped key', () => {
    const current = snapshot({
      turns: [turn('turn-a'), turn('turn-b')],
      pending_approvals: [{
        approval_id: 'approval-a',
        thread_id: 'thread-current',
        turn_id: 'turn-a',
        tool_call_id: 'approval-tool',
        name: 'shell',
        arguments: { command: 'cargo test' },
        reason: 'Needs permission'
      }],
      pending_user_inputs: [],
      processes: []
    })
    const events = [
      event('event-a', 'turn-a', {
        type: 'tool_started',
        tool_call_id: 'shared-call',
        name: 'shell',
        arguments: { command: 'npm run dev', cwd: '/project/a' }
      }, 1),
      event('event-b', 'turn-b', {
        type: 'tool_started',
        tool_call_id: 'shared-call',
        name: 'read_file',
        arguments: { path: 'README.md' }
      }, 1),
      event('event-c', 'turn-b', {
        type: 'tool_completed',
        tool_call_id: 'shared-call',
        name: 'read_file',
        content: 'done',
        is_error: false
      }, 2)
    ]

    expect(deriveRunningTools(current, events)).toMatchObject([{
      key: 'turn-a:shared-call',
      kind: 'command',
      detail: 'npm run dev',
      target: '/project/a'
    }])

    const context = deriveThreadContext(current, events, [])
    expect(context.activeTurns).toHaveLength(2)
    expect(context.pendingApprovals).toHaveLength(1)
    expect(context.runningTools).toHaveLength(1)

    const terminalEvents = events.concat(event('event-d', 'turn-a', {
      type: 'turn_completed',
      final_text: 'done'
    }, 2))
    expect(deriveRunningTools(current, terminalEvents)).toHaveLength(0)
  })
})
