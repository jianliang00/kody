import { contextBridge, ipcRenderer } from 'electron'

import type {
  CodexAccountStatus,
  CodexConnectResult,
  DesktopUpdateStatus,
  KodyDesktopBridge,
  DesktopCommand,
  DirectoryPickerPurpose,
  ProviderProfileRecord,
  ProviderProfileUpdate,
  ProviderSettingsResult
} from '../shared/bridge'
import type {
  EventEnvelope,
  ProcessEventEnvelope,
  RpcMethod,
  RpcMethodMap,
  ServerStatus
} from '../shared/protocol'

const bridge: KodyDesktopBridge = Object.freeze({
  rpc<M extends RpcMethod>(method: M, params: RpcMethodMap[M]['params']) {
    return ipcRenderer.invoke('kody:rpc', method, params) as Promise<RpcMethodMap[M]['result']>
  },
  pickDirectory(purpose?: DirectoryPickerPurpose) {
    return ipcRenderer.invoke('kody:pick-directory', purpose) as Promise<string | null>
  },
  copyText(text: string) {
    return ipcRenderer.invoke('kody:copy-text', text) as Promise<void>
  },
  getServerStatus() {
    return ipcRenderer.invoke('kody:server-status') as Promise<ServerStatus>
  },
  getProviderSettings() {
    return ipcRenderer.invoke('kody:provider-settings:get') as Promise<ProviderSettingsResult>
  },
  upsertProviderProfile(profile: ProviderProfileUpdate) {
    return ipcRenderer.invoke('kody:provider-settings:upsert', profile) as Promise<ProviderProfileRecord>
  },
  deleteProviderProfile(profileId: string) {
    return ipcRenderer.invoke('kody:provider-settings:delete', profileId) as Promise<void>
  },
  getCodexAccountStatus() {
    return ipcRenderer.invoke('kody:codex-account:get') as Promise<CodexAccountStatus>
  },
  connectCodexAccount() {
    return ipcRenderer.invoke('kody:codex-account:connect') as Promise<CodexConnectResult>
  },
  disconnectCodexAccount() {
    return ipcRenderer.invoke('kody:codex-account:disconnect') as Promise<void>
  },
  getUpdateStatus() {
    return ipcRenderer.invoke('kody:update:get') as Promise<DesktopUpdateStatus>
  },
  checkForUpdates() {
    return ipcRenderer.invoke('kody:update:check') as Promise<DesktopUpdateStatus>
  },
  downloadUpdate() {
    return ipcRenderer.invoke('kody:update:download') as Promise<DesktopUpdateStatus>
  },
  restartAndInstallUpdate() {
    return ipcRenderer.invoke('kody:update:restart-and-install') as Promise<void>
  },
  onEvent(listener: (event: EventEnvelope) => void) {
    const handler = (_event: Electron.IpcRendererEvent, envelope: EventEnvelope): void => listener(envelope)
    ipcRenderer.on('kody:turn-event', handler)
    return () => ipcRenderer.removeListener('kody:turn-event', handler)
  },
  onProcessEvent(listener: (event: ProcessEventEnvelope) => void) {
    const handler = (_event: Electron.IpcRendererEvent, envelope: ProcessEventEnvelope): void => listener(envelope)
    ipcRenderer.on('kody:process-event', handler)
    return () => ipcRenderer.removeListener('kody:process-event', handler)
  },
  onServerStatus(listener: (status: ServerStatus) => void) {
    const handler = (_event: Electron.IpcRendererEvent, status: ServerStatus): void => listener(status)
    ipcRenderer.on('kody:server-status-changed', handler)
    return () => ipcRenderer.removeListener('kody:server-status-changed', handler)
  },
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void) {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus): void => listener(status)
    ipcRenderer.on('kody:update-status-changed', handler)
    return () => ipcRenderer.removeListener('kody:update-status-changed', handler)
  },
  onCommand(listener: (command: DesktopCommand) => void) {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopCommand): void => listener(command)
    ipcRenderer.on('kody:menu-command', handler)
    return () => ipcRenderer.removeListener('kody:menu-command', handler)
  },
  windowAction(action: 'minimize' | 'maximize' | 'close') {
    return ipcRenderer.invoke('kody:window-action', action) as Promise<void>
  },
  platform: process.platform
})

contextBridge.exposeInMainWorld('kody', bridge)
