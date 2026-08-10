import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ThreadSnapshot } from '@shared/protocol'
import {
  DEFAULT_RIGHT_RAIL_SECTIONS,
  updateRightRailSection,
  type RightRailSectionId,
  type RightRailSectionsState
} from '../lib/rightRailSections'
import { Inspector } from './Inspector'

const now = '2026-08-09T00:00:00.000Z'

afterEach(cleanup)

describe('Inspector disclosures', () => {
  it('keeps the Context overview and expands only unique detail sections', () => {
    const { container } = render(<InspectorHarness />)
    const workspace = screen.getByRole('button', { name: 'Workspace' })
    const changes = screen.getByRole('button', { name: 'Changed files' })
    const timeline = screen.getByRole('button', { name: 'Execution timeline' })
    const workspacePanel = container.querySelector<HTMLElement>('#right-rail-workspace-panel')
    const workspacePath = screen.getByText('/tmp/kody-workspace')

    expect(screen.getByTestId('context-overview')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Active references' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Background processes' })).toBeNull()
    expect(workspace.getAttribute('aria-expanded')).toBe('false')
    expect(changes.getAttribute('aria-expanded')).toBe('false')
    expect(timeline.getAttribute('aria-expanded')).toBe('false')
    expect(workspacePanel?.hidden).toBe(true)

    fireEvent.click(workspace)

    expect(workspace.getAttribute('aria-expanded')).toBe('true')
    expect(changes.getAttribute('aria-expanded')).toBe('false')
    expect(workspacePanel?.hidden).toBe(false)
    expect(screen.getByText('/tmp/kody-workspace')).toBe(workspacePath)
    expect(workspacePath.parentElement?.getAttribute('role')).toBe('region')
    expect(workspacePath.parentElement?.getAttribute('aria-label')).toBe('Workspace path')
    expect(workspacePath.parentElement?.getAttribute('tabindex')).toBe('0')

    fireEvent.click(changes)
    expect(workspace.getAttribute('aria-expanded')).toBe('true')
    expect(changes.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(workspace)
    expect(workspace.getAttribute('aria-expanded')).toBe('false')
    expect(changes.getAttribute('aria-expanded')).toBe('true')
    expect(workspacePanel?.hidden).toBe(true)
    expect(screen.getByText('/tmp/kody-workspace')).toBe(workspacePath)
  })
})

function InspectorHarness() {
  const [sections, setSections] = useState<RightRailSectionsState>({
    ...DEFAULT_RIGHT_RAIL_SECTIONS,
    context: false
  })
  const setExpanded = (id: RightRailSectionId, expanded: boolean): void => {
    setSections((current) => updateRightRailSection(current, id, expanded))
  }

  return (
    <Inspector
      snapshot={snapshot()}
      projects={[]}
      events={[]}
      open={false}
      modal={false}
      sections={sections}
      onClose={vi.fn()}
      onSectionExpandedChange={setExpanded}
      onCopyText={vi.fn(async () => undefined)}
    >
      <div data-testid="context-overview" />
    </Inspector>
  )
}

function snapshot(): ThreadSnapshot {
  return {
    thread: {
      id: 'thread-current',
      title: 'Current Thread',
      workspace_id: 'workspace-current',
      status: 'idle',
      workflow_state: 'deferred',
      default_references: [],
      created_at: now,
      updated_at: now
    },
    workspace: {
      id: 'workspace-current',
      thread_id: 'thread-current',
      root: '/tmp/kody-workspace',
      created_at: now
    },
    messages: [],
    turns: [],
    pending_approvals: [],
    pending_user_inputs: [],
    processes: [],
    artifacts: []
  }
}
