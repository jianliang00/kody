import {
  ChevronRight,
  MessageCircle,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { DesktopUpdateStatus } from '@shared/bridge'
import type { ServerStatus, Thread } from '@shared/protocol'
import { UpdateIndicator } from './UpdateIndicator'

interface AssetRailProps {
  threads: Thread[]
  activeThreadId?: string
  status: ServerStatus
  updateStatus: DesktopUpdateStatus
  open: boolean
  onClose: () => void
  onCollapse: () => void
  onNewThread: () => void
  onSelectThread: (threadId: string) => void
  onOpenSettings: () => void
  onUpdateAction: () => void
}

function relativeTime(value: string): string {
  const deltaMinutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, 'minute')
  const deltaHours = Math.round(deltaMinutes / 60)
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, 'hour')
  return formatter.format(Math.round(deltaHours / 24), 'day')
}

export function AssetRail({
  threads,
  activeThreadId,
  status,
  updateStatus,
  open,
  onClose,
  onCollapse,
  onNewThread,
  onSelectThread,
  onOpenSettings,
  onUpdateAction
}: AssetRailProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleThreads = useMemo(
    () => threads.filter((thread) => thread.title.toLocaleLowerCase().includes(normalizedQuery)),
    [threads, normalizedQuery]
  )

  return (
    <aside id="asset-rail" className={`asset-rail${open ? ' asset-rail--open' : ''}`} aria-label="Kody assets">
      <div className="asset-rail__window-drag" aria-hidden="true" />
      <header className="asset-rail__brand">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <div>
            <strong>Kody</strong>
            <span>Agent workspace</span>
          </div>
        </div>
        <button className="icon-button rail-mobile-close" type="button" onClick={onClose} aria-label="Close asset drawer">
          <X aria-hidden="true" size={17} />
        </button>
        <button className="icon-button rail-desktop-collapse" type="button" onClick={onCollapse} aria-label="Collapse asset rail">
          <PanelLeftClose aria-hidden="true" size={17} />
        </button>
      </header>

      <div className="asset-actions">
        <button className="primary-action" type="button" onClick={onNewThread}>
          <Plus aria-hidden="true" size={16} />
          <span>New Thread</span>
        </button>
      </div>

      <label className="asset-search">
        <span>Filter assets</span>
        <span className="asset-search__control">
          <Search aria-hidden="true" size={15} />
          <input
            id="asset-filter"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Threads"
          />
        </span>
      </label>

      <nav className="asset-navigation" aria-label="Threads">
        <section className="asset-section" aria-labelledby="thread-list-title">
          <header className="asset-section__header">
            <h2 id="thread-list-title">Threads</h2>
            <span>{visibleThreads.length}</span>
          </header>
          {visibleThreads.length === 0 ? (
            <p className="asset-list-empty">{query ? 'No matching Threads' : 'No Threads yet'}</p>
          ) : (
            <ul className="asset-list">
              {visibleThreads.map((thread) => (
                <li key={thread.id}>
                  <button
                    className="asset-row asset-row--thread"
                    type="button"
                    aria-current={activeThreadId === thread.id ? 'page' : undefined}
                    onClick={() => {
                      onSelectThread(thread.id)
                      onClose()
                    }}
                  >
                    <span className="asset-row__icon asset-row__icon--thread">
                      <MessageCircle aria-hidden="true" size={15} />
                    </span>
                    <span className="asset-row__body">
                      <strong>{thread.title}</strong>
                      <span>
                        {thread.status === 'running'
                          ? 'Working now'
                          : thread.status === 'archived'
                            ? `Archived · ${relativeTime(thread.updated_at)}`
                            : relativeTime(thread.updated_at)}
                      </span>
                    </span>
                    <span className={`thread-state thread-state--${thread.status}`} aria-label={thread.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </nav>

      <footer className="asset-rail__footer">
        <div className="asset-rail__utilities" role="group" aria-label="Application controls">
          <button
            className="sidebar-utility"
            type="button"
            onClick={() => {
              onOpenSettings()
              onClose()
            }}
            aria-label="Open model settings"
          >
            <span className="sidebar-utility__icon" aria-hidden="true"><Settings2 size={15} /></span>
            <span className="sidebar-utility__copy">
              <strong>Settings</strong>
              <span>Models, providers & account</span>
            </span>
            <ChevronRight className="sidebar-utility__chevron" aria-hidden="true" size={14} />
          </button>
        </div>
        <div className="asset-rail__status-row">
          <div className="asset-rail__connection" role="status">
            <span className={`connection-dot connection-dot--${status.phase}`} aria-hidden="true" />
            <span>{status.phase === 'connected' ? 'Local server connected' : status.phase}</span>
          </div>
          <UpdateIndicator status={updateStatus} onAction={onUpdateAction} />
        </div>
      </footer>
    </aside>
  )
}
