import type { EventEnvelope, RpcMethod, RpcMethodMap, ServerStatus } from './protocol'

export type DesktopCommand =
  | 'new-thread'
  | 'import-project'
  | 'focus-assets'
  | 'toggle-rail'
  | 'toggle-inspector'

export type DirectoryPickerPurpose = 'project' | 'working-directory'

export interface CodyDesktopBridge {
  rpc<M extends RpcMethod>(method: M, params: RpcMethodMap[M]['params']): Promise<RpcMethodMap[M]['result']>
  pickDirectory(purpose?: DirectoryPickerPurpose): Promise<string | null>
  copyText(text: string): Promise<void>
  getServerStatus(): Promise<ServerStatus>
  onEvent(listener: (event: EventEnvelope) => void): () => void
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
