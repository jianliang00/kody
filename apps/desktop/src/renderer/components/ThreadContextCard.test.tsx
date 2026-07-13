import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ThreadContextView } from '../lib/threadContext'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import { ThreadContextCard } from './ThreadContextCard'

const now = '2026-07-13T00:00:00.000Z'

afterEach(cleanup)

describe('ThreadContextCard', () => {
  it('renders references, foreground activity, and at most two authoritative managed processes', () => {
    const threads: Thread[] = [thread('thread-design', 'OAuth design')]
    const projects: Project[] = [{
      id: 'project-web',
      name: 'Web app',
      root: '/projects/web',
      kind: 'git',
      created_at: now
    }]
    const snapshot: ThreadSnapshot = {
      thread: thread('thread-current', 'Implement OAuth'),
      workspace: {
        id: 'workspace-current',
        thread_id: 'thread-current',
        root: '/tmp/thread-current',
        created_at: now
      },
      messages: [],
      turns: [],
      pending_approvals: [],
      processes: [
        {
          ...managedProcess('process-api', 'npm run api'),
          origin: { turn_id: 'turn-current', tool_call_id: 'tool-shell' }
        },
        managedProcess('process-web', 'npm run web'),
        managedProcess('process-worker', 'npm run worker')
      ]
    }
    const context: ThreadContextView = {
      threadReferences: [{ kind: 'thread', thread_id: 'thread-design', mode: 'summary' }],
      projectReferences: [{ kind: 'project', project_id: 'project-web', access: 'read_write' }],
      pendingReferences: [{ kind: 'project', project_id: 'project-next', access: 'read_only' }],
      activeTurns: [{
        id: 'turn-current',
        thread_id: 'thread-current',
        input_message_id: 'message-current',
        provider: 'echo',
        model: 'echo',
        status: 'running',
        created_at: now
      }],
      runningTools: [{
        key: 'turn-current:tool-shell',
        turnId: 'turn-current',
        toolCallId: 'tool-shell',
        name: 'shell',
        detail: 'npm test',
        kind: 'command'
      }, {
        key: 'turn-current:tool-read',
        turnId: 'turn-current',
        toolCallId: 'tool-read',
        name: 'read_file',
        detail: 'README.md',
        kind: 'tool'
      }],
      pendingApprovals: [{
        approval_id: 'approval-current',
        thread_id: 'thread-current',
        turn_id: 'turn-current',
        tool_call_id: 'tool-approval',
        name: 'shell',
        arguments: { command: 'cargo test' },
        reason: 'Needs permission'
      }]
    }

    render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={threads}
        projects={projects}
        context={context}
        detailsOpen={false}
        onOpenDetails={vi.fn()}
      />
    )

    expect(screen.getByLabelText('Referenced Threads').textContent).toContain('OAuth design')
    expect(screen.getByLabelText('Referenced Threads').textContent).toContain('Summary')
    expect(screen.getByLabelText('Referenced Projects').textContent).toContain('Web app')
    expect(screen.getByLabelText('Referenced Projects').textContent).toContain('Read & write')
    expect(screen.getByText('5 active')).toBeTruthy()
    expect(screen.queryByText('Running command')).toBeNull()
    expect(screen.getByText('Running read_file')).toBeTruthy()
    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    expect(screen.getAllByText('Background process active')).toHaveLength(2)
    expect(screen.getByText('+1 more managed processes')).toBeTruthy()
    expect(screen.getByTitle('Active managed background processes').parentElement?.textContent).toContain('3')
    expect(screen.getByTitle('References pending for the next message').textContent).toBe('+1')
    expect(screen.getByRole('button', { name: 'Open full context inspector' }).getAttribute('aria-expanded')).toBe('false')
  })
})

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    workspace_id: `workspace-${id}`,
    status: 'idle',
    default_references: [],
    created_at: now,
    updated_at: now
  }
}

function managedProcess(id: string, command: string): ThreadSnapshot['processes'][number] {
  return {
    id,
    thread_id: 'thread-current',
    origin: { turn_id: 'turn-current', tool_call_id: `tool-${id}` },
    spec_fingerprint: 'a'.repeat(64),
    command,
    cwd: '/tmp/thread-current',
    pid: 10,
    status: 'running',
    output_truncated: false,
    output_start_cursor: 0,
    output_end_cursor: 0,
    last_event_sequence: 1,
    created_at: now,
    started_at: now
  }
}
