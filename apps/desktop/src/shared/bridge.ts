import type { EventEnvelope, ProcessEventEnvelope, RpcMethod, RpcMethodMap, ServerStatus } from './protocol'

export type DesktopCommand =
  | 'new-thread'
  | 'import-project'
  | 'open-settings'
  | 'focus-assets'
  | 'toggle-rail'
  | 'toggle-inspector'

export type DirectoryPickerPurpose = 'project' | 'working-directory'

export type ProviderProfileKind = 'openai' | 'openai-compatible'

export interface ProviderProfileRecord {
  id: string
  name: string
  kind: ProviderProfileKind
  baseUrl?: string
  defaultModel: string
  customModels: string[]
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface ProviderProfileUpdate {
  id?: string
  name: string
  kind: ProviderProfileKind
  baseUrl?: string
  defaultModel: string
  customModels?: string[]
  /** Write-only. Main must never return or broadcast this value. */
  secret?: string
  clearSecret?: boolean
}

export interface ProviderSettingsResult {
  profiles: ProviderProfileRecord[]
  credentialStorage: {
    available: boolean
    backend?: string
    reason?: string
  }
}

export interface CodexAccountStatus {
  state: 'signed-out' | 'signed-in' | 'expired' | 'unavailable'
  accountLabel?: string
  detail?: string
}

export interface CodexConnectResult {
  mode: 'browser' | 'device_code'
  userCode?: string
}

export interface CodyDesktopBridge {
  rpc<M extends RpcMethod>(method: M, params: RpcMethodMap[M]['params']): Promise<RpcMethodMap[M]['result']>
  pickDirectory(purpose?: DirectoryPickerPurpose): Promise<string | null>
  copyText(text: string): Promise<void>
  getServerStatus(): Promise<ServerStatus>
  getProviderSettings(): Promise<ProviderSettingsResult>
  upsertProviderProfile(profile: ProviderProfileUpdate): Promise<ProviderProfileRecord>
  deleteProviderProfile(profileId: string): Promise<void>
  getCodexAccountStatus(): Promise<CodexAccountStatus>
  connectCodexAccount(): Promise<CodexConnectResult>
  disconnectCodexAccount(): Promise<void>
  onEvent(listener: (event: EventEnvelope) => void): () => void
  onProcessEvent(listener: (event: ProcessEventEnvelope) => void): () => void
  onServerStatus(listener: (status: ServerStatus) => void): () => void
  onCommand(listener: (command: DesktopCommand) => void): () => void
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  platform: NodeJS.Platform
}

declare global {
  interface Window {
    cody?: CodyDesktopBridge
  }
}
