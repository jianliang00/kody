import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { dirname } from 'node:path'

export const PROVIDER_SETTINGS_VERSION = 1 as const

export type ProviderKind = 'openai' | 'openai-compatible'

export interface ProviderProfile {
  id: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  defaultModel: string
  customModels: string[]
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface ProviderProfileInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  defaultModel: string
  customModels?: string[]
  /** Write-only. It is never included in a returned profile or persisted as plaintext. */
  secret?: string
  clearSecret?: boolean
}

export interface CredentialStorageStatus {
  available: boolean
  backend?: string
  reason?: string
}

export interface ProviderSettingsSnapshot {
  profiles: ProviderProfile[]
  credentialStorage: CredentialStorageStatus
}

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface ProviderSettingsFileHandle {
  sync(): Promise<void>
  close(): Promise<void>
  chmod(mode: number): Promise<void>
}

export interface ProviderSettingsFileSystem {
  readFile(path: string): Promise<string>
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  writeFile(
    path: string,
    contents: string,
    options: { encoding: 'utf8'; mode: number; flag: 'wx' }
  ): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  open(path: string, flags: 'r'): Promise<ProviderSettingsFileHandle>
}

interface StoredProviderProfile {
  id: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  defaultModel: string
  customModels: string[]
  encryptedSecret?: string
  createdAt: string
  updatedAt: string
}

interface ProviderSettingsDocument {
  version: typeof PROVIDER_SETTINGS_VERSION
  profiles: StoredProviderProfile[]
}

export interface ProviderSettingsStoreOptions {
  filePath: string
  safeStorage: SafeStorageAdapter
  fileSystem?: ProviderSettingsFileSystem
  platform?: NodeJS.Platform
  now?: () => Date
  createId?: () => string
  createTemporaryToken?: () => string
}

export type ProviderControlRpc = (method: string, params: unknown) => Promise<unknown>

const PROVIDER_KINDS = new Set<ProviderKind>([
  'openai',
  'openai-compatible'
])
const RESERVED_PROVIDER_IDS = new Set(['echo', 'codex'])
const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

const nodeFileSystem: ProviderSettingsFileSystem = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
  writeFile: async (path, contents, options) => {
    await writeFile(path, contents, options)
  },
  chmod,
  rename,
  unlink,
  open: async (path, flags) => wrapFileHandle(await open(path, flags))
}

function wrapFileHandle(handle: FileHandle): ProviderSettingsFileHandle {
  return {
    sync: () => handle.sync(),
    close: () => handle.close(),
    chmod: (mode) => handle.chmod(mode)
  }
}

/**
 * Durable provider metadata and write-only credentials for the Electron main
 * process. Renderer code must only receive the redacted public profiles.
 */
export class ProviderSettingsStore {
  readonly #filePath: string
  readonly #safeStorage: SafeStorageAdapter
  readonly #fileSystem: ProviderSettingsFileSystem
  readonly #platform: NodeJS.Platform
  readonly #now: () => Date
  readonly #createId: () => string
  readonly #createTemporaryToken: () => string
  #document?: ProviderSettingsDocument
  #loadPromise?: Promise<ProviderSettingsDocument>
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(options: ProviderSettingsStoreOptions) {
    if (!options.filePath) throw new Error('Provider settings path is required')
    this.#filePath = options.filePath
    this.#safeStorage = options.safeStorage
    this.#fileSystem = options.fileSystem ?? nodeFileSystem
    this.#platform = options.platform ?? process.platform
    this.#now = options.now ?? (() => new Date())
    this.#createId = options.createId ?? randomUUID
    this.#createTemporaryToken = options.createTemporaryToken ?? randomUUID
  }

  credentialStorageStatus(): CredentialStorageStatus {
    let available: boolean
    let backend: string | undefined
    try {
      available = this.#safeStorage.isEncryptionAvailable()
      backend = this.#safeStorage.getSelectedStorageBackend?.()
    } catch {
      return {
        available: false,
        reason: 'Operating-system credential storage could not be inspected.'
      }
    }
    if (!available) {
      return {
        available: false,
        reason: 'Operating-system credential encryption is unavailable.'
      }
    }
    if (this.#platform === 'linux' && !backend) {
      return {
        available: false,
        reason: 'Linux secret-storage backend could not be verified.'
      }
    }
    if (this.#platform === 'linux' && backend === 'basic_text') {
      return {
        available: false,
        backend,
        reason: 'Linux secret storage is using the insecure basic_text backend.'
      }
    }
    return { available: true, ...(backend ? { backend } : {}) }
  }

  async snapshot(): Promise<ProviderSettingsSnapshot> {
    const document = await this.#load()
    return {
      profiles: document.profiles.map(toPublicProfile),
      credentialStorage: this.credentialStorageStatus()
    }
  }

  async upsert(input: ProviderProfileInput): Promise<ProviderProfile> {
    return this.#mutate(async () => {
      const normalized = normalizeInput(input)
      if (normalized.secret && normalized.clearSecret) {
        throw new Error('A credential cannot be replaced and removed in the same update')
      }
      const document = cloneDocument(await this.#load())
      const index = normalized.id
        ? document.profiles.findIndex((profile) => profile.id === normalized.id)
        : -1
      if (normalized.id && index < 0) {
        throw new Error(`Provider profile '${normalized.id}' does not exist`)
      }
      const existing = index >= 0 ? document.profiles[index] : undefined
      const now = this.#now().toISOString()
      let encryptedSecret = normalized.clearSecret ? undefined : existing?.encryptedSecret
      if (normalized.secret) {
        this.#assertCredentialStorage()
        encryptedSecret = this.#safeStorage.encryptString(normalized.secret).toString('base64')
      }
      const profileId = existing?.id ?? validateProviderId(this.#createId())
      if (!existing && document.profiles.some((profile) => profile.id === profileId)) {
        throw new Error(`Provider id '${profileId}' already exists`)
      }
      const stored: StoredProviderProfile = {
        id: profileId,
        name: normalized.name,
        kind: normalized.kind,
        ...(normalized.baseUrl ? { baseUrl: normalized.baseUrl } : {}),
        defaultModel: normalized.defaultModel,
        customModels: normalized.customModels,
        ...(encryptedSecret ? { encryptedSecret } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      if (index >= 0) document.profiles[index] = stored
      else document.profiles.push(stored)
      await this.#persist(document)
      return toPublicProfile(stored)
    })
  }

  async delete(profileId: string): Promise<void> {
    await this.#mutate(async () => {
      const document = cloneDocument(await this.#load())
      const index = document.profiles.findIndex((profile) => profile.id === profileId)
      if (index < 0) throw new Error(`Provider profile '${profileId}' does not exist`)
      document.profiles.splice(index, 1)
      await this.#persist(document)
    })
  }

  /** Main-process-only credential access. Never expose this method through IPC. */
  async getSecret(profileId: string): Promise<string | undefined> {
    const document = await this.#load()
    const profile = document.profiles.find((candidate) => candidate.id === profileId)
    if (!profile) throw new Error(`Provider profile '${profileId}' does not exist`)
    if (!profile.encryptedSecret) return undefined
    this.#assertCredentialStorage()
    try {
      return this.#safeStorage.decryptString(Buffer.from(profile.encryptedSecret, 'base64'))
    } catch {
      throw new Error(`Credential for provider profile '${profileId}' could not be decrypted`)
    }
  }

  /** Main-process-only serialization barrier for runtime reconciliation. */
  async reconcileRuntime(
    rpc: ProviderControlRpc,
    onCredentialError: (profile: ProviderProfile, error: unknown) => void
  ): Promise<void> {
    await this.#mutate(() => reconcileStoredProvidersUnlocked(this, rpc, onCredentialError))
  }

  #assertCredentialStorage(): void {
    const status = this.credentialStorageStatus()
    if (!status.available) throw new Error(status.reason ?? 'Credential storage is unavailable')
  }

  async #load(): Promise<ProviderSettingsDocument> {
    if (this.#document) return this.#document
    if (this.#loadPromise) return this.#loadPromise
    const operation = this.#loadFromDisk()
    this.#loadPromise = operation
    try {
      return await operation
    } finally {
      if (this.#loadPromise === operation) this.#loadPromise = undefined
    }
  }

  async #loadFromDisk(): Promise<ProviderSettingsDocument> {
    let serialized: string
    try {
      serialized = await this.#fileSystem.readFile(this.#filePath)
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) {
        this.#document = { version: PROVIDER_SETTINGS_VERSION, profiles: [] }
        return this.#document
      }
      throw error
    }
    const directory = dirname(this.#filePath)
    // Existing installations may predate private-mode enforcement. Tighten
    // permissions before parsing so even a malformed legacy file remains
    // private while the user decides how to recover it.
    await this.#fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
    await this.#fileSystem.chmod(directory, 0o700)
    await this.#fileSystem.chmod(this.#filePath, 0o600)
    this.#document = parseDocument(serialized)
    return this.#document
  }

  async #persist(document: ProviderSettingsDocument): Promise<void> {
    const directory = dirname(this.#filePath)
    await this.#fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
    await this.#fileSystem.chmod(directory, 0o700)
    const temporaryToken = this.#createTemporaryToken()
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(temporaryToken)) {
      throw new Error('Provider settings temporary token is invalid')
    }
    const temporary = `${this.#filePath}.tmp-${temporaryToken}`
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    let temporaryCreated = false
    try {
      await this.#fileSystem.writeFile(temporary, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      temporaryCreated = true
      // Explicit chmod is required because creation mode is umask-filtered.
      await this.#fileSystem.chmod(temporary, 0o600)
      const temporaryHandle = await this.#fileSystem.open(temporary, 'r')
      try {
        await temporaryHandle.chmod(0o600)
        await temporaryHandle.sync()
      } finally {
        await temporaryHandle.close()
      }
      await this.#fileSystem.rename(temporary, this.#filePath)
      // Rename is the commit point. The private mode is inherited from the
      // temporary file, so no path-based chmod is needed after replacement.
      this.#document = document
      await syncDirectoryBestEffort(this.#fileSystem, directory, this.#platform)
    } catch (error) {
      if (temporaryCreated) await this.#fileSystem.unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail
    let release!: () => void
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

/** Activate one durable profile over the private main-to-server control path. */
export async function configureStoredProvider(
  settings: ProviderSettingsStore,
  profile: ProviderProfile,
  rpc: ProviderControlRpc
): Promise<void> {
  const apiKey = await settings.getSecret(profile.id)
  await sendProviderConfiguration(profile, apiKey, rpc)
}

async function sendProviderConfiguration(
  profile: ProviderProfile,
  apiKey: string | undefined,
  rpc: ProviderControlRpc
): Promise<void> {
  await rpc('provider/configure', {
    id: profile.id,
    display_name: profile.name,
    kind: profile.kind,
    base_url: profile.baseUrl,
    api_key: apiKey,
    default_model: profile.defaultModel,
    custom_models: profile.customModels
  })
}

/**
 * Make a long-lived app-server match the encrypted settings store exactly.
 * Removal is completed before activation so deleted and changed credentials
 * cannot remain reachable through a stale registry entry during reconnect.
 * A single undecryptable profile is isolated, while control-channel failures
 * abort bootstrap so a dead socket is never announced as connected.
 */
export async function reconcileStoredProviders(
  settings: ProviderSettingsStore,
  rpc: ProviderControlRpc,
  onCredentialError: (profile: ProviderProfile, error: unknown) => void
): Promise<void> {
  await settings.reconcileRuntime(rpc, onCredentialError)
}

async function reconcileStoredProvidersUnlocked(
  settings: ProviderSettingsStore,
  rpc: ProviderControlRpc,
  onCredentialError: (profile: ProviderProfile, error: unknown) => void
): Promise<void> {
  const snapshot = await settings.snapshot()
  const listed = await rpc('provider/list', {})
  if (!isRecord(listed) || !Array.isArray(listed.providers)) {
    throw new Error('Kody returned an invalid provider catalog during reconciliation')
  }

  for (const candidate of listed.providers) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== 'string'
      || !candidate.id
      || candidate.id.length > 256
    ) {
      throw new Error('Kody returned an invalid provider descriptor during reconciliation')
    }
    if (candidate.id === 'echo' || candidate.id === 'codex') continue
    await rpc('provider/remove', { provider_id: candidate.id })
  }

  for (const profile of snapshot.profiles) {
    let apiKey: string | undefined
    try {
      apiKey = await settings.getSecret(profile.id)
    } catch (error) {
      onCredentialError(profile, error)
      continue
    }
    // RPC failures are connection-fatal here. Swallowing them could let a
    // closed socket finish bootstrap and be incorrectly reported as connected.
    await sendProviderConfiguration(profile, apiKey, rpc)
  }
}

async function syncDirectoryBestEffort(
  fileSystem: ProviderSettingsFileSystem,
  directory: string,
  platform: NodeJS.Platform
): Promise<void> {
  // Windows does not expose directory handles with the same fsync semantics.
  if (platform === 'win32') return
  let handle: ProviderSettingsFileHandle | undefined
  try {
    handle = await fileSystem.open(directory, 'r')
    await handle.sync()
  } catch {
    // The temporary file itself was fsynced before the atomic rename. Some
    // platforms and filesystems cannot fsync a directory; once rename commits,
    // returning an error would make a successful create look retryable.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function normalizeInput(input: ProviderProfileInput): Required<
  Pick<ProviderProfileInput, 'name' | 'kind' | 'defaultModel' | 'customModels'>
> & Pick<ProviderProfileInput, 'id' | 'baseUrl' | 'secret' | 'clearSecret'> {
  const id = input.id?.trim()
  if (id && id.length > 200) throw new Error('Provider id must be 200 characters or fewer')
  if (id) validateProviderId(id)
  const name = boundedText(input.name, 'Provider name', 100)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Provider name must not contain control characters')
  if (!PROVIDER_KINDS.has(input.kind)) throw new Error('Provider kind is invalid')
  const baseUrl = input.baseUrl?.trim() || undefined
  if (baseUrl && baseUrl.length > 2_048) throw new Error('Base URL must be 2048 characters or fewer')
  if (baseUrl) validateBaseUrl(baseUrl)
  if (input.kind === 'openai-compatible' && !baseUrl) {
    throw new Error('Base URL is required for an OpenAI-compatible provider')
  }
  const defaultModel = boundedText(input.defaultModel, 'Default model', 200)
  if ((input.customModels?.length ?? 0) > 200) throw new Error('At most 200 custom models may be saved')
  const customModels = [...new Set((input.customModels ?? []).map((model) => model.trim()))]
    .filter(Boolean)
  if (customModels.some((model) => model.length > 200)) {
    throw new Error('Custom model names must be 200 characters or fewer')
  }
  const secret = input.secret?.trim() || undefined
  if (secret && secret.length > 32_768) throw new Error('Credential is too large')
  if (secret && /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error('Credential must not contain control characters')
  }
  return {
    ...(id ? { id } : {}),
    name,
    kind: input.kind,
    ...(baseUrl ? { baseUrl } : {}),
    defaultModel,
    customModels,
    ...(secret ? { secret } : {}),
    ...(input.clearSecret ? { clearSecret: true } : {})
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`)
  return normalized
}

function validateBaseUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Base URL must be a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Base URL must use HTTP or HTTPS')
  }
  if (url.username || url.password) throw new Error('Base URL must not include credentials')
  if (url.search || url.hash) throw new Error('Base URL must not include a query string or fragment')
  if (url.protocol === 'http:' && !LOOPBACK_HTTP_HOSTS.has(url.hostname)) {
    throw new Error('Base URL must use HTTPS unless it targets localhost')
  }
}

function assertProviderIdIsUserManaged(id: string): void {
  if (RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error(`Provider id '${id}' is reserved for a built-in provider`)
  }
}

function validateProviderId(id: string): string {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider id contains unsupported characters')
  }
  assertProviderIdIsUserManaged(id)
  return id
}

function toPublicProfile(profile: StoredProviderProfile): ProviderProfile {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    defaultModel: profile.defaultModel,
    customModels: [...profile.customModels],
    hasSecret: Boolean(profile.encryptedSecret),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

function cloneDocument(document: ProviderSettingsDocument): ProviderSettingsDocument {
  return {
    version: document.version,
    profiles: document.profiles.map((profile) => ({
      ...profile,
      customModels: [...profile.customModels]
    }))
  }
}

function parseDocument(serialized: string): ProviderSettingsDocument {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Provider settings file contains invalid JSON')
  }
  if (!isRecord(value) || value.version !== PROVIDER_SETTINGS_VERSION || !Array.isArray(value.profiles)) {
    throw new Error('Provider settings file has an unsupported shape or version')
  }
  const profiles = value.profiles.map(parseStoredProfile)
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error('Provider settings file contains duplicate profile ids')
  }
  return { version: PROVIDER_SETTINGS_VERSION, profiles }
}

function parseStoredProfile(value: unknown): StoredProviderProfile {
  if (!isRecord(value)) throw new Error('Provider settings file contains an invalid profile')
  const id = validateProviderId(requiredStoredString(value.id, 'id', 200))
  const name = requiredStoredString(value.name, 'name', 100)
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Provider profile '${id}' name contains control characters`)
  }
  if (typeof value.kind !== 'string' || !PROVIDER_KINDS.has(value.kind as ProviderKind)) {
    throw new Error(`Provider profile '${id}' has an invalid kind`)
  }
  const defaultModel = requiredStoredString(value.defaultModel, 'defaultModel', 200)
  if (!Array.isArray(value.customModels) || value.customModels.some((model) => typeof model !== 'string')) {
    throw new Error(`Provider profile '${id}' has invalid custom models`)
  }
  if (value.customModels.length > 200 || value.customModels.some((model) => model.length > 200)) {
    throw new Error(`Provider profile '${id}' has too many or oversized custom models`)
  }
  const baseUrl = optionalStoredString(value.baseUrl, 'baseUrl', 2_048)
  if (baseUrl) validateBaseUrl(baseUrl)
  if (value.kind === 'openai-compatible' && !baseUrl) {
    throw new Error(`Provider profile '${id}' is missing its required base URL`)
  }
  const encryptedSecret = optionalStoredString(value.encryptedSecret, 'encryptedSecret', 131_072)
  if (encryptedSecret && !isCanonicalBase64(encryptedSecret)) {
    throw new Error(`Provider profile '${id}' has invalid encrypted credential data`)
  }
  return {
    id,
    name,
    kind: value.kind as ProviderKind,
    ...(baseUrl ? { baseUrl } : {}),
    defaultModel,
    customModels: [...new Set(value.customModels.map((model) => model.trim()).filter(Boolean))],
    ...(encryptedSecret ? { encryptedSecret } : {}),
    createdAt: requiredStoredDate(value.createdAt, 'createdAt'),
    updatedAt: requiredStoredDate(value.updatedAt, 'updatedAt')
  }
}

function requiredStoredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`Provider settings profile field '${field}' is invalid`)
  }
  return value
}

function optionalStoredString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new Error(`Provider settings profile field '${field}' is invalid`)
  }
  return value
}

function requiredStoredDate(value: unknown, field: string): string {
  const date = requiredStoredString(value, field, 100)
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`Provider settings profile field '${field}' is not a valid date`)
  }
  return date
}

function isCanonicalBase64(value: string): boolean {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
