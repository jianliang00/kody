import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  reconcileStoredProviders,
  ProviderSettingsStore,
  type ProviderSettingsFileHandle,
  type ProviderSettingsFileSystem,
  type SafeStorageAdapter
} from './provider-settings'

describe('ProviderSettingsStore', () => {
  it('persists an explicitly disabled image provider across reloads', async () => {
    const fileSystem = new MemoryFileSystem()
    const safeStorage = new FakeSafeStorage('kwallet6')
    const store = createStore(fileSystem, safeStorage)
    const profile = await store.upsert({
      name: 'Text only OpenAI',
      kind: 'openai',
      defaultModel: 'gpt-text',
      imageModels: []
    })
    expect(profile.defaultImageModel).toBeUndefined()
    expect(fileSystem.contents('/state/provider-settings.json')).toContain('"defaultImageModel": ""')

    const reloaded = new ProviderSettingsStore({
      filePath: '/state/provider-settings.json',
      fileSystem,
      safeStorage,
      platform: 'linux'
    })
    expect((await reloaded.snapshot()).profiles[0]?.defaultImageModel).toBeUndefined()
  })

  it('encrypts a write-only canary and atomically persists private files', async () => {
    const fileSystem = new MemoryFileSystem()
    const safeStorage = new FakeSafeStorage('kwallet6')
    const store = createStore(fileSystem, safeStorage)
    const secret = 'CANARY-provider-secret-that-must-never-leak'

    const profile = await store.upsert({
      name: 'Team gateway',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      defaultModel: 'team-coder',
      customModels: ['team-coder-fast', 'team-coder'],
      secret
    })

    expect(profile).toMatchObject({
      id: 'profile-1',
      name: 'Team gateway',
      hasSecret: true
    })
    expect(JSON.stringify(profile)).not.toContain(secret)
    const serialized = fileSystem.contents('/state/provider-settings.json')
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('secret-that-must-never-leak')
    expect(await store.getSecret(profile.id)).toBe(secret)
    expect(JSON.stringify(await store.snapshot())).not.toContain(secret)
    expect(fileSystem.mode('/state')).toBe(0o700)
    expect(fileSystem.mode('/state/provider-settings.json')).toBe(0o600)
    expect(fileSystem.operations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^write:.*\.tmp-write-1:600:wx$/),
      expect.stringMatching(/^sync:.*\.tmp-write-1$/),
      expect.stringMatching(/^rename:.*\.tmp-write-1->\/state\/provider-settings\.json$/),
      'sync:/state'
    ]))

    const updated = await store.upsert({
      id: profile.id,
      name: 'Team gateway 2',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      defaultModel: 'team-coder',
      customModels: [],
      secret: ''
    })
    expect(updated.hasSecret).toBe(true)
    expect(await store.getSecret(profile.id)).toBe(secret)

    await store.delete(profile.id)
    expect((await store.snapshot()).profiles).toEqual([])
  })

  it('fails closed when Linux safeStorage selects basic_text', async () => {
    const fileSystem = new MemoryFileSystem()
    const safeStorage = new FakeSafeStorage('basic_text')
    const store = createStore(fileSystem, safeStorage, 'linux')

    expect(store.credentialStorageStatus()).toEqual({
      available: false,
      backend: 'basic_text',
      reason: 'Linux secret storage is using the insecure basic_text backend.'
    })
    await expect(store.upsert({
      name: 'Unsafe provider',
      kind: 'openai',
      defaultModel: 'gpt-test',
      secret: 'CANARY-must-not-be-encrypted-with-basic-text'
    })).rejects.toThrow(/basic_text/)
    expect(safeStorage.encryptionCalls).toBe(0)
    expect(fileSystem.operations.some((operation) => operation.startsWith('write:'))).toBe(false)

    const metadataOnly = await store.upsert({
      name: 'Account profile',
      kind: 'openai',
      defaultModel: 'codex-default'
    })
    expect(metadataOnly.hasSecret).toBe(false)

    const encryptor = new FakeSafeStorage('kwallet6')
    const encryptedSecret = encryptor.encryptString('CANARY-existing-secret').toString('base64')
    fileSystem.seed('/state/existing-settings.json', JSON.stringify({
      version: 1,
      profiles: [{
        id: 'existing-profile',
        name: 'Existing provider',
        kind: 'openai',
        defaultModel: 'gpt-test',
        customModels: [],
        encryptedSecret,
        createdAt: '2026-07-13T00:00:00.000Z',
        updatedAt: '2026-07-13T00:00:00.000Z'
      }]
    }), 0o600)
    const existingStore = new ProviderSettingsStore({
      filePath: '/state/existing-settings.json',
      fileSystem,
      safeStorage,
      platform: 'linux'
    })
    await expect(existingStore.getSecret('existing-profile')).rejects.toThrow(/basic_text/)
    expect(safeStorage.decryptionCalls).toBe(0)
  })

  it('does not replace a corrupt settings file with a fresh document', async () => {
    const fileSystem = new MemoryFileSystem()
    fileSystem.seed('/state/provider-settings.json', '{ definitely-not-json', 0o600)
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))

    await expect(store.snapshot()).rejects.toThrow(/invalid JSON/)
    await expect(store.upsert({
      name: 'Would overwrite',
      kind: 'openai',
      defaultModel: 'test'
    })).rejects.toThrow(/invalid JSON/)
    expect(fileSystem.contents('/state/provider-settings.json')).toBe('{ definitely-not-json')
    expect(fileSystem.operations.some((operation) => operation.startsWith('rename:'))).toBe(false)
  })

  it('requires encrypted transport except for exact loopback HTTP hosts', async () => {
    const fileSystem = new MemoryFileSystem()
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))

    await expect(store.upsert({
      name: 'Remote plaintext gateway',
      kind: 'openai-compatible',
      baseUrl: 'http://models.example.test/v1',
      defaultModel: 'coder'
    })).rejects.toThrow(/HTTPS unless it targets localhost/)
    await expect(store.upsert({
      name: 'Hostname lookalike',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost.example.test/v1',
      defaultModel: 'coder'
    })).rejects.toThrow(/HTTPS unless it targets localhost/)
    await expect(store.upsert({
      name: 'Query credential',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1?api_key=not-allowed',
      defaultModel: 'coder'
    })).rejects.toThrow(/query string or fragment/)

    for (const [index, baseUrl] of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1'
    ].entries()) {
      const localStore = new ProviderSettingsStore({
        filePath: `/state/local-${index}.json`,
        fileSystem,
        safeStorage: new FakeSafeStorage('kwallet6'),
        platform: 'linux',
        createId: () => `local-${index}`,
        createTemporaryToken: () => `local-write-${index}`
      })
      await expect(localStore.upsert({
        name: `Local ${index}`,
        kind: 'openai-compatible',
        baseUrl,
        defaultModel: 'coder'
      })).resolves.toMatchObject({ baseUrl })
    }
  })

  it('rejects profiles that collide with built-in providers', async () => {
    const fileSystem = new MemoryFileSystem()
    const store = new ProviderSettingsStore({
      filePath: '/state/provider-settings.json',
      fileSystem,
      safeStorage: new FakeSafeStorage('kwallet6'),
      platform: 'linux',
      createId: () => 'codex',
      createTemporaryToken: () => 'reserved-write'
    })
    await expect(store.upsert({
      name: 'Built-in collision',
      kind: 'openai',
      defaultModel: 'coder'
    })).rejects.toThrow(/reserved for a built-in provider/)
    expect(fileSystem.operations.some((operation) => operation.startsWith('write:'))).toBe(false)
  })

  it('does not unlink a colliding temporary file it did not create', async () => {
    const fileSystem = new MemoryFileSystem()
    const temporary = '/state/provider-settings.json.tmp-write-1'
    fileSystem.seed(temporary, 'owned by another writer', 0o600)
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))

    await expect(store.upsert({
      name: 'Collision',
      kind: 'openai',
      defaultModel: 'coder'
    })).rejects.toThrow(/EEXIST/)
    expect(fileSystem.contents(temporary)).toBe('owned by another writer')
    expect(fileSystem.operations).not.toContain(`unlink:${temporary}`)
  })

  it('shares first load across concurrent readers and tightens legacy permissions', async () => {
    const fileSystem = new MemoryFileSystem()
    fileSystem.seed('/state/provider-settings.json', JSON.stringify({
      version: 1,
      profiles: []
    }), 0o644)
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))

    await Promise.all([
      store.snapshot(),
      store.snapshot(),
      store.upsert({
        name: 'Concurrent provider',
        kind: 'openai',
        defaultModel: 'gpt-test'
      })
    ])

    expect(fileSystem.readCalls).toBe(1)
    expect(fileSystem.mode('/state')).toBe(0o700)
    expect(fileSystem.mode('/state/provider-settings.json')).toBe(0o600)
    expect((await store.snapshot()).profiles).toHaveLength(1)
  })

  it('reconciles stale runtime providers before activating every durable profile', async () => {
    const fileSystem = new MemoryFileSystem()
    let nextId = 0
    const store = new ProviderSettingsStore({
      filePath: '/state/provider-settings.json',
      fileSystem,
      safeStorage: new FakeSafeStorage('kwallet6'),
      platform: 'linux',
      createId: () => `profile-${++nextId}`,
      createTemporaryToken: () => `reconcile-${nextId}`
    })
    await store.upsert({
      name: 'Primary',
      kind: 'openai',
      defaultModel: 'gpt-primary',
      secret: 'CANARY-primary'
    })
    await store.upsert({
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'local-coder',
      secret: 'CANARY-local'
    })

    const calls: Array<{ method: string; params: unknown }> = []
    const activationErrors: unknown[] = []
    await reconcileStoredProviders(store, async (method, params) => {
      calls.push({ method, params })
      if (method === 'provider/list') {
        return {
          providers: [
            { id: 'echo' },
            { id: 'codex' },
            { id: 'stale-provider' },
            { id: 'profile-1' }
          ]
        }
      }
      return {}
    }, (_profile, error) => activationErrors.push(error))

    expect(calls.map(({ method }) => method)).toEqual([
      'provider/list',
      'provider/remove',
      'provider/remove',
      'provider/configure',
      'provider/configure'
    ])
    expect(calls.slice(1, 3).map(({ params }) => params)).toEqual([
      { provider_id: 'stale-provider' },
      { provider_id: 'profile-1' }
    ])
    expect(calls[3]?.params).toMatchObject({
      id: 'profile-1',
      api_key: 'CANARY-primary'
    })
    expect(calls[4]?.params).toMatchObject({
      id: 'profile-2',
      api_key: 'CANARY-local'
    })
    expect(activationErrors).toEqual([])
  })

  it('treats provider control-channel failures as connection-fatal', async () => {
    const fileSystem = new MemoryFileSystem()
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))
    await store.upsert({
      name: 'Provider',
      kind: 'openai',
      defaultModel: 'gpt-test'
    })
    const activationError = vi.fn()

    await expect(reconcileStoredProviders(store, async (method) => {
      if (method === 'provider/list') return { providers: [{ id: 'echo' }, { id: 'codex' }] }
      throw new Error('control socket closed')
    }, activationError)).rejects.toThrow(/control socket closed/)
    expect(activationError).not.toHaveBeenCalled()
  })

  it('keeps settings mutations behind the complete reconnect reconciliation barrier', async () => {
    const fileSystem = new MemoryFileSystem()
    const store = createStore(fileSystem, new FakeSafeStorage('kwallet6'))
    let releaseCatalog!: (value: unknown) => void
    let catalogRequested!: () => void
    const catalogStarted = new Promise<void>((resolve) => {
      catalogRequested = resolve
    })
    const catalog = new Promise<unknown>((resolve) => {
      releaseCatalog = resolve
    })
    const reconciliation = reconcileStoredProviders(store, async (method) => {
      if (method === 'provider/list') {
        catalogRequested()
        return catalog
      }
      return {}
    }, () => undefined)
    await catalogStarted

    let saveCompleted = false
    const save = store.upsert({
      name: 'Arrived during reconnect',
      kind: 'openai',
      defaultModel: 'gpt-test'
    }).then(() => {
      saveCompleted = true
    })
    await Promise.resolve()
    expect(saveCompleted).toBe(false)

    releaseCatalog({ providers: [{ id: 'echo' }, { id: 'codex' }] })
    await Promise.all([reconciliation, save])
    expect(saveCompleted).toBe(true)
  })

  it('enforces private modes with the real filesystem adapter', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'kody-provider-settings-'))
    const directory = join(root, 'private')
    const filePath = join(directory, 'providers.json')
    try {
      const store = new ProviderSettingsStore({
        filePath,
        safeStorage: new FakeSafeStorage('keychain'),
        platform: process.platform,
        createId: () => 'real-profile',
        createTemporaryToken: () => 'real-write'
      })
      await store.upsert({
        name: 'Private provider',
        kind: 'openai',
        defaultModel: 'claude-test',
        secret: 'CANARY-real-filesystem'
      })
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function createStore(
  fileSystem: MemoryFileSystem,
  safeStorage: FakeSafeStorage,
  platform: NodeJS.Platform = 'linux'
): ProviderSettingsStore {
  let temporary = 0
  return new ProviderSettingsStore({
    filePath: '/state/provider-settings.json',
    fileSystem,
    safeStorage,
    platform,
    now: () => new Date('2026-07-13T00:00:00.000Z'),
    createId: () => 'profile-1',
    createTemporaryToken: () => `write-${++temporary}`
  })
}

class FakeSafeStorage implements SafeStorageAdapter {
  encryptionCalls = 0
  decryptionCalls = 0

  constructor(private readonly backend: string, private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  encryptString(plaintext: string): Buffer {
    this.encryptionCalls += 1
    return Buffer.from([...Buffer.from(plaintext)].map((byte) => byte ^ 0xa5))
  }

  decryptString(ciphertext: Buffer): string {
    this.decryptionCalls += 1
    return Buffer.from([...ciphertext].map((byte) => byte ^ 0xa5)).toString('utf8')
  }
}

interface MemoryEntry {
  contents?: string
  mode: number
  directory: boolean
}

class MemoryFileSystem implements ProviderSettingsFileSystem {
  readonly operations: string[] = []
  readCalls = 0
  readonly #entries = new Map<string, MemoryEntry>([
    ['/', { mode: 0o700, directory: true }]
  ])

  async readFile(path: string): Promise<string> {
    this.readCalls += 1
    const entry = this.#entries.get(path)
    if (!entry || entry.directory) throw fileSystemError('ENOENT')
    return entry.contents ?? ''
  }

  async mkdir(path: string, options: { recursive: true; mode: number }): Promise<void> {
    this.operations.push(`mkdir:${path}:${options.mode.toString(8)}`)
    this.#entries.set(path, { mode: options.mode, directory: true })
  }

  async writeFile(
    path: string,
    contents: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' }
  ): Promise<void> {
    if (this.#entries.has(path)) throw fileSystemError('EEXIST')
    if (!this.#entries.get(dirname(path))?.directory) throw fileSystemError('ENOENT')
    this.operations.push(`write:${path}:${options.mode.toString(8)}:${options.flag}`)
    this.#entries.set(path, { contents, mode: options.mode, directory: false })
  }

  async chmod(path: string, mode: number): Promise<void> {
    const entry = this.#entries.get(path)
    if (!entry) throw fileSystemError('ENOENT')
    entry.mode = mode
    this.operations.push(`chmod:${path}:${mode.toString(8)}`)
  }

  async rename(from: string, to: string): Promise<void> {
    const entry = this.#entries.get(from)
    if (!entry) throw fileSystemError('ENOENT')
    this.#entries.set(to, entry)
    this.#entries.delete(from)
    this.operations.push(`rename:${from}->${to}`)
  }

  async unlink(path: string): Promise<void> {
    if (!this.#entries.delete(path)) throw fileSystemError('ENOENT')
    this.operations.push(`unlink:${path}`)
  }

  async open(path: string, _flags: 'r'): Promise<ProviderSettingsFileHandle> {
    const entry = this.#entries.get(path)
    if (!entry) throw fileSystemError('ENOENT')
    return {
      sync: async () => {
        this.operations.push(`sync:${path}`)
      },
      close: async () => {
        this.operations.push(`close:${path}`)
      },
      chmod: async (mode) => {
        entry.mode = mode
        this.operations.push(`handle-chmod:${path}:${mode.toString(8)}`)
      }
    }
  }

  seed(path: string, contents: string, mode: number): void {
    this.#entries.set(dirname(path), { mode: 0o700, directory: true })
    this.#entries.set(path, { contents, mode, directory: false })
  }

  contents(path: string): string {
    const entry = this.#entries.get(path)
    if (!entry || entry.directory) throw new Error(`No file at ${path}`)
    return entry.contents ?? ''
  }

  mode(path: string): number {
    const entry = this.#entries.get(path)
    if (!entry) throw new Error(`No entry at ${path}`)
    return entry.mode
  }
}

function fileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}
