import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { AssetRail } from './AssetRail'

afterEach(cleanup)

describe('AssetRail', () => {
  it('owns settings and update controls alongside connection status', () => {
    const onClose = vi.fn()
    const onOpenSettings = vi.fn()
    const onUpdateAction = vi.fn()

    render(
      <AssetRail
        threads={[]}
        status={{ phase: 'connected' }}
        updateStatus={{ phase: 'available', currentVersion: '0.1.6', availableVersion: '0.1.7' }}
        open={false}
        onClose={onClose}
        onCollapse={vi.fn()}
        onNewThread={vi.fn()}
        onSelectThread={vi.fn()}
        onOpenSettings={onOpenSettings}
        onUpdateAction={onUpdateAction}
      />
    )

    const rail = screen.getByLabelText('Kody assets')
    const controls = within(rail).getByLabelText('Application controls')
    fireEvent.click(within(controls).getByRole('button', { name: 'Open model settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.click(within(controls).getByRole('button', { name: 'Download Kody 0.1.7' }))
    expect(onUpdateAction).toHaveBeenCalledOnce()
    expect(within(rail).getByRole('status').textContent).toContain('Local server connected')
  })
})
