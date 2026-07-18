import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      pending_user_inputs: [],
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
        permission_mode: 'ask',
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
    const onCopyText = vi.fn(async () => undefined)

    render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={threads}
        projects={projects}
        context={context}
        detailsOpen={false}
        onOpenDetails={vi.fn()}
        onCopyText={onCopyText}
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
    expect(screen.getByRole('button', { name: 'Expand Content & activity' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('reveals and copies the complete Workspace path', async () => {
    const path = '/Users/jianliang/Library/Application Support/Kody/workspaces/thread-current'
    const snapshot: ThreadSnapshot = {
      thread: thread('thread-current', 'Inspect Workspace'),
      workspace: {
        id: 'workspace-current',
        thread_id: 'thread-current',
        root: path,
        created_at: now
      },
      messages: [],
      turns: [],
      pending_approvals: [],
      pending_user_inputs: [],
      processes: []
    }
    const onCopyText = vi.fn(async () => undefined)

    const { container } = render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={[]}
        projects={[]}
        context={{
          threadReferences: [],
          projectReferences: [],
          pendingReferences: [],
          activeTurns: [],
          runningTools: [],
          pendingApprovals: []
        }}
        detailsOpen={false}
        onOpenDetails={vi.fn()}
        onCopyText={onCopyText}
      />
    )

    const disclosure = container.querySelector<HTMLDetailsElement>('.thread-context-card__workspace-path')
    expect(disclosure?.open).toBe(false)
    fireEvent.click(disclosure!.querySelector('summary')!)
    expect(disclosure?.open).toBe(true)
    expect(container.querySelector('.thread-context-card__workspace-full code')?.textContent).toBe(path)

    fireEvent.click(screen.getByRole('button', { name: 'Copy Workspace path' }))
    await waitFor(() => expect(onCopyText).toHaveBeenCalledWith(path))
    expect(screen.getByRole('button', { name: 'Workspace path copied' })).toBeTruthy()
  })

  it('leaves collapse control ownership to the expanded Inspector', () => {
    const snapshot: ThreadSnapshot = {
      thread: thread('thread-current', 'Inspect context'),
      workspace: {
        id: 'workspace-current',
        thread_id: 'thread-current',
        root: '/tmp/thread-current',
        created_at: now
      },
      messages: [],
      turns: [],
      pending_approvals: [],
      pending_user_inputs: [],
      processes: []
    }

    render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={[]}
        projects={[]}
        context={{
          threadReferences: [],
          projectReferences: [],
          pendingReferences: [],
          activeTurns: [],
          runningTools: [],
          pendingApprovals: []
        }}
        detailsOpen
        onOpenDetails={vi.fn()}
        onCopyText={vi.fn(async () => undefined)}
      />
    )

    expect(screen.queryByRole('button', { name: 'Collapse Content & activity' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand Content & activity' })).toBeNull()
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
