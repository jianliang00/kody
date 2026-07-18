import {
  Maximize2,
  Menu,
  Minus,
  Moon,
  PanelLeftOpen,
  PanelRightClose,
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
  showRightSidebar: boolean
  rightSidebarExpanded: boolean
  contextCount: number
  contextActive: boolean
  onOpenRail: () => void
  onToggleRightSidebar: () => void
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
  showRightSidebar,
  rightSidebarExpanded,
  contextCount,
  contextActive,
  onOpenRail,
  onToggleRightSidebar,
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
        {status.phase !== 'connected' ? (
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
        ) : null}
        <button className="icon-button" type="button" onClick={onToggleTheme} aria-label={`Use ${darkTheme ? 'light' : 'dark'} theme`}>
          {darkTheme ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
        </button>
        {showRightSidebar ? (
          <button
            className="icon-button right-rail-trigger"
            type="button"
            onClick={onToggleRightSidebar}
            aria-label={rightSidebarExpanded ? 'Hide right sidebar' : 'Show right sidebar'}
            aria-controls="right-rail"
            aria-expanded={rightSidebarExpanded}
            title={`${rightSidebarExpanded ? 'Hide' : 'Show'} right sidebar · ${contextCount} active references${contextActive ? ' · runtime active' : ''}`}
          >
            {rightSidebarExpanded
              ? <PanelRightClose aria-hidden="true" size={17} />
              : <PanelRightOpen aria-hidden="true" size={17} />}
            {contextCount > 0 ? <span className="right-rail-trigger__count" aria-hidden="true">{contextCount}</span> : null}
            {contextActive ? <span className="right-rail-trigger__activity" aria-hidden="true" /> : null}
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
