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
      showRightSidebar: false,
      rightSidebarExpanded: false,
      contextCount: 0,
      contextActive: false,
      onOpenRail: vi.fn(),
      onToggleRightSidebar: vi.fn(),
      onRetry,
      onToggleTheme: vi.fn(),
      onWindowAction: vi.fn()
    }
    const { rerender } = render(<TitleBar {...props} status={{ phase: 'connected' }} />)

    expect(screen.queryByText('Connected')).toBeNull()
    expect(document.querySelector('.server-pill')).toBeNull()

    rerender(<TitleBar {...props} status={{ phase: 'disconnected' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Server disconnected. Retry connection' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
