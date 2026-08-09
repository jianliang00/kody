import {
  CheckCircle2,
  Circle,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Project, Thread, ThreadWorkflowState } from '@shared/protocol'
import {
  filterWorkbenchThreads,
  threadWorkflowBucket,
  threadWorkflowBucketLabel,
  workbenchSelectionLabel,
  type WorkbenchSelection
} from '../lib/workbench'
import { ThreadWorkflowMenu } from './ThreadWorkflowMenu'

interface AssetRailProps {
  threads: Thread[]
  projects: Project[]
  activeThreadId?: string
  selection: WorkbenchSelection
  open: boolean
  workbenchCollapsed: boolean
  onClose: () => void
  onCollapse: () => void
  onExpandWorkbench: () => void
  onSelectThread: (threadId: string) => void
  onWorkflowChange: (threadId: string, workflowState: ThreadWorkflowState) => void
  workflowPendingIds: ReadonlySet<string>
}

function relativeTime(value: string): string {
  const deltaMinutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, 'minute')
  const deltaHours = Math.round(deltaMinutes / 60)
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, 'hour')
  return formatter.format(Math.round(deltaHours / 24), 'day')
}

function threadProject(thread: Thread, projects: Project[]): Project | undefined {
  const projectReference = thread.default_references.find((reference) => reference.kind === 'project')
  return projectReference?.kind === 'project'
    ? projects.find((project) => project.id === projectReference.project_id)
    : undefined
}

interface ThreadListRowProps {
  thread: Thread
  project?: Project
  active: boolean
  pending: boolean
  onOpen: () => void
  onWorkflowChange: (workflowState: ThreadWorkflowState) => void
}

function ThreadListRow({
  thread,
  project,
  active,
  pending,
  onOpen,
  onWorkflowChange
}: ThreadListRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const bucket = threadWorkflowBucket(thread)
  const toggleTarget: ThreadWorkflowState = bucket === 'handled' ? 'new_progress' : 'handled'
  const toggleLabel = thread.status === 'running'
    ? `In Progress: ${thread.title}`
    : bucket === 'handled'
      ? `Restore ${thread.title} to New Progress`
      : `Mark ${thread.title} as Processed`

  return (
    <li
      className={`asset-row asset-row--thread asset-row--workflow-${bucket}${active ? ' asset-row--active' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        if (thread.status !== 'running' && !pending) setMenuOpen(true)
      }}
    >
      <button
        className="asset-row__status-action"
        type="button"
        aria-label={toggleLabel}
        disabled={thread.status === 'running' || pending}
        onClick={() => onWorkflowChange(toggleTarget)}
      >
        <span className={`asset-row__status asset-row__status--${bucket}`}>
          {pending
            ? <LoaderCircle className="spin" aria-hidden="true" size={16} />
            : bucket === 'handled'
              ? <CheckCircle2 aria-hidden="true" size={17} />
              : <Circle aria-hidden="true" size={17} />}
        </span>
      </button>
      <button
        className="asset-row__open"
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
            event.preventDefault()
            if (thread.status !== 'running' && !pending) setMenuOpen(true)
          }
        }}
      >
        <span className="asset-row__content">
          <span className="asset-row__topline">
            <strong>{thread.title}</strong>
            <time dateTime={thread.updated_at}>{relativeTime(thread.updated_at)}</time>
          </span>
          <span className="asset-row__meta">
            <span className="asset-row__project">{project?.name ?? 'No Project'}</span>
            <span className={`asset-row__badge asset-row__badge--${bucket}`}>
              {threadWorkflowBucketLabel(bucket)}
            </span>
          </span>
          <span className="asset-row__summary">
            {thread.summary || (thread.status === 'running' ? 'Agent is working…' : 'No summary yet')}
          </span>
        </span>
      </button>
      <ThreadWorkflowMenu
        thread={thread}
        open={menuOpen}
        pending={pending}
        onOpenChange={setMenuOpen}
        onWorkflowChange={onWorkflowChange}
      />
    </li>
  )
}

export function AssetRail({
  threads,
  projects,
  activeThreadId,
  selection,
  open,
  workbenchCollapsed,
  onClose,
  onCollapse,
  onExpandWorkbench,
  onSelectThread,
  onWorkflowChange,
  workflowPendingIds
}: AssetRailProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const selectionThreads = useMemo(
    () => filterWorkbenchThreads(threads, selection),
    [selection, threads]
  )
  const visibleThreads = useMemo(
    () => selectionThreads.filter((thread) => (
      `${thread.title} ${thread.summary ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, selectionThreads]
  )
  const selectionLabel = workbenchSelectionLabel(selection, projects)

  return (
    <aside
      id="asset-rail"
      className={`asset-rail${open ? ' asset-rail--open' : ''}`}
      aria-label="Threads"
    >
      <div className="asset-rail__window-drag" aria-hidden="true" />
      <header className="asset-rail__header">
        <div className="asset-rail__heading">
          <span>Threads</span>
          <h2>{selectionLabel}</h2>
        </div>
        <div className="asset-rail__header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => document.querySelector<HTMLInputElement>('#asset-filter')?.focus()}
            aria-label="Search Threads"
            aria-controls="asset-filter"
          >
            <Search aria-hidden="true" size={15} />
          </button>
          {workbenchCollapsed ? (
            <button
              className="icon-button workbench-mobile-expand"
              id="expand-workbench"
              type="button"
              onClick={onExpandWorkbench}
              aria-label="Expand workbench sidebar"
              aria-controls="workbench-rail"
            >
              <PanelLeftOpen aria-hidden="true" size={16} />
            </button>
          ) : null}
          <button
            className="icon-button rail-desktop-collapse"
            type="button"
            onClick={onCollapse}
            aria-label="Collapse Thread list"
            aria-controls="asset-rail"
          >
            <PanelLeftClose aria-hidden="true" size={16} />
          </button>
          <button
            className="icon-button rail-mobile-close"
            type="button"
            onClick={onClose}
            aria-label="Close navigation drawer"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      <label className={`asset-search${query ? ' asset-search--active' : ''}`}>
        <span>Search Threads</span>
        <span className="asset-search__control">
          <Search aria-hidden="true" size={14} />
          <input
            id="asset-filter"
            type="search"
            tabIndex={query ? 0 : -1}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Threads"
          />
        </span>
      </label>

      <nav className="asset-navigation" aria-label="Thread list">
        <div className="asset-list-meta">
          <span>{visibleThreads.length} {visibleThreads.length === 1 ? 'Thread' : 'Threads'}</span>
          {query ? <span>Filtered</span> : null}
        </div>
        {visibleThreads.length === 0 ? (
          <p className="asset-list-empty">
            {query ? 'No matching Threads' : `No Threads in ${selectionLabel}`}
          </p>
        ) : (
          <ul className="asset-list">
            {visibleThreads.map((thread) => {
              const project = threadProject(thread, projects)
              return (
                <ThreadListRow
                  key={thread.id}
                  thread={thread}
                  project={project}
                  active={activeThreadId === thread.id}
                  pending={workflowPendingIds.has(thread.id)}
                  onOpen={() => {
                    onSelectThread(thread.id)
                    onClose()
                  }}
                  onWorkflowChange={(workflowState) => onWorkflowChange(thread.id, workflowState)}
                />
              )
            })}
          </ul>
        )}
      </nav>
    </aside>
  )
}
