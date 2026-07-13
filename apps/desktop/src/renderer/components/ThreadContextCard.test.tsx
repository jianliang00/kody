import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ThreadContextView } from '../lib/threadContext'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import { ThreadContextCard } from './ThreadContextCard'

const now = '2026-07-13T00:00:00.000Z'

afterEach(cleanup)

describe('ThreadContextCard', () => {
  it('renders references and leaf runtime activity without claiming unmanaged processes', () => {
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
      pending_approvals: []
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
    expect(screen.getByText('2 active')).toBeTruthy()
    expect(screen.getByText('Running command')).toBeTruthy()
    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    expect(screen.getByText('No managed background processes')).toBeTruthy()
    expect(screen.getByTitle('Managed background processes').parentElement?.textContent).toContain('0')
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
