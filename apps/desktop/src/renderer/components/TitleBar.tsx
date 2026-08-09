import {
  CheckCircle2,
  LoaderCircle,
  Maximize2,
  Menu,
  Minus,
  Moon,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCcw,
  RotateCcw,
  Sun,
  X
} from 'lucide-react'
import type { ServerStatus, Thread, ThreadWorkflowState } from '@shared/protocol'

interface TitleBarProps {
  thread?: Thread
  status: ServerStatus
  platform: NodeJS.Platform
  darkTheme: boolean
  railCollapsed: boolean
  workbenchCollapsed: boolean
  navigationDrawerOpen: boolean
  showRightSidebar: boolean
  rightSidebarExpanded: boolean
  contextCount: number
  contextActive: boolean
  workflowPending: boolean
  onOpenRail: () => void
  onExpandWorkbench: () => void
  onToggleRightSidebar: () => void
  onRetry: () => void
  onToggleTheme: () => void
  onWorkflowChange: (workflowState: ThreadWorkflowState) => void
  onWindowAction: (action: 'minimize' | 'maximize' | 'close') => void
}

export function TitleBar({
  thread,
  status,
  platform,
  darkTheme,
  railCollapsed,
  workbenchCollapsed,
  navigationDrawerOpen,
  showRightSidebar,
  rightSidebarExpanded,
  contextCount,
  contextActive,
  workflowPending,
  onOpenRail,
  onExpandWorkbench,
  onToggleRightSidebar,
  onRetry,
  onToggleTheme,
  onWorkflowChange,
  onWindowAction
}: TitleBarProps) {
  const processed = thread?.status === 'archived' || thread?.workflow_state === 'handled'
  const workflowLabel = thread?.status === 'running'
    ? 'In Progress'
    : processed
      ? 'Restore to New Progress'
      : 'Mark as Processed'

  return (
    <header className="titlebar">
      <div className="titlebar__leading no-drag">
        <button
          className="icon-button rail-mobile-trigger"
          type="button"
          onClick={onOpenRail}
          aria-label="Open navigation drawer"
          aria-controls="navigation-rails"
          aria-expanded={navigationDrawerOpen}
        >
          <Menu aria-hidden="true" size={18} />
        </button>
        {workbenchCollapsed ? (
          <button
            className="icon-button rail-desktop-trigger"
            id="expand-workbench-titlebar"
            type="button"
            onClick={onExpandWorkbench}
            aria-label="Expand workbench sidebar"
            aria-controls="workbench-rail"
          >
            <PanelLeftOpen aria-hidden="true" size={17} />
          </button>
        ) : null}
        {railCollapsed && workbenchCollapsed ? (
          <button
            className="icon-button rail-desktop-trigger"
            id="expand-thread-list-titlebar"
            type="button"
            onClick={onOpenRail}
            aria-label="Expand Thread list"
            aria-controls="asset-rail"
          >
            <PanelLeftOpen aria-hidden="true" size={17} />
          </button>
        ) : null}
      </div>

      <div className="titlebar__identity">
        <h1>{thread?.title || 'New conversation'}</h1>
        {!thread ? (
          <span>Thread begins with your first message</span>
        ) : null}
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
        {thread ? (
          <button
            className="titlebar__workflow-action"
            type="button"
            aria-label={workflowLabel}
            disabled={thread.status === 'running' || workflowPending || status.phase !== 'connected'}
            onClick={() => onWorkflowChange(processed ? 'new_progress' : 'handled')}
          >
            {workflowPending
              ? <LoaderCircle className="spin" aria-hidden="true" size={14} />
              : processed
                ? <RotateCcw aria-hidden="true" size={14} />
                : <CheckCircle2 aria-hidden="true" size={14} />}
            <span>{workflowLabel}</span>
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
