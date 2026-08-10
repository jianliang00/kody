import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener
  }
}))

import type { KodyDesktopBridge, ProviderSettingsResult } from '../shared/bridge'

let bridge: KodyDesktopBridge

describe('desktop preload provider settings bridge', () => {
  beforeAll(async () => {
    await import('./index')
    bridge = electron.exposeInMainWorld.mock.calls[0]?.[1] as KodyDesktopBridge
  })

  beforeEach(() => {
    electron.invoke.mockReset()
  })

  it('exposes selected-provider updates only through the dedicated IPC channel', async () => {
    const snapshot: ProviderSettingsResult = {
      selectedProviderId: 'codex',
      profiles: [],
      credentialStorage: { available: true, backend: 'keychain' }
    }
    electron.invoke.mockResolvedValue(snapshot)

    await expect(bridge.setSelectedProvider('codex')).resolves.toEqual(snapshot)
    expect(electron.invoke).toHaveBeenLastCalledWith('kody:provider-settings:select', 'codex')

    await bridge.setSelectedProvider(null)
    expect(electron.invoke).toHaveBeenLastCalledWith('kody:provider-settings:select', null)
  })
})
