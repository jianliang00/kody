import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, Thread } from '@shared/protocol'
import { WorkbenchRail } from './WorkbenchRail'

const now = '2026-08-09T00:00:00.000Z'
const project: Project = {
  id: 'project-kody',
  name: 'Kody',
  root: '/code/kody',
  kind: 'git',
  created_at: now
}
const threads: Thread[] = [
  thread('idle', 'idle', 'deferred', [{ kind: 'project', project_id: project.id, access: 'read_only' }]),
  thread('running', 'running'),
  thread('processed', 'idle', 'handled')
]

afterEach(cleanup)

describe('WorkbenchRail', () => {
  it('renders truthful view and Project counts with persistent selection semantics', () => {
    const onSelectionChange = vi.fn()

    renderWorkbench({ selection: 'running', onSelectionChange })

    const rail = screen.getByRole('complementary', { name: 'Workbench' })
    expect(within(rail).getByRole('button', { name: /New Progress\s*0/ })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /Continue Later\s*1/ })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /In Progress\s*1/ }).getAttribute('aria-current'))
      .toBe('page')
    expect(within(rail).getByRole('button', { name: /Processed\s*1/ })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /All Threads\s*3/ })).toBeTruthy()
    expect(within(rail).getByRole('button', { name: /Kody\s*1/ })).toBeTruthy()

    fireEvent.click(within(rail).getByRole('button', { name: /Processed\s*1/ }))
    fireEvent.click(within(rail).getByRole('button', { name: /Kody\s*1/ }))

    expect(onSelectionChange).toHaveBeenNthCalledWith(1, 'handled')
    expect(onSelectionChange).toHaveBeenNthCalledWith(2, 'project:project-kody')
  })

  it('wires primary actions, settings, updates, import, and independent collapse controls', () => {
    const onNewThread = vi.fn()
    const onImportProject = vi.fn(async () => undefined)
    const onOpenSettings = vi.fn()
    const onUpdateAction = vi.fn()
    const onCollapse = vi.fn()
    const onExpandThreadList = vi.fn()

    renderWorkbench({
      threadListCollapsed: true,
      onNewThread,
      onImportProject,
      onOpenSettings,
      onUpdateAction,
      onCollapse,
      onExpandThreadList
    })

    const rail = screen.getByRole('complementary', { name: 'Workbench' })
    fireEvent.click(within(rail).getByRole('button', { name: 'New Thread' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Import Project' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Open model settings' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Download Kody 0.1.7' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Collapse workbench sidebar' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Expand Thread list' }))

    expect(onNewThread).toHaveBeenCalledOnce()
    expect(onImportProject).toHaveBeenCalledOnce()
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(onUpdateAction).toHaveBeenCalledOnce()
    expect(onCollapse).toHaveBeenCalledOnce()
    expect(onExpandThreadList).toHaveBeenCalledOnce()
    expect(within(rail).getByRole('status').textContent).toContain('Local server connected')
  })
})

function renderWorkbench(overrides: Partial<Parameters<typeof WorkbenchRail>[0]> = {}) {
  return render(
    <WorkbenchRail
      threads={threads}
      projects={[project]}
      selection="new_progress"
      status={{ phase: 'connected' }}
      updateStatus={{ phase: 'available', currentVersion: '0.1.6', availableVersion: '0.1.7' }}
      threadListCollapsed={false}
      onSelectionChange={vi.fn()}
      onNewThread={vi.fn()}
      onImportProject={async () => undefined}
      onOpenSettings={vi.fn()}
      onUpdateAction={vi.fn()}
      onCollapse={vi.fn()}
      onExpandThreadList={vi.fn()}
      {...overrides}
    />
  )
}

function thread(
  id: string,
  status: Thread['status'],
  workflowState: Thread['workflow_state'] = 'deferred',
  defaultReferences: Thread['default_references'] = []
): Thread {
  return {
    id,
    title: id,
    workspace_id: `workspace-${id}`,
    status,
    workflow_state: workflowState,
    default_references: defaultReferences,
    created_at: now,
    updated_at: now
  }
}
