import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReferenceChips } from './ReferenceChips'

afterEach(cleanup)

describe('ReferenceChips', () => {
  it('changes project access through the shared Kody select', () => {
    const onChange = vi.fn()
    render(
      <ReferenceChips
        references={[{ kind: 'project', project_id: 'project-app', access: 'read_only' }]}
        threads={[]}
        projects={[{
          id: 'project-app',
          name: 'App',
          root: '/code/app',
          kind: 'directory',
          created_at: '2026-07-16T00:00:00.000Z'
        }]}
        onChange={onChange}
      />
    )

    const trigger = screen.getByRole('combobox', { name: 'App context mode' })
    expect(trigger.getAttribute('data-value')).toBe('read_only')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'Read & write' }))
    expect(onChange).toHaveBeenCalledWith({
      kind: 'project',
      project_id: 'project-app',
      access: 'read_write'
    })
  })
})
