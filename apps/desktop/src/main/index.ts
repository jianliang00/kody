import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  session,
  type MenuItemConstructorOptions
} from 'electron'

import type { DesktopCommand } from '../shared/bridge'
import { registerIpcHandlers } from './ipc'
import { CodyServerManager } from './server-manager'
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
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: false },
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
  server = new CodyServerManager({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    stateRoot: join(app.getPath('userData'), 'engine'),
    onEvent: (event) => broadcast('cody:turn-event', event),
    onStatus: (status) => broadcast('cody:server-status-changed', status),
    onLog: app.isPackaged ? undefined : (line) => console.info(`[cody-app-server] ${line}`)
  })
  registerIpcHandlers({ getWindow: () => mainWindow, rendererUrl, server })
  mainWindow = createMainWindow()
  installApplicationMenu()
  void server.start().catch((error) => console.error('Failed to start Cody engine:', error))

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createMainWindow()
    void server?.start().catch((error) => console.error('Failed to reconnect Cody engine:', error))
  })
})

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
