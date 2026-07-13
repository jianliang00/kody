import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'

import type {
  CodexAccountStatus,
  CodexConnectResult,
  DesktopCommand
} from '../shared/bridge'
import { registerIpcHandlers } from './ipc'
import {
  configureStoredProvider,
  ProviderSettingsStore,
  reconcileStoredProviders
} from './provider-settings'
import { CodyServerManager, trustedCodexAuthUrl } from './server-manager'
import { hardenRendererSession, hardenWebContents } from './security'

let mainWindow: BrowserWindow | null = null
let server: CodyServerManager | null = null
let shutdownStarted = false
let shutdownComplete = false

app.setName('Cody')

interface SavedWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const productionRendererPath = join(moduleDirectory, '../renderer/index.html')
const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(productionRendererPath).toString()

function broadcast(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function sendCommand(command: DesktopCommand): void {
  broadcast('cody:menu-command', command)
}

function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('open-settings') },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-thread') },
        { label: 'Import Project…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('import-project') },
        ...(!isMac ? [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendCommand('open-settings') }] : []),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Filter Assets', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('focus-assets') },
        { label: 'Toggle Asset Rail', accelerator: isMac ? 'Cmd+Ctrl+S' : 'Ctrl+Shift+S', click: () => sendCommand('toggle-rail') },
        { label: 'Toggle Context Inspector', accelerator: 'CmdOrCtrl+Alt+I', click: () => sendCommand('toggle-inspector') },
        { type: 'separator' },
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'About Cody’s Workspace Model',
          click: () => {
            const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
            const options = {
              type: 'info' as const,
              title: 'Cody workspace model',
              message: 'Threads, Projects, and Workspaces stay independent.',
              detail: 'Threads are durable conversations. Projects are reusable code assets. Each Thread owns an ephemeral Workspace and can reference any number of other Threads or Projects.'
            }
            void (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function readWindowState(): SavedWindowState | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'window-state.json'), 'utf8')
    ) as Partial<SavedWindowState>
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return undefined
    const state = value as SavedWindowState
    if (state.width < 360 || state.height < 560) return undefined
    const visible = screen.getAllDisplays().some(({ workArea }) => (
      state.x < workArea.x + workArea.width - 80
      && state.x + state.width > workArea.x + 80
      && state.y < workArea.y + workArea.height - 80
      && state.y + state.height > workArea.y + 80
    ))
    return visible ? state : undefined
  } catch {
    return undefined
  }
}

function saveWindowState(window: BrowserWindow): void {
  try {
    const state: SavedWindowState = {
      ...window.getNormalBounds(),
      maximized: window.isMaximized()
    }
    const path = join(app.getPath('userData'), 'window-state.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    if (!app.isPackaged) console.warn('Could not persist window state:', error)
  }
}

function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const savedState = readWindowState()
  const window = new BrowserWindow({
    width: savedState?.width ?? 1380,
    height: savedState?.height ?? 880,
    x: savedState?.x,
    y: savedState?.y,
    minWidth: 360,
    minHeight: 560,
    show: false,
    backgroundColor: '#f4f2ed',
    autoHideMenuBar: !isMac,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: join(moduleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true
    }
  })

  hardenWebContents(window.webContents, rendererUrl)
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script ${preloadPath}:`, error)
  })
  let reportedLoadFailure = false
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || reportedLoadFailure) return
    reportedLoadFailure = true
    window.show()
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Cody could not open',
      message: 'The desktop interface failed to load.',
      detail: `${errorDescription} (${errorCode})\n${validatedUrl}`,
      buttons: ['Quit Cody'],
      defaultId: 0,
      noLink: true
    }).finally(() => app.quit())
  })
  window.once('ready-to-show', () => window.show())
  if (savedState?.maximized) window.maximize()
  window.on('close', () => saveWindowState(window))
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  void (process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(rendererUrl)
    : window.loadFile(productionRendererPath))
  return window
}

void app.whenReady().then(() => {
  hardenRendererSession(session.defaultSession, rendererUrl, Boolean(process.env.ELECTRON_RENDERER_URL))
  const providerSettings = new ProviderSettingsStore({
    filePath: join(app.getPath('userData'), 'model-providers.json'),
    safeStorage
  })
  server = new CodyServerManager({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    stateRoot: join(app.getPath('userData'), 'engine'),
    onEvent: (event) => broadcast('cody:turn-event', event),
    onProcessEvent: (event) => broadcast('cody:process-event', event),
    onStatus: (status) => broadcast('cody:server-status-changed', status),
    onLog: app.isPackaged ? undefined : (line) => console.info(`[cody-app-server] ${line}`),
    onConnected: async (rpc) => {
      await reconcileStoredProviders(providerSettings, rpc, (profile, error) => {
        console.error(`Could not activate model provider '${profile.id}':`, safeMessage(error))
      })
    }
  })
  const currentServer = server
  let activeCodexLoginId: string | undefined
  registerIpcHandlers({
    getWindow: () => mainWindow,
    rendererUrl,
    server: currentServer,
    providerSettings,
    configureProvider: (profile) => configureStoredProvider(
      providerSettings,
      profile,
      (method, params) => currentServer.controlRpc(method, params)
    ),
    removeProvider: async (profileId) => {
      await currentServer.controlRpc('provider/remove', { provider_id: profileId })
    },
    getCodexAccountStatus: async () => {
      const status = await readCodexAccountStatus(currentServer)
      if (status.state === 'signed-in') activeCodexLoginId = undefined
      return status
    },
    connectCodexAccount: async () => {
      if (activeCodexLoginId) {
        await cancelCodexLogin(currentServer, activeCodexLoginId).catch(() => undefined)
        activeCodexLoginId = undefined
      }
      const login = await connectCodexAccount(currentServer)
      activeCodexLoginId = login.loginId
      return login.result
    },
    disconnectCodexAccount: async () => {
      if (activeCodexLoginId) {
        await cancelCodexLogin(currentServer, activeCodexLoginId).catch(() => undefined)
        activeCodexLoginId = undefined
      }
      await currentServer.controlRpc('codex/account/logout', {})
    }
  })
  mainWindow = createMainWindow()
  installApplicationMenu()
  void server.start().catch((error) => console.error('Failed to start Cody engine:', error))

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createMainWindow()
    void server?.start().catch((error) => console.error('Failed to reconnect Cody engine:', error))
  })
})

interface CodexAccountWire {
  state?: 'signed_in' | 'signed_out' | 'unavailable'
  account?: { email?: string; plan_type?: string; account_type?: string } | null
  detail?: string
  binary?: { version?: string }
}

async function readCodexAccountStatus(manager: CodyServerManager): Promise<CodexAccountStatus> {
  const value = await manager.controlRpc<CodexAccountWire>('codex/account/read', {})
  if (value.state === 'unavailable') {
    return { state: 'unavailable', detail: value.detail ?? 'Codex is unavailable.' }
  }
  if (value.state !== 'signed_in' || !value.account) {
    return {
      state: 'signed-out',
      detail: value.binary?.version
        ? `Codex ${value.binary.version} is ready. Sign in with ChatGPT to use plan quota.`
        : 'Sign in with ChatGPT to use Codex plan quota.'
    }
  }
  const label = value.account.email ?? value.account.account_type ?? 'ChatGPT account'
  const details = [value.account.plan_type, value.binary?.version].filter(Boolean).join(' · ')
  try {
    const limits = await manager.controlRpc<unknown>('codex/account/rate-limits', {})
    const summary = rateLimitSummary(limits)
    return { state: 'signed-in', accountLabel: label, detail: [details, summary].filter(Boolean).join(' · ') }
  } catch {
    return { state: 'signed-in', accountLabel: label, detail: details || undefined }
  }
}

async function connectCodexAccount(
  manager: CodyServerManager
): Promise<{ loginId: string; result: CodexConnectResult }> {
  const login = await manager.controlRpc<unknown>('codex/account/login/start', { mode: 'browser' })
  if (!isRecord(login)) throw new Error('Codex returned an invalid login response')
  if (
    typeof login.login_id !== 'string'
    || !login.login_id
    || login.login_id.length > 256
  ) {
    throw new Error('Codex returned an invalid login identifier')
  }
  const loginId = login.login_id
  try {
    if (login.mode === 'browser' && typeof login.auth_url === 'string' && login.auth_url.length <= 16_384) {
      await openTrustedAuthUrl(login.auth_url)
      return { loginId, result: { mode: 'browser' } }
    }
    if (
      login.mode === 'device_code'
      && typeof login.verification_url === 'string'
      && login.verification_url.length <= 16_384
      && (login.user_code === undefined || (
        typeof login.user_code === 'string'
        && login.user_code.length <= 256
      ))
    ) {
      await openTrustedAuthUrl(login.verification_url)
      return {
        loginId,
        result: {
          mode: 'device_code',
          userCode: login.user_code
        }
      }
    }
    throw new Error('Codex did not return a usable login URL')
  } catch (error) {
    await cancelCodexLogin(manager, loginId).catch(() => undefined)
    throw error
  }
}

async function cancelCodexLogin(manager: CodyServerManager, loginId: string): Promise<void> {
  await manager.controlRpc('codex/account/login/cancel', { login_id: loginId })
}

async function openTrustedAuthUrl(rawUrl: string): Promise<void> {
  const trustedUrl = trustedCodexAuthUrl(rawUrl)
  try {
    await shell.openExternal(trustedUrl, { activate: true })
  } catch {
    throw new Error('Cody could not open the Codex sign-in page')
  }
}

function rateLimitSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const limits = isRecord(value.rateLimits)
    ? value.rateLimits
    : isRecord(value.rate_limits)
      ? value.rate_limits
      : undefined
  if (!limits) return undefined
  const primary = isRecord(limits.primary) ? limits.primary : undefined
  const used = primary?.usedPercent ?? primary?.used_percent
  if (typeof used !== 'number') return undefined
  return `${Math.max(0, Math.min(100, used))}% of the current Codex window used`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void (server?.stop() ?? Promise.resolve()).finally(() => {
    shutdownComplete = true
    app.quit()
  })
})
