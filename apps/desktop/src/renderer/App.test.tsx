import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  })
  HTMLElement.prototype.scrollTo = vi.fn()
})

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(cleanup)

describe('command approval lifecycle', () => {
  it('removes an approval card after Allow once is accepted', async () => {
    render(<App />)

    const newThread = await screen.findByRole('button', { name: 'New Thread' })
    fireEvent.click(newThread)

    const composer = await screen.findByRole('combobox', { name: 'Message' })
    fireEvent.change(composer, { target: { value: 'Run cargo test for this project' } })
    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Echo demo' }))
    expect(screen.getByRole('combobox', { name: 'Permission mode' }).getAttribute('data-value')).toBe('ask')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const allowOnce = await screen.findByRole('button', { name: 'Allow once' }, { timeout: 10_000 })
    fireEvent.click(allowOnce)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Command permission required' })).toBeNull()
    }, { timeout: 5_000 })
  })
})
