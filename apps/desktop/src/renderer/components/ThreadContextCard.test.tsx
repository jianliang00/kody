import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
      ],
      artifacts: []
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
        speedy: false,
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
    const onExpandedChange = vi.fn()
    const onOpenDetails = vi.fn()

    const { container } = render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={threads}
        projects={projects}
        context={context}
        expanded
        onExpandedChange={onExpandedChange}
        onOpenDetails={onOpenDetails}
      />
    )

    const toggle = screen.getByRole('button', { name: 'Context' })
    const panel = container.querySelector<HTMLElement>('#thread-context-card-panel')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe('thread-context-card-panel')
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-labelledby')).toBe('thread-context-card-title')
    expect(panel?.hasAttribute('hidden')).toBe(false)
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
    expect(container.querySelector('.thread-context-card__metrics')).toBeNull()

    const threadDetails = screen.getByRole('button', { name: /Referenced Threads/ })
    const projectDetails = screen.getByRole('button', { name: /Referenced Projects/ })
    const runtimeDetails = screen.getByRole('button', { name: /Runtime/ })
    expect(threadDetails.getAttribute('aria-haspopup')).toBe('dialog')
    expect(projectDetails.getAttribute('aria-haspopup')).toBe('dialog')
    expect(runtimeDetails.getAttribute('aria-haspopup')).toBe('dialog')
    expect(threadDetails.getAttribute('aria-label')).toBe('Show Referenced Threads details')
    expect(projectDetails.getAttribute('aria-label')).toBe('Show Referenced Projects details')
    expect(runtimeDetails.getAttribute('aria-label')).toBe('Show Runtime details')
    expect(projectDetails.textContent).toContain('1 pending')
    fireEvent.click(threadDetails)
    fireEvent.click(projectDetails)
    fireEvent.click(runtimeDetails)
    expect(onOpenDetails.mock.calls.map(([kind]) => kind)).toEqual(['threads', 'projects', 'runtime'])
    expect(onOpenDetails.mock.calls.every(([, trigger]) => trigger instanceof HTMLButtonElement)).toBe(true)

    fireEvent.click(toggle)
    expect(onExpandedChange).toHaveBeenCalledOnce()
    expect(onExpandedChange).toHaveBeenCalledWith(false)
  })

  it('keeps collapsed content mounted inside a hidden labelled panel', () => {
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
      processes: [],
      artifacts: []
    }

    const onExpandedChange = vi.fn()
    const { container } = render(
      <ThreadContextCard
        snapshot={snapshot}
        threads={[]}
        projects={[]}
        context={{
          threadReferences: [],
          projectReferences: [],
          pendingReferences: [{ kind: 'thread', thread_id: 'thread-pending', mode: 'summary' }],
          activeTurns: [],
          runningTools: [],
          pendingApprovals: []
        }}
        expanded={false}
        onExpandedChange={onExpandedChange}
        onOpenDetails={vi.fn()}
      />
    )

    const toggle = screen.getByRole('button', { name: 'Context' })
    const panel = container.querySelector<HTMLElement>('#thread-context-card-panel')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe(panel?.id)
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-labelledby')).toBe('thread-context-card-title')
    expect(panel?.hidden).toBe(true)
    expect(screen.getByText('No active referenced threads')).toBeTruthy()
    expect(screen.getByText('No referenced Projects')).toBeTruthy()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Show Referenced Threads details"]')?.textContent)
      .toContain('1 pending')
    expect(screen.getByText('No active operations')).toBeTruthy()

    fireEvent.click(toggle)
    expect(onExpandedChange).toHaveBeenCalledOnce()
    expect(onExpandedChange).toHaveBeenCalledWith(true)
  })
})

function thread(id: string, title: string): Thread {
  return {
    id,
    title,
    workspace_id: `workspace-${id}`,
    status: 'idle',
    workflow_state: 'deferred',
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
