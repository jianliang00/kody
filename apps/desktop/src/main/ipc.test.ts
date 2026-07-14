import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    writeText: vi.fn(),
    openExternal: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  clipboard: { writeText: electron.writeText },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: electron.handle },
  shell: { openExternal: electron.openExternal }
}))

import type { ProviderProfileRecord, ProviderProfileUpdate } from '../shared/bridge'
import { registerIpcHandlers, validateProviderProfileUpdate } from './ipc'

const RENDERER_URL = 'http://127.0.0.1:5173/'

describe('provider and Codex IPC boundary', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.handle.mockClear()
  })

  it('strictly validates provider updates before they reach credential storage', () => {
    const valid = {
      name: 'OpenAI',
      kind: 'openai',
      defaultModel: 'gpt-test',
      customModels: ['gpt-test'],
      secret: 'write-only'
    }
    expect(validateProviderProfileUpdate(valid)).toEqual(valid)
    expect(() => validateProviderProfileUpdate({ ...valid, api_key: 'smuggled' }))
      .toThrow(/unsupported fields/)
    expect(() => validateProviderProfileUpdate({ ...valid, customModels: ['ok', 42] }))
      .toThrow(/custom models/)
    expect(() => validateProviderProfileUpdate({ ...valid, clearSecret: true }))
      .toThrow(/replaced and removed/)
    expect(() => validateProviderProfileUpdate(null)).toThrow(/must be an object/)
  })

  it('does not expose privileged provider or Codex control RPC through the generic bridge', async () => {
    const setup = registerWithStubs()
    const rpc = getHandler('kody:rpc')

    for (const [method, params] of [
      ['provider/configure', { id: 'attacker', api_key: 'must-not-cross' }],
      ['provider/remove', { provider_id: 'victim' }],
      ['provider/health', { provider_id: 'victim' }],
      ['codex/account/logout', {}],
      ['codex/account/login/start', { mode: 'browser' }]
    ] as const) {
      await expect(rpc(setup.event, method, params)).rejects.toThrow(/Unsupported Kody RPC method/)
    }
    expect(setup.server.rpc).not.toHaveBeenCalled()
  })

  it('serializes durable writes and runtime activation without reflecting secrets', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstActivation = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const profiles: Record<string, ProviderProfileRecord> = {
      First: profile('provider-first', 'First'),
      Second: profile('provider-second', 'Second')
    }
    const providerSettings = {
      snapshot: vi.fn(),
      upsert: vi.fn(async (update: ProviderProfileUpdate) => {
        events.push(`persist:${update.name}`)
        return profiles[update.name]!
      }),
      delete: vi.fn()
    }
    const configureProvider = vi.fn(async (configured: ProviderProfileRecord) => {
      events.push(`activate:${configured.name}`)
      expect(configured).not.toHaveProperty('secret')
      if (configured.name === 'First') await firstActivation
    })
    const setup = registerWithStubs({ providerSettings, configureProvider })
    const upsert = getHandler('kody:provider-settings:upsert')

    const first = Promise.resolve(upsert(setup.event, {
      name: 'First',
      kind: 'openai',
      defaultModel: 'gpt-first',
      secret: 'CANARY-first-secret'
    }))
    await vi.waitFor(() => expect(configureProvider).toHaveBeenCalledTimes(1))
    const second = Promise.resolve(upsert(setup.event, {
      name: 'Second',
      kind: 'openai',
      defaultModel: 'gpt-second',
      secret: 'CANARY-second-secret'
    }))
    await Promise.resolve()
    expect(providerSettings.upsert).toHaveBeenCalledTimes(1)

    releaseFirst()
    const results = await Promise.all([first, second])
    expect(events).toEqual([
      'persist:First',
      'activate:First',
      'persist:Second',
      'activate:Second'
    ])
    expect(JSON.stringify(results)).not.toContain('CANARY')
  })

  it('exposes only update state-machine actions to the trusted renderer', async () => {
    const updateManager = {
      getStatus: vi.fn(() => ({ phase: 'available', currentVersion: '0.1.1', availableVersion: '0.1.2' })),
      check: vi.fn(async () => ({ phase: 'up-to-date', currentVersion: '0.1.1' })),
      download: vi.fn(async () => ({ phase: 'downloading', currentVersion: '0.1.1', percent: 0 })),
      restartAndInstall: vi.fn(async () => undefined)
    }
    const setup = registerWithStubs({ updateManager })

    expect(getHandler('kody:update:get')(setup.event)).toMatchObject({ phase: 'available' })
    await expect(getHandler('kody:update:check')(setup.event)).resolves.toMatchObject({ phase: 'up-to-date' })
    await expect(getHandler('kody:update:download')(setup.event)).resolves.toMatchObject({ phase: 'downloading' })
    await getHandler('kody:update:restart-and-install')(setup.event)

    expect(updateManager.check).toHaveBeenCalledWith(true)
    expect(updateManager.download).toHaveBeenCalledOnce()
    expect(updateManager.restartAndInstall).toHaveBeenCalledOnce()
  })
})

function registerWithStubs(overrides: {
  providerSettings?: Record<string, unknown>
  configureProvider?: (profile: ProviderProfileRecord) => Promise<void>
  updateManager?: Record<string, unknown>
} = {}) {
  const frame = { url: RENDERER_URL }
  const webContents = { mainFrame: frame }
  const window = { isDestroyed: () => false, webContents }
  const event = { sender: webContents, senderFrame: frame }
  const server = {
    rpc: vi.fn(),
    getStatus: vi.fn(() => ({ phase: 'connected' }))
  }
  registerIpcHandlers({
    getWindow: () => window as never,
    rendererUrl: RENDERER_URL,
    server: server as never,
    providerSettings: (overrides.providerSettings ?? {
      snapshot: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn()
    }) as never,
    updateManager: (overrides.updateManager ?? {
      getStatus: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      restartAndInstall: vi.fn()
    }) as never,
    configureProvider: overrides.configureProvider ?? vi.fn(),
    removeProvider: vi.fn(),
    getCodexAccountStatus: vi.fn(),
    connectCodexAccount: vi.fn(),
    disconnectCodexAccount: vi.fn()
  })
  return { event, server }
}

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler ${channel}`)
  return handler
}

function profile(id: string, name: string): ProviderProfileRecord {
  return {
    id,
    name,
    kind: 'openai',
    defaultModel: `gpt-${name.toLowerCase()}`,
    customModels: [],
    hasSecret: true,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z'
  }
}
