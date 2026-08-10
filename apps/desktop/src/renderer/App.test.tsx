import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { createMockBridge } from './lib/mockBridge'

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
  Object.defineProperty(window, 'kody', {
    configurable: true,
    value: createMockBridge()
  })
})

afterEach(cleanup)

describe('command approval lifecycle', () => {
  it('removes an approval card after Allow once is accepted', async () => {
    render(<App />)

    const workbench = await screen.findByRole('complementary', { name: 'Workbench' })
    const newThread = within(workbench).getByRole('button', { name: 'New Thread' })
    fireEvent.click(newThread)

    const composer = await screen.findByRole('combobox', { name: 'Message' })
    fireEvent.change(composer, { target: { value: 'Run cargo test for this project' } })
    await screen.findByRole('button', { name: 'Model options: Codex default' })
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Permission mode' }).getAttribute('data-value')).toBe('ask')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const allowOnce = await screen.findByRole('button', { name: 'Allow once' }, { timeout: 10_000 })
    fireEvent.click(allowOnce)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Command permission required' })).toBeNull()
    }, { timeout: 5_000 })
  }, 30_000)
})

describe('Thread todo workflow', () => {
  it('keeps the active conversation open while moving it between workflow views', async () => {
    render(<App />)

    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'Shape the Electron workspace'
    })
    const markProcessed = await screen.findByRole('button', { name: 'Mark as Processed' })
    fireEvent.click(markProcessed)

    await screen.findByRole('button', { name: 'Restore to New Progress' })
    expect(title).toBeTruthy()
    expect(screen.getByText('No Threads in New Progress', { exact: true })).toBeTruthy()

    const workbench = screen.getByRole('complementary', { name: 'Workbench' })
    fireEvent.click(within(workbench).getByRole('button', { name: /Processed\s*2/ }))
    expect(await within(screen.getByLabelText('Threads')).findByText('Shape the Electron workspace'))
      .toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore to New Progress' }))
    await screen.findByRole('button', { name: 'Mark as Processed' })

    const snapshot = await window.kody!.rpc('thread/get', { thread_id: 'thread-electron' })
    expect(snapshot.thread.workflow_state).toBe('new_progress')
  })
})

describe('Provider bootstrap compatibility', () => {
  it('keeps Codex available when renderer HMR is ahead of the preload bridge', async () => {
    const bridge = createMockBridge()
    bridge.getProviderSettings = async () => ({
      profiles: [],
      credentialStorage: { available: true, backend: 'browser-preview' }
    })
    Object.defineProperty(bridge, 'setSelectedProvider', {
      configurable: true,
      value: undefined
    })
    Object.defineProperty(window, 'kody', {
      configurable: true,
      value: bridge
    })

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Model options: Codex default' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Kody could not start' })).toBeNull()
  })

  it('only reads the Codex account when Codex is the selected Provider', async () => {
    const bridge = createMockBridge()
    bridge.getProviderSettings = async () => ({
      selectedProviderId: 'echo',
      profiles: [],
      credentialStorage: { available: true, backend: 'browser-preview' }
    })
    const getCodexAccountStatus = vi.fn(bridge.getCodexAccountStatus)
    bridge.getCodexAccountStatus = getCodexAccountStatus
    Object.defineProperty(window, 'kody', {
      configurable: true,
      value: bridge
    })

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open model settings' }))
    expect(await screen.findByRole('heading', { name: 'Echo demo' })).toBeTruthy()
    expect(getCodexAccountStatus).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Codex account' }))
    await waitFor(() => expect(getCodexAccountStatus).toHaveBeenCalledTimes(1))
  })
})
