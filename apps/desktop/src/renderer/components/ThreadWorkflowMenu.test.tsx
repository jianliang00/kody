import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Thread, ThreadWorkflowState } from '@shared/protocol'

import { ThreadWorkflowMenu } from './ThreadWorkflowMenu'

afterEach(cleanup)

const thread: Thread = {
  id: 'thread-native-controls',
  title: 'Native controls',
  workspace_id: 'workspace-native-controls',
  status: 'idle',
  workflow_state: 'new_progress',
  default_references: [],
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z'
}

describe('ThreadWorkflowMenu', () => {
  it('connects its trigger to a radio menu with the current workflow state', () => {
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu', { name: 'Manage Native controls' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)

    const items = within(menu).getAllByRole('menuitemradio')
    expect(items).toHaveLength(3)
    expect(within(menu).getByRole('menuitemradio', { name: 'Mark as New Progress' }).getAttribute('aria-checked'))
      .toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'Continue Later' }).getAttribute('aria-checked'))
      .toBe('false')
    expect(within(menu).getByRole('menuitemradio', { name: 'Mark as Processed' }).getAttribute('aria-checked'))
      .toBe('false')
  })

  it('supports arrow and boundary navigation, then restores trigger focus on Escape', async () => {
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Manage Native controls' })
    const current = within(menu).getByRole('menuitemradio', { name: 'Mark as New Progress' })
    const deferred = within(menu).getByRole('menuitemradio', { name: 'Continue Later' })
    const handled = within(menu).getByRole('menuitemradio', { name: 'Mark as Processed' })

    await waitFor(() => expect(document.activeElement).toBe(current))

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(deferred)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(handled)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(current)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(handled)
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(current)
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(handled)

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('restores focus to a stable list control after choosing a workflow action', async () => {
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    const stableFallback = screen.getByRole('button', { name: 'Stable workflow fallback' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Manage Native controls' })
    const handled = within(menu).getByRole('menuitemradio', { name: 'Mark as Processed' })

    fireEvent.click(handled)

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(stableFallback))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a stable focus target when the workflow mutation removes the Thread row', async () => {
    render(<Harness simulatePending />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    const stableFallback = screen.getByRole('button', { name: 'Stable workflow fallback' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Mark as Processed' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'More actions for Native controls' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(stableFallback))
  })

  it('lets the selected radio item receive focus and treats reselecting it as a no-op', async () => {
    const onWorkflowChange = vi.fn()
    render(<Harness onWorkflowChange={onWorkflowChange} />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    fireEvent.click(trigger)
    const current = screen.getByRole('menuitemradio', { name: 'Mark as New Progress' })
    await waitFor(() => expect(document.activeElement).toBe(current))

    fireEvent.click(current)

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(onWorkflowChange).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'Tab', shiftKey: false },
    { label: 'Shift+Tab', shiftKey: true }
  ])('closes and moves focus in document order on $label', async ({ shiftKey }) => {
    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'More actions for Native controls' })
    const expectedTarget = shiftKey
      ? screen.getByRole('button', { name: 'Open Native controls' })
      : screen.getByRole('button', { name: 'After workflow menu' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Manage Native controls' })

    await waitFor(() => expect(document.activeElement).not.toBe(trigger))
    const allowedDefaultNavigation = fireEvent.keyDown(menu, { key: 'Tab', shiftKey })

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(expectedTarget))
    expect(allowedDefaultNavigation).toBe(false)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

function Harness({
  simulatePending = false,
  onWorkflowChange = () => undefined
}: {
  simulatePending?: boolean
  onWorkflowChange?: (nextState: ThreadWorkflowState) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [rowVisible, setRowVisible] = useState(true)
  const [workflowState, setWorkflowState] = useState<ThreadWorkflowState>(thread.workflow_state)
  const stableFallbackRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button ref={stableFallbackRef} type="button">Stable workflow fallback</button>
      {rowVisible ? (
        <div className="asset-row">
          <button className="asset-row__open" type="button">Open Native controls</button>
          <ThreadWorkflowMenu
            thread={{ ...thread, workflow_state: workflowState }}
            open={open}
            pending={pending}
            focusFallbackRef={stableFallbackRef}
            onOpenChange={setOpen}
            onWorkflowChange={(nextState) => {
              setWorkflowState(nextState)
              if (simulatePending) {
                setPending(true)
                setRowVisible(false)
              }
              onWorkflowChange(nextState)
            }}
          />
        </div>
      ) : null}
      <button type="button">After workflow menu</button>
    </>
  )
}
