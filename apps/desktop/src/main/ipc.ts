import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { RpcMethod, RpcMethodMap } from '../shared/protocol'
import { CodyServerManager } from './server-manager'
import { isTrustedRendererUrl, validateRpcInvocation } from './security'

interface IpcOptions {
  getWindow(): BrowserWindow | null
  rendererUrl: string
  server: CodyServerManager
}

export function registerIpcHandlers(options: IpcOptions): void {
  ipcMain.handle('cody:rpc', async (event, method: unknown, params: unknown) => {
    assertTrustedSender(event, options)
    validateRpcInvocation(method, params)
    return options.server.rpc(
      method,
      params as RpcMethodMap[typeof method]['params']
    )
  })

  ipcMain.handle('cody:pick-directory', async (event, purpose: unknown) => {
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

  ipcMain.handle('cody:server-status', (event) => {
    assertTrustedSender(event, options)
    return options.server.getStatus()
  })

  ipcMain.handle('cody:copy-text', (event, text: unknown) => {
    assertTrustedSender(event, options)
    if (typeof text !== 'string' || text.length > 1_000_000) {
      throw new Error('Clipboard text must be a string no larger than 1 MB')
    }
    clipboard.writeText(text)
  })

  ipcMain.handle('cody:window-action', (event, action: unknown) => {
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
