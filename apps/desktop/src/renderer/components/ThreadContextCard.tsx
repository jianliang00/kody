import {
  Activity,
  FolderCog,
  FolderGit2,
  MessagesSquare,
  PanelRightOpen,
  ShieldAlert,
  TerminalSquare
} from 'lucide-react'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import type { ThreadContextView } from '../lib/threadContext'

interface ThreadContextCardProps {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  context: ThreadContextView
  detailsOpen: boolean
  onOpenDetails: () => void
}

export function ThreadContextCard({
  snapshot,
  threads,
  projects,
  context,
  detailsOpen,
  onOpenDetails
}: ThreadContextCardProps) {
  const leafActivityCount = context.runningTools.length + context.pendingApprovals.length
  const activeCount = leafActivityCount > 0 ? leafActivityCount : Math.min(context.activeTurns.length, 1)

  return (
    <aside
      id="thread-context-card"
      className={`thread-context-card${detailsOpen ? ' thread-context-card--details-open' : ''}`}
      aria-labelledby="thread-context-card-title"
    >
      <header className="thread-context-card__header">
        <div>
          <p className="eyebrow">Current Thread</p>
          <h2 id="thread-context-card-title">Context</h2>
        </div>
        <button
          className="icon-button icon-button--small"
          type="button"
          onClick={onOpenDetails}
          aria-label={detailsOpen ? 'Hide full context inspector' : 'Open full context inspector'}
          aria-controls="thread-inspector"
          aria-expanded={detailsOpen}
          title={detailsOpen ? 'Hide full context inspector' : 'Open full context inspector'}
        >
          <PanelRightOpen aria-hidden="true" size={15} />
        </button>
      </header>

      <dl className="thread-context-card__metrics">
        <div className="thread-context-card__metric thread-context-card__metric--thread">
          <dt><MessagesSquare aria-hidden="true" size={14} /> Threads</dt>
          <dd>{context.threadReferences.length}</dd>
        </div>
        <div className="thread-context-card__metric thread-context-card__metric--project">
          <dt><FolderGit2 aria-hidden="true" size={14} /> Projects</dt>
          <dd>{context.projectReferences.length}</dd>
        </div>
        <div className="thread-context-card__metric thread-context-card__metric--process">
          <dt title="Managed background processes"><TerminalSquare aria-hidden="true" size={14} /> Managed procs</dt>
          <dd>0</dd>
        </div>
      </dl>

      {!detailsOpen ? <div className="thread-context-card__body">
        <ContextGroup
          label="Referenced Threads"
          empty="No referenced Threads"
          items={context.threadReferences.map((reference) => ({
            key: reference.thread_id,
            name: threads.find((thread) => thread.id === reference.thread_id)?.title ?? 'Unavailable Thread',
            detail: threadModeLabel(reference.mode),
            kind: 'thread' as const
          }))}
        />
        <ContextGroup
          label="Referenced Projects"
          empty="No referenced Projects"
          items={context.projectReferences.map((reference) => ({
            key: reference.project_id,
            name: projects.find((project) => project.id === reference.project_id)?.name ?? 'Unavailable Project',
            detail: reference.access === 'read_write' ? 'Read & write' : 'Read only',
            kind: 'project' as const
          }))}
        />

        <section className="thread-context-card__runtime" aria-labelledby="thread-runtime-title">
          <div className="thread-context-card__group-label">
            <span id="thread-runtime-title">Runtime</span>
            {activeCount > 0 ? <span className="activity-count"><span aria-hidden="true" /> {activeCount} active</span> : null}
          </div>
          {activeCount === 0 ? (
            <p className="thread-context-card__empty">No active operations</p>
          ) : (
            <ul className="thread-context-card__runtime-list">
              {context.pendingApprovals.slice(0, 1).map((approval) => (
                <li key={approval.approval_id}>
                  <ShieldAlert aria-hidden="true" size={13} />
                  <span><strong>Waiting for approval</strong><small>{approval.name}</small></span>
                </li>
              ))}
              {context.runningTools.slice(0, 2).map((tool) => (
                <li key={tool.key}>
                  <Activity aria-hidden="true" size={13} />
                  <span>
                    <strong>{tool.kind === 'command' ? 'Running command' : `Running ${tool.name}`}</strong>
                    <small title={tool.detail}>{tool.detail || tool.name}</small>
                  </span>
                </li>
              ))}
              {context.activeTurns.length > 0 && context.runningTools.length === 0 && context.pendingApprovals.length === 0 ? (
                <li>
                  <Activity aria-hidden="true" size={13} />
                  <span><strong>Agent Turn active</strong><small>Model or context work in progress</small></span>
                </li>
              ) : null}
            </ul>
          )}
          <p className="thread-context-card__process-empty">
            <TerminalSquare aria-hidden="true" size={13} /> No managed background processes
          </p>
        </section>
      </div> : null}

      {!detailsOpen ? <footer className="thread-context-card__footer">
        <FolderCog aria-hidden="true" size={13} />
        <span title={snapshot.workspace.root}>{snapshot.workspace.root}</span>
        {context.pendingReferences.length > 0 ? (
          <span className="count-pill" title="References pending for the next message">+{context.pendingReferences.length}</span>
        ) : null}
      </footer> : null}
    </aside>
  )
}

function ContextGroup({
  label,
  empty,
  items
}: {
  label: string
  empty: string
  items: Array<{ key: string; name: string; detail: string; kind: 'thread' | 'project' }>
}) {
  return (
    <section className="thread-context-card__group" aria-label={label}>
      <div className="thread-context-card__group-label">
        <span>{label}</span>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="thread-context-card__empty">{empty}</p>
      ) : (
        <ul>
          {items.slice(0, 3).map((item) => (
            <li key={item.key}>
              <span className={`reference-node reference-node--${item.kind}`} aria-hidden="true" />
              <strong title={item.name}>{item.name}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
          {items.length > 3 ? <li className="thread-context-card__more">+{items.length - 3} more</li> : null}
        </ul>
      )}
    </section>
  )
}

function threadModeLabel(mode: string): string {
  if (mode === 'full') return 'Full context'
  if (mode === 'messages') return 'Selected messages'
  if (mode === 'artifacts') return 'Artifacts'
  return 'Summary'
}
