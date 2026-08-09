import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project } from '@shared/protocol'
import { ProjectShelf } from './ProjectShelf'

const project: Project = {
  id: 'project-kody',
  name: 'Kody',
  root: '/code/kody',
  kind: 'git',
  created_at: '2026-08-09T00:00:00.000Z'
}

afterEach(cleanup)

describe('ProjectShelf', () => {
  it('traps focus within visible controls when its disclosure is collapsed', () => {
    const onOpenChange = vi.fn()

    render(
      <ProjectShelf
        projects={[project]}
        selectedProjectIds={new Set()}
        open
        expanded={false}
        onOpenChange={onOpenChange}
        onExpandedChange={vi.fn()}
        onImportProject={async () => undefined}
        onAddProject={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog')
    const disclosureToggle = within(dialog).getByRole('button', { name: 'Projects' })
    const closeButton = within(dialog).getByRole('button', { name: 'Close Projects' })
    const hiddenProjectButton = within(dialog).getByRole('button', {
      name: 'Add Kody as read-only context',
      hidden: true
    })

    expect(document.activeElement).toBe(disclosureToggle)
    expect(hiddenProjectButton.closest('[hidden]')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton)
    expect(document.activeElement).not.toBe(hiddenProjectButton)

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(disclosureToggle)

    const launcher = document.querySelector<HTMLButtonElement>('.project-shelf-launcher')
    launcher?.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(disclosureToggle)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens from the compact launcher without overwriting the persisted disclosure state', () => {
    const onOpenChange = vi.fn()
    const onExpandedChange = vi.fn()

    const { container } = render(
      <ProjectShelf
        projects={[]}
        selectedProjectIds={new Set()}
        open={false}
        expanded={false}
        onOpenChange={onOpenChange}
        onExpandedChange={onExpandedChange}
        onImportProject={async () => undefined}
        onAddProject={vi.fn()}
      />
    )

    const launcher = container.querySelector<HTMLButtonElement>('.project-shelf-launcher')
    expect(launcher).not.toBeNull()
    fireEvent.click(launcher!)

    expect(onExpandedChange).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('does not steal focus back when another surface takes focus while closing', () => {
    const props = {
      projects: [project],
      selectedProjectIds: new Set<string>(),
      expanded: true,
      onOpenChange: vi.fn(),
      onExpandedChange: vi.fn(),
      onImportProject: async () => undefined,
      onAddProject: vi.fn()
    }
    const { rerender } = render(
      <>
        <button type="button">Thread search</button>
        <ProjectShelf {...props} open />
      </>
    )
    const externalTarget = screen.getByRole('button', { name: 'Thread search' })
    externalTarget.focus()

    rerender(
      <>
        <button type="button">Thread search</button>
        <ProjectShelf {...props} open={false} />
      </>
    )

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Thread search' }))
  })
})
