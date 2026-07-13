import { contextBridge, ipcRenderer } from 'electron'

import type { CodyDesktopBridge, DesktopCommand, DirectoryPickerPurpose } from '../shared/bridge'
import type { EventEnvelope, RpcMethod, RpcMethodMap, ServerStatus } from '../shared/protocol'

const bridge: CodyDesktopBridge = Object.freeze({
  rpc<M extends RpcMethod>(method: M, params: RpcMethodMap[M]['params']) {
    return ipcRenderer.invoke('cody:rpc', method, params) as Promise<RpcMethodMap[M]['result']>
  },
  pickDirectory(purpose?: DirectoryPickerPurpose) {
    return ipcRenderer.invoke('cody:pick-directory', purpose) as Promise<string | null>
  },
  copyText(text: string) {
    return ipcRenderer.invoke('cody:copy-text', text) as Promise<void>
  },
  getServerStatus() {
    return ipcRenderer.invoke('cody:server-status') as Promise<ServerStatus>
  },
  onEvent(listener: (event: EventEnvelope) => void) {
    const handler = (_event: Electron.IpcRendererEvent, envelope: EventEnvelope): void => listener(envelope)
    ipcRenderer.on('cody:turn-event', handler)
    return () => ipcRenderer.removeListener('cody:turn-event', handler)
  },
  onServerStatus(listener: (status: ServerStatus) => void) {
    const handler = (_event: Electron.IpcRendererEvent, status: ServerStatus): void => listener(status)
    ipcRenderer.on('cody:server-status-changed', handler)
    return () => ipcRenderer.removeListener('cody:server-status-changed', handler)
  },
  onCommand(listener: (command: DesktopCommand) => void) {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopCommand): void => listener(command)
    ipcRenderer.on('cody:menu-command', handler)
    return () => ipcRenderer.removeListener('cody:menu-command', handler)
  },
  windowAction(action: 'minimize' | 'maximize' | 'close') {
    return ipcRenderer.invoke('cody:window-action', action) as Promise<void>
  },
  platform: process.platform
})

contextBridge.exposeInMainWorld('cody', bridge)
