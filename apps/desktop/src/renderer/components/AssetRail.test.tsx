import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, Thread } from '@shared/protocol'
import { AssetRail } from './AssetRail'

const now = '2026-08-09T00:00:00.000Z'
const projects: Project[] = [{
  id: 'project-kody',
  name: 'Kody',
  root: '/code/kody',
  kind: 'git',
  created_at: now
}]
const threads: Thread[] = [
  {
    id: 'thread-running',
    title: 'Running Thread',
    summary: 'Implementing the new workbench.',
    workspace_id: 'workspace-running',
    status: 'running',
    workflow_state: 'deferred',
    default_references: [{ kind: 'project', project_id: 'project-kody', access: 'read_write' }],
    created_at: now,
    updated_at: now
  },
  {
    id: 'thread-idle',
    title: 'Idle Thread',
    workspace_id: 'workspace-idle',
    status: 'idle',
    workflow_state: 'new_progress',
    default_references: [],
    created_at: now,
    updated_at: now
  }
]

afterEach(cleanup)

describe('AssetRail', () => {
  it('renders the selected Workbench scope and selects a visible Thread', () => {
    const onClose = vi.fn()
    const onSelectThread = vi.fn()

    render(
      <AssetRail
        threads={threads}
        projects={projects}
        activeThreadId="thread-running"
        selection="running"
        open={false}
        workbenchCollapsed={false}
        onClose={onClose}
        onCollapse={vi.fn()}
        onExpandWorkbench={vi.fn()}
        onSelectThread={onSelectThread}
        onWorkflowChange={vi.fn()}
        workflowPendingIds={new Set()}
      />
    )

    const rail = screen.getByLabelText('Threads')
    expect(within(rail).getByRole('heading', { name: 'In Progress' })).toBeTruthy()
    expect(within(rail).getByText('Running Thread')).toBeTruthy()
    expect(within(rail).queryByText('Idle Thread')).toBeNull()
    expect(within(rail).getByRole('button', { name: /^Running Thread/ }).getAttribute('aria-current'))
      .toBe('page')

    fireEvent.click(within(rail).getByRole('button', { name: /^Running Thread/ }))
    expect(onSelectThread).toHaveBeenCalledWith('thread-running')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('searches the scoped list and exposes independent sidebar controls', () => {
    const onCollapse = vi.fn()
    const onExpandWorkbench = vi.fn()

    render(
      <AssetRail
        threads={threads}
        projects={projects}
        selection="all"
        open
        workbenchCollapsed
        onClose={vi.fn()}
        onCollapse={onCollapse}
        onExpandWorkbench={onExpandWorkbench}
        onSelectThread={vi.fn()}
        onWorkflowChange={vi.fn()}
        workflowPendingIds={new Set()}
      />
    )

    const rail = screen.getByLabelText('Threads')
    const search = within(rail).getByRole('searchbox', { name: 'Search Threads' })
    expect(search.getAttribute('tabindex')).toBe('-1')
    fireEvent.click(within(rail).getByRole('button', { name: 'Search Threads' }))
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, {
      target: { value: 'idle' }
    })
    expect(within(rail).getByText('Idle Thread')).toBeTruthy()
    expect(within(rail).queryByText('Running Thread')).toBeNull()

    fireEvent.click(within(rail).getByRole('button', { name: 'Expand workbench sidebar' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Collapse Thread list' }))

    expect(onExpandWorkbench).toHaveBeenCalledOnce()
    expect(onCollapse).toHaveBeenCalledOnce()
  })

  it('marks an empty Thread scope as a centered status region', () => {
    render(
      <AssetRail
        threads={threads}
        projects={projects}
        selection="handled"
        open={false}
        workbenchCollapsed={false}
        onClose={vi.fn()}
        onCollapse={vi.fn()}
        onExpandWorkbench={vi.fn()}
        onSelectThread={vi.fn()}
        onWorkflowChange={vi.fn()}
        workflowPendingIds={new Set()}
      />
    )

    const threadList = screen.getByRole('navigation', { name: 'Thread list' })
    expect(threadList.classList.contains('asset-navigation--empty')).toBe(true)
    expect(within(threadList).getByRole('status').textContent).toBe('No Threads in Processed')
  })

  it('supports quick completion and the keyboard-accessible workflow menu', () => {
    const onWorkflowChange = vi.fn()
    render(
      <AssetRail
        threads={threads}
        projects={projects}
        selection="new_progress"
        open={false}
        workbenchCollapsed={false}
        onClose={vi.fn()}
        onCollapse={vi.fn()}
        onExpandWorkbench={vi.fn()}
        onSelectThread={vi.fn()}
        onWorkflowChange={onWorkflowChange}
        workflowPendingIds={new Set()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark Idle Thread as Processed' }))
    expect(onWorkflowChange).toHaveBeenNthCalledWith(1, 'thread-idle', 'handled')

    const openThread = screen.getByRole('button', { name: /^Idle Thread/ })
    fireEvent.keyDown(openThread, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Manage Idle Thread' })
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Continue Later' }))
    expect(onWorkflowChange).toHaveBeenNthCalledWith(2, 'thread-idle', 'deferred')
  })
})
