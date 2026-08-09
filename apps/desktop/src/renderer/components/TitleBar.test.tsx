import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TitleBar } from './TitleBar'

afterEach(cleanup)

describe('TitleBar', () => {
  it('hides the connected label while preserving retryable connection states', () => {
    const onRetry = vi.fn()
    const props = {
      platform: 'darwin' as const,
      darkTheme: false,
      railCollapsed: false,
      workbenchCollapsed: false,
      navigationDrawerOpen: false,
      showRightSidebar: false,
      rightSidebarExpanded: false,
      contextCount: 0,
      contextActive: false,
      workflowPending: false,
      onOpenRail: vi.fn(),
      onExpandWorkbench: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      onRetry,
      onToggleTheme: vi.fn(),
      onWorkflowChange: vi.fn(),
      onWindowAction: vi.fn()
    }
    const { rerender } = render(<TitleBar {...props} status={{ phase: 'connected' }} />)

    expect(screen.queryByText('Connected')).toBeNull()
    expect(document.querySelector('.server-pill')).toBeNull()

    rerender(<TitleBar {...props} status={{ phase: 'disconnected' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Server disconnected. Retry connection' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('marks the current Thread as Processed and restores it to New Progress', () => {
    const onWorkflowChange = vi.fn()
    const props = {
      status: { phase: 'connected' } as const,
      platform: 'darwin' as const,
      darkTheme: false,
      railCollapsed: false,
      workbenchCollapsed: false,
      navigationDrawerOpen: false,
      showRightSidebar: false,
      rightSidebarExpanded: false,
      contextCount: 0,
      contextActive: false,
      workflowPending: false,
      onOpenRail: vi.fn(),
      onExpandWorkbench: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      onRetry: vi.fn(),
      onToggleTheme: vi.fn(),
      onWorkflowChange,
      onWindowAction: vi.fn()
    }
    const thread = {
      id: 'thread-1',
      title: 'Todo Thread',
      workspace_id: 'workspace-1',
      status: 'idle' as const,
      workflow_state: 'new_progress' as const,
      default_references: [],
      created_at: '2026-08-09T00:00:00Z',
      updated_at: '2026-08-09T00:00:00Z'
    }
    const { rerender } = render(<TitleBar {...props} thread={thread} />)

    fireEvent.click(screen.getByRole('button', { name: 'Mark as Processed' }))
    expect(onWorkflowChange).toHaveBeenLastCalledWith('handled')

    rerender(<TitleBar {...props} thread={{ ...thread, workflow_state: 'handled' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore to New Progress' }))
    expect(onWorkflowChange).toHaveBeenLastCalledWith('new_progress')
  })
})
