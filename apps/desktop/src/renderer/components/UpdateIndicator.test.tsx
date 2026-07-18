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
    const downloadButton = screen.getByRole('button', { name: 'Download Kody 0.2.0' })
    expect(downloadButton.querySelectorAll('svg')).toHaveLength(1)
    expect(downloadButton.textContent).toBe('Download')
    fireEvent.click(downloadButton)
    expect(onAction).toHaveBeenCalledOnce()

    rerender(
      <UpdateIndicator
        status={{ phase: 'downloaded', currentVersion: '0.1.1', availableVersion: '0.2.0' }}
        onAction={onAction}
      />
    )
    expect(screen.getByRole('button', { name: 'Restart and install Kody 0.2.0' }).textContent).toBe('Restart')
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
    expect(progress.textContent).toBe('Downloading 42%')
  })

  it('keeps the current update state visible while idle', () => {
    render(
      <UpdateIndicator
        status={{ phase: 'idle', currentVersion: '0.1.1', checkedAt: '2026-07-15T00:00:00Z' }}
        onAction={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'v0.1.1 is up to date. Check again' }).textContent).toBe('Check again')
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('v0.1.1 is up to date.')
  })

  it.each([
    [{ phase: 'idle', currentVersion: '0.1.1' } as const, 'Check for Kody updates', 'Check updates'],
    [{ phase: 'checking', currentVersion: '0.1.1' } as const, 'Checking for Kody updates', 'Checking…'],
    [{ phase: 'up-to-date', currentVersion: '0.1.1' } as const, 'Kody is up to date. Check again', 'Check again'],
    [{ phase: 'error', currentVersion: '0.1.1' } as const, 'Update check failed. Try again', 'Try again']
  ])('shows the next update action for %s', (status, accessibleName, actionText) => {
    render(<UpdateIndicator status={status} onAction={vi.fn()} />)
    expect(screen.getByRole('button', { name: accessibleName }).textContent).toBe(actionText)
  })

  it('explains when updates are unavailable without exposing an action', () => {
    render(
      <UpdateIndicator
        status={{ phase: 'disabled', currentVersion: '0.1.1' }}
        onAction={vi.fn()}
      />
    )
    const indicator = screen.getByRole('button', { name: 'Kody updates unavailable' }) as HTMLButtonElement
    expect(indicator.disabled).toBe(true)
    expect(indicator.textContent).toBe('Unavailable')
    expect(indicator.classList).toContain('update-status')
  })
})
