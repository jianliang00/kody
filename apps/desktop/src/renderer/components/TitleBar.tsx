import {
  Maximize2,
  Menu,
  Minus,
  Moon,
  PanelLeftOpen,
  PanelRightOpen,
  RefreshCcw,
  Sun,
  X
} from 'lucide-react'
import type { ServerStatus, Thread } from '@shared/protocol'

interface TitleBarProps {
  thread?: Thread
  status: ServerStatus
  platform: NodeJS.Platform
  darkTheme: boolean
  railCollapsed: boolean
  showInspector: boolean
  onOpenRail: () => void
  onOpenInspector: () => void
  onRetry: () => void
  onToggleTheme: () => void
  onWindowAction: (action: 'minimize' | 'maximize' | 'close') => void
}

export function TitleBar({
  thread,
  status,
  platform,
  darkTheme,
  railCollapsed,
  showInspector,
  onOpenRail,
  onOpenInspector,
  onRetry,
  onToggleTheme,
  onWindowAction
}: TitleBarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar__leading no-drag">
        <button className="icon-button rail-mobile-trigger" type="button" onClick={onOpenRail} aria-label="Open asset drawer">
          <Menu aria-hidden="true" size={18} />
        </button>
        {railCollapsed ? (
          <button className="icon-button rail-desktop-trigger" type="button" onClick={onOpenRail} aria-label="Expand asset rail">
            <PanelLeftOpen aria-hidden="true" size={17} />
          </button>
        ) : null}
      </div>

      <div className="titlebar__identity">
        <h1>{thread?.title || 'New conversation'}</h1>
        {thread ? (
          <span className={`thread-badge thread-badge--${thread.status}`}>
            <span aria-hidden="true" />
            {thread.status === 'running' ? 'Working' : thread.status}
          </span>
        ) : (
          <span>Thread begins with your first message</span>
        )}
      </div>

      <div className="titlebar__actions no-drag">
        {status.phase === 'connected' ? (
          <div className="server-pill server-pill--connected" role="status" aria-label="Local server connected">
            <span aria-hidden="true" />
            <span>Connected</span>
          </div>
        ) : (
          <button
            className={`server-pill server-pill--${status.phase}`}
            type="button"
            onClick={onRetry}
            aria-label={`Server ${status.phase}. Retry connection`}
          >
            <span aria-hidden="true" />
            <span>{status.phase}</span>
            <RefreshCcw aria-hidden="true" size={12} />
          </button>
        )}
        <button className="icon-button" type="button" onClick={onToggleTheme} aria-label={`Use ${darkTheme ? 'light' : 'dark'} theme`}>
          {darkTheme ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
        </button>
        {showInspector ? (
          <button className="icon-button inspector-trigger" type="button" onClick={onOpenInspector} aria-label="Open context inspector">
            <PanelRightOpen aria-hidden="true" size={17} />
          </button>
        ) : null}
        {platform !== 'darwin' ? (
          <div className="window-controls" aria-label="Window controls">
            <button type="button" onClick={() => onWindowAction('minimize')} aria-label="Minimize window"><Minus aria-hidden="true" size={14} /></button>
            <button type="button" onClick={() => onWindowAction('maximize')} aria-label="Maximize window"><Maximize2 aria-hidden="true" size={13} /></button>
            <button className="window-close" type="button" onClick={() => onWindowAction('close')} aria-label="Close window"><X aria-hidden="true" size={15} /></button>
          </div>
        ) : null}
      </div>
    </header>
  )
}
