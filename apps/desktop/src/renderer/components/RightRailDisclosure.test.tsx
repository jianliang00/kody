import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RightRailDisclosure } from './RightRailDisclosure'

afterEach(cleanup)

describe('RightRailDisclosure', () => {
  it('connects the toggle and persistent panel with accessible disclosure attributes', () => {
    const onExpandedChange = vi.fn()
    const { container } = render(
      <RightRailDisclosure
        id="workspace-disclosure"
        title="Workspace"
        eyebrow="Ephemeral runtime"
        badge={<span>3</span>}
        expanded
        onExpandedChange={onExpandedChange}
        className="workspace-card"
      >
        <p>Workspace details</p>
      </RightRailDisclosure>
    )

    const section = container.querySelector<HTMLElement>('#workspace-disclosure')
    const toggle = screen.getByRole('button', { name: 'Workspace' })
    const panel = container.querySelector<HTMLElement>('#workspace-disclosure-panel')

    expect(section?.tagName).toBe('DIV')
    expect(section?.classList.contains('right-rail-disclosure--expanded')).toBe(true)
    expect(section?.classList.contains('workspace-card')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe('workspace-disclosure-panel')
    expect(panel?.getAttribute('role')).toBe('region')
    expect(panel?.getAttribute('aria-labelledby')).toBe('workspace-disclosure-title')
    expect(panel?.hidden).toBe(false)
    expect(screen.getByText('Ephemeral runtime')).toBeTruthy()
    expect(toggle.contains(screen.getByText('3'))).toBe(true)
  })

  it('collapses with a mouse click while keeping children mounted in a hidden panel', () => {
    render(<DisclosureHarness />)

    const toggle = screen.getByRole('button', { name: 'Activity' })
    const child = screen.getByTestId('persistent-child')
    const panel = document.getElementById('activity-disclosure-panel') as HTMLElement

    expect(panel.hidden).toBe(false)
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('persistent-child')).toBe(child)
    expect(panel.hidden).toBe(true)
  })

  it.each(['Enter', ' '])('toggles with the %s key', (key) => {
    render(<DisclosureHarness initialExpanded={false} />)

    const toggle = screen.getByRole('button', { name: 'Activity' })
    toggle.focus()
    fireEvent.keyDown(toggle, { key })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('activity-disclosure-panel')?.hidden).toBe(false)
  })

  it('keeps header actions independent from the disclosure toggle', () => {
    const onExpandedChange = vi.fn()
    const onAction = vi.fn()

    render(
      <RightRailDisclosure
        id="files-disclosure"
        title="Changed files"
        expanded
        onExpandedChange={onExpandedChange}
        actions={<button type="button" onClick={onAction}>Copy files</button>}
      >
        <p>README.md</p>
      </RightRailDisclosure>
    )

    const toggle = screen.getByRole('button', { name: 'Changed files' })
    const action = screen.getByRole('button', { name: 'Copy files' })

    expect(toggle.contains(action)).toBe(false)
    fireEvent.click(action)

    expect(onAction).toHaveBeenCalledOnce()
    expect(onExpandedChange).not.toHaveBeenCalled()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

function DisclosureHarness({ initialExpanded = true }: { initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded)

  return (
    <RightRailDisclosure
      id="activity-disclosure"
      title="Activity"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <p data-testid="persistent-child">Live activity</p>
    </RightRailDisclosure>
  )
}
