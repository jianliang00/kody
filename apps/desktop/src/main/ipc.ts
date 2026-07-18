import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { RpcMethod, RpcMethodMap } from '../shared/protocol'
import type {
  CodexAccountStatus,
  CodexConnectResult,
  ProviderProfileRecord,
  ProviderProfileUpdate
} from '../shared/bridge'
import { ProviderSettingsStore } from './provider-settings'
import { KodyServerManager } from './server-manager'
import { isTrustedRendererUrl, validateRpcInvocation } from './security'
import type { KodyUpdateManager } from './update-manager'

interface IpcOptions {
  getWindow(): BrowserWindow | null
  rendererUrl: string
  server: KodyServerManager
  providerSettings: ProviderSettingsStore
  updateManager: KodyUpdateManager
  configureProvider(profile: ProviderProfileRecord): Promise<void>
  removeProvider(profileId: string): Promise<void>
  getCodexAccountStatus(): Promise<CodexAccountStatus>
  connectCodexAccount(): Promise<CodexConnectResult>
  disconnectCodexAccount(): Promise<void>
}

export function registerIpcHandlers(options: IpcOptions): void {
  let providerMutationTail: Promise<void> = Promise.resolve()
  let codexAccountMutationTail: Promise<void> = Promise.resolve()

  const mutateProvider = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = providerMutationTail.then(operation)
    providerMutationTail = result.then(() => undefined, () => undefined)
    return result
  }
  const mutateCodexAccount = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = codexAccountMutationTail.then(operation)
    codexAccountMutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  ipcMain.handle('kody:rpc', async (event, method: unknown, params: unknown) => {
    assertTrustedSender(event, options)
    validateRpcInvocation(method, params)
    return options.server.rpc(
      method,
      params as RpcMethodMap[typeof method]['params']
    )
  })

  ipcMain.handle('kody:pick-directory', async (event, purpose: unknown) => {
    assertTrustedSender(event, options)
    if (purpose !== undefined && purpose !== 'project' && purpose !== 'working-directory') {
      throw new Error('Unsupported directory picker purpose')
    }
    const owner = options.getWindow()
    const workingDirectory = purpose === 'working-directory'
    const title = workingDirectory ? 'Choose a working directory' : 'Add a Project directory'
    const buttonLabel = workingDirectory ? 'Use Directory' : 'Add Project'
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title,
          buttonLabel,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title,
          buttonLabel,
          properties: ['openDirectory', 'createDirectory']
        })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('kody:server-status', (event) => {
    assertTrustedSender(event, options)
    return options.server.getStatus()
  })

  ipcMain.handle('kody:provider-settings:get', async (event) => {
    assertTrustedSender(event, options)
    return options.providerSettings.snapshot()
  })

  ipcMain.handle('kody:provider-settings:upsert', async (event, input: unknown) => {
    assertTrustedSender(event, options)
    const update = validateProviderProfileUpdate(input)
    return mutateProvider(async () => {
      const profile = await options.providerSettings.upsert(update)
      await options.configureProvider(profile)
      return profile
    })
  })

  ipcMain.handle('kody:provider-settings:delete', async (event, profileId: unknown) => {
    assertTrustedSender(event, options)
    if (
      typeof profileId !== 'string'
      || !profileId
      || profileId !== profileId.trim()
      || profileId.length > 200
    ) {
      throw new Error('Provider profile id is invalid')
    }
    await mutateProvider(async () => {
      await options.providerSettings.delete(profileId)
      await options.removeProvider(profileId)
    })
  })

  ipcMain.handle('kody:codex-account:get', async (event) => {
    assertTrustedSender(event, options)
    return options.getCodexAccountStatus()
  })

  ipcMain.handle('kody:codex-account:connect', async (event) => {
    assertTrustedSender(event, options)
    return mutateCodexAccount(() => options.connectCodexAccount())
  })

  ipcMain.handle('kody:codex-account:disconnect', async (event) => {
    assertTrustedSender(event, options)
    await mutateCodexAccount(() => options.disconnectCodexAccount())
  })

  ipcMain.handle('kody:update:get', (event) => {
    assertTrustedSender(event, options)
    return options.updateManager.getStatus()
  })

  ipcMain.handle('kody:update:check', async (event) => {
    assertTrustedSender(event, options)
    return options.updateManager.check(true)
  })

  ipcMain.handle('kody:update:download', async (event) => {
    assertTrustedSender(event, options)
    return options.updateManager.download()
  })

  ipcMain.handle('kody:update:restart-and-install', async (event) => {
    assertTrustedSender(event, options)
    await options.updateManager.restartAndInstall()
  })

  ipcMain.handle('kody:copy-text', (event, text: unknown) => {
    assertTrustedSender(event, options)
    if (typeof text !== 'string' || text.length > 1_000_000) {
      throw new Error('Clipboard text must be a string no larger than 1 MB')
    }
    clipboard.writeText(text)
  })

  ipcMain.handle('kody:artifact:load', async (event, artifactId: unknown) => {
    assertTrustedSender(event, options)
    if (
      typeof artifactId !== 'string'
      || !/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(artifactId)
    ) {
      throw new Error('Artifact id is invalid')
    }
    const artifact = await options.server.readArtifactData(artifactId)
    return `data:${artifact.mimeType};base64,${artifact.base64}`
  })

  ipcMain.handle('kody:window-action', (event, action: unknown) => {
    assertTrustedSender(event, options)
    if (action !== 'minimize' && action !== 'maximize' && action !== 'close') {
      throw new Error('Unsupported window action')
    }
    const window = options.getWindow()
    if (!window || window.isDestroyed()) return
    if (action === 'minimize') window.minimize()
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    if (action === 'close') window.close()
  })
}

export function validateProviderProfileUpdate(input: unknown): ProviderProfileUpdate {
  if (!isRecord(input)) throw new Error('Provider profile update must be an object')
  const allowed = new Set([
    'id',
    'name',
    'kind',
    'baseUrl',
    'defaultModel',
    'customModels',
    'defaultImageModel',
    'imageModels',
    'secret',
    'clearSecret'
  ])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Provider profile update contains unsupported fields')
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) {
    throw new Error('Provider profile name is invalid')
  }
  if (input.kind !== 'openai' && input.kind !== 'openai-compatible') {
    throw new Error('Provider profile kind is invalid')
  }
  if (
    typeof input.defaultModel !== 'string'
    || !input.defaultModel.trim()
    || input.defaultModel.length > 200
  ) {
    throw new Error('Provider default model is invalid')
  }
  if (input.defaultImageModel !== undefined && (
    typeof input.defaultImageModel !== 'string'
    || input.defaultImageModel.length > 200
  )) {
    throw new Error('Provider default image model is invalid')
  }
  if (input.id !== undefined && (
    typeof input.id !== 'string'
    || !input.id
    || input.id !== input.id.trim()
    || input.id.length > 200
  )) {
    throw new Error('Provider profile id is invalid')
  }
  if (input.baseUrl !== undefined && (
    typeof input.baseUrl !== 'string'
    || !input.baseUrl.trim()
    || input.baseUrl.length > 2_048
  )) {
    throw new Error('Provider base URL is invalid')
  }
  if (input.secret !== undefined && (
    typeof input.secret !== 'string'
    || input.secret.length > 32_768
  )) {
    throw new Error('Provider credential is invalid')
  }
  if (input.clearSecret !== undefined && typeof input.clearSecret !== 'boolean') {
    throw new Error('Provider clear-credential flag is invalid')
  }
  if (!Array.isArray(input.customModels) && input.customModels !== undefined) {
    throw new Error('Provider custom models are invalid')
  }
  const customModels = input.customModels ?? []
  if (
    customModels.length > 200
    || customModels.some((model) => typeof model !== 'string' || model.length > 200)
  ) {
    throw new Error('Provider custom models are invalid')
  }
  if (!Array.isArray(input.imageModels) && input.imageModels !== undefined) {
    throw new Error('Provider image models are invalid')
  }
  const imageModels = input.imageModels ?? []
  if (
    imageModels.length > 200
    || imageModels.some((model) => typeof model !== 'string' || model.length > 200)
  ) {
    throw new Error('Provider image models are invalid')
  }
  if (input.secret?.trim() && input.clearSecret) {
    throw new Error('A credential cannot be replaced and removed in the same update')
  }
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    name: input.name,
    kind: input.kind,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    defaultModel: input.defaultModel,
    customModels: [...customModels],
    ...(input.defaultImageModel === undefined ? {} : { defaultImageModel: input.defaultImageModel }),
    imageModels: [...imageModels],
    ...(input.secret === undefined ? {} : { secret: input.secret }),
    ...(input.clearSecret === undefined ? {} : { clearSecret: input.clearSecret })
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, options: IpcOptions): void {
  const window = options.getWindow()
  const frame = event.senderFrame
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !frame) {
    throw new Error('Rejected IPC from an unknown renderer')
  }
  if (frame !== event.sender.mainFrame || !isTrustedRendererUrl(frame.url, options.rendererUrl)) {
    throw new Error('Rejected IPC from an untrusted frame')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
