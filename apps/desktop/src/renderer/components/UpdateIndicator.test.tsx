import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { UpdateIndicator } from './UpdateIndicator'

afterEach(cleanup)

describe('UpdateIndicator', () => {
  it('offers download and restart actions at the relevant phases', () => {
    const onAction = vi.fn()
    const { rerender } = render(
      <UpdateIndicator
        status={{ phase: 'available', currentVersion: '0.1.1', availableVersion: '0.2.0' }}
        onAction={onAction}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download Kody 0.2.0' }))
    expect(onAction).toHaveBeenCalledOnce()

    rerender(
      <UpdateIndicator
        status={{ phase: 'downloaded', currentVersion: '0.1.1', availableVersion: '0.2.0' }}
        onAction={onAction}
      />
    )
    expect(screen.getByRole('button', { name: 'Restart and install Kody 0.2.0' })).toBeTruthy()
  })

  it('reports download progress without allowing duplicate actions', () => {
    render(
      <UpdateIndicator
        status={{ phase: 'downloading', currentVersion: '0.1.1', percent: 41.7 }}
        onAction={vi.fn()}
      />
    )
    const progress = screen.getByRole('button', { name: 'Downloading Kody update, 42%' }) as HTMLButtonElement
    expect(progress.disabled).toBe(true)
    expect(progress.textContent).toContain('42%')
  })

  it('stays out of the title bar while idle', () => {
    const { container } = render(
      <UpdateIndicator
        status={{ phase: 'idle', currentVersion: '0.1.1' }}
        onAction={vi.fn()}
      />
    )
    expect(container.childElementCount).toBe(0)
  })
})
