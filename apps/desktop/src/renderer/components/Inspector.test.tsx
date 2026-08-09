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
  it('expands sections independently and keeps their panels mounted', () => {
    const { container } = render(<InspectorHarness />)
    const workspace = screen.getByRole('button', { name: 'Workspace' })
    const references = screen.getByRole('button', { name: 'Active references' })
    const processes = screen.getByRole('button', { name: 'Background processes' })
    const workspacePanel = container.querySelector<HTMLElement>('#right-rail-workspace-panel')
    const workspacePath = screen.getByText('/tmp/kody-workspace')

    expect(workspace.getAttribute('aria-expanded')).toBe('false')
    expect(references.getAttribute('aria-expanded')).toBe('false')
    expect(processes.getAttribute('aria-expanded')).toBe('false')
    expect(workspacePanel?.hidden).toBe(true)

    fireEvent.click(workspace)

    expect(workspace.getAttribute('aria-expanded')).toBe('true')
    expect(references.getAttribute('aria-expanded')).toBe('false')
    expect(processes.getAttribute('aria-expanded')).toBe('false')
    expect(workspacePanel?.hidden).toBe(false)
    expect(screen.getByText('/tmp/kody-workspace')).toBe(workspacePath)

    fireEvent.click(references)
    expect(workspace.getAttribute('aria-expanded')).toBe('true')
    expect(references.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(workspace)
    expect(workspace.getAttribute('aria-expanded')).toBe('false')
    expect(references.getAttribute('aria-expanded')).toBe('true')
    expect(workspacePanel?.hidden).toBe(true)
    expect(screen.getByText('/tmp/kody-workspace')).toBe(workspacePath)
  })
})

function InspectorHarness() {
  const [sections, setSections] = useState<RightRailSectionsState>({
    ...DEFAULT_RIGHT_RAIL_SECTIONS,
    context: false,
    projects: false
  })
  const setExpanded = (id: RightRailSectionId, expanded: boolean): void => {
    setSections((current) => updateRightRailSection(current, id, expanded))
  }

  return (
    <Inspector
      snapshot={snapshot()}
      threads={[]}
      projects={[]}
      draftReferences={[]}
      events={[]}
      open={false}
      modal={false}
      sections={sections}
      stoppingProcessIds={new Set()}
      processOutputCursors={{}}
      onClose={vi.fn()}
      onSectionExpandedChange={setExpanded}
      onCopyText={vi.fn(async () => undefined)}
      onReadProcessOutput={vi.fn()}
      onStopProcess={vi.fn()}
    />
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
