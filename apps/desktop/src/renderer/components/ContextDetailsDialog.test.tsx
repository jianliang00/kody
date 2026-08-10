import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import type { ThreadContextView } from '../lib/threadContext'
import { ContextDetailsDialog, type ContextDetailKind } from './ContextDetailsDialog'

const now = '2026-08-09T00:00:00.000Z'

afterEach(cleanup)

describe('ContextDetailsDialog', () => {
  it('shows Thread references by source and restores focus after Escape', async () => {
    render(<DialogHarness initialKind="threads" />)

    const dialog = screen.getByRole('dialog', { name: 'Referenced Threads' })
    const close = screen.getByRole('button', { name: 'Close Referenced Threads' })
    const trigger = screen.getByTestId('context-detail-trigger')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(close))
    expect(screen.getByLabelText('Default context').textContent).toContain('Design Thread')
    expect(screen.getByLabelText('Active history').textContent).toContain('History Thread')
    expect(screen.getByLabelText('Pending context').textContent).toContain('Pending Thread')
    expect(screen.queryByText('Web app')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('shows complete foreground activity and managed processes without duplicating a managed shell', () => {
    render(<DialogHarness initialKind="runtime" />)

    expect(screen.getByRole('dialog', { name: 'Runtime' })).toBeTruthy()
    expect(screen.queryByText('Agent Turn active')).toBeNull()
    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    expect(screen.getByText('Running read_file')).toBeTruthy()
    expect(screen.queryByText('Running command')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Background processes' })).toBeTruthy()
    expect(screen.getByText('npm run dev')).toBeTruthy()
  })
})

function DialogHarness({ initialKind }: { initialKind: ContextDetailKind }) {
  const [kind, setKind] = useState<ContextDetailKind | null>(initialKind)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const data = fixture()

  return (
    <>
      <button ref={triggerRef} data-testid="context-detail-trigger" type="button">Context detail trigger</button>
      <ContextDetailsDialog
        kind={kind}
        snapshot={data.snapshot}
        threads={data.threads}
        projects={data.projects}
        context={data.context}
        returnFocusRef={triggerRef}
        stoppingProcessIds={new Set()}
        processOutputCursors={{}}
        onOpenChange={(open) => {
          if (!open) setKind(null)
        }}
        onReadProcessOutput={vi.fn()}
        onStopProcess={vi.fn(async () => undefined)}
      />
    </>
  )
}

function fixture(): {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  context: ThreadContextView
} {
  const threads = [
    thread('thread-current', 'Current Thread'),
    thread('thread-design', 'Design Thread'),
    thread('thread-history', 'History Thread'),
    thread('thread-pending', 'Pending Thread')
  ]
  const projects: Project[] = [{
    id: 'project-web',
    name: 'Web app',
    root: '/projects/web',
    kind: 'git',
    created_at: now
  }]
  const snapshot: ThreadSnapshot = {
    thread: {
      ...thread('thread-current', 'Current Thread'),
      default_references: [
        { kind: 'thread', thread_id: 'thread-design', mode: 'summary' },
        { kind: 'project', project_id: 'project-web', access: 'read_write' }
      ]
    },
    workspace: {
      id: 'workspace-current',
      thread_id: 'thread-current',
      root: '/tmp/thread-current',
      created_at: now
    },
    messages: [{
      id: 'message-history',
      thread_id: 'thread-current',
      role: 'user',
      parts: [{ type: 'text', text: 'Continue the design' }],
      references: [
        { kind: 'thread', thread_id: 'thread-history', mode: 'full' },
        { kind: 'project', project_id: 'project-web', access: 'read_only' }
      ],
      created_at: now
    }],
    turns: [{
      id: 'turn-current',
      thread_id: 'thread-current',
      input_message_id: 'message-history',
      provider: 'echo',
      model: 'echo',
      speedy: false,
      permission_mode: 'ask',
      status: 'running',
      created_at: now
    }],
    pending_approvals: [{
      approval_id: 'approval-current',
      thread_id: 'thread-current',
      turn_id: 'turn-current',
      tool_call_id: 'tool-approval',
      name: 'shell',
      arguments: { command: 'npm test' },
      reason: 'Needs permission'
    }],
    pending_user_inputs: [],
    processes: [{
      id: 'process-web',
      thread_id: 'thread-current',
      origin: { turn_id: 'turn-current', tool_call_id: 'tool-shell' },
      spec_fingerprint: 'a'.repeat(64),
      project_id: 'project-web',
      command: 'npm run dev',
      cwd: '/projects/web',
      pid: 4242,
      status: 'running',
      output_truncated: false,
      output_start_cursor: 0,
      output_end_cursor: 0,
      last_event_sequence: 1,
      created_at: now,
      started_at: now
    }],
    artifacts: []
  }
  const context: ThreadContextView = {
    threadReferences: [
      { kind: 'thread', thread_id: 'thread-design', mode: 'summary' },
      { kind: 'thread', thread_id: 'thread-history', mode: 'full' }
    ],
    projectReferences: [{ kind: 'project', project_id: 'project-web', access: 'read_only' }],
    pendingReferences: [
      { kind: 'thread', thread_id: 'thread-pending', mode: 'artifacts' },
      { kind: 'project', project_id: 'project-web', access: 'read_write' }
    ],
    activeTurns: snapshot.turns,
    runningTools: [{
      key: 'turn-current:tool-shell',
      turnId: 'turn-current',
      toolCallId: 'tool-shell',
      name: 'shell',
      detail: 'npm run dev',
      kind: 'command'
    }, {
      key: 'turn-current:tool-read',
      turnId: 'turn-current',
      toolCallId: 'tool-read',
      name: 'read_file',
      detail: 'README.md',
      kind: 'tool'
    }],
    pendingApprovals: snapshot.pending_approvals
  }

  return { snapshot, threads, projects, context }
}

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
