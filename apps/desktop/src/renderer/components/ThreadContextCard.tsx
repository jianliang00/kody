import { useState } from 'react'
import {
  Activity,
  Check,
  ChevronDown,
  Clipboard,
  FolderCog,
  FolderGit2,
  MessagesSquare,
  ShieldAlert,
  TerminalSquare
} from 'lucide-react'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import type { ThreadContextView } from '../lib/threadContext'
import { isProcessActive, sortManagedProcesses } from '../lib/processes'

interface ThreadContextCardProps {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  context: ThreadContextView
  detailsOpen: boolean
  onOpenDetails: () => void
  onCopyText: (text: string) => Promise<void>
}

export function ThreadContextCard({
  snapshot,
  threads,
  projects,
  context,
  detailsOpen,
  onOpenDetails,
  onCopyText
}: ThreadContextCardProps) {
  const activeProcesses = sortManagedProcesses(snapshot.processes.filter(isProcessActive))
  const activeProcessOrigins = new Set(activeProcesses.map((process) => (
    `${process.origin.turn_id}:${process.origin.tool_call_id}`
  )))
  const foregroundTools = context.runningTools.filter((tool) => !activeProcessOrigins.has(tool.key))
  const foregroundLeafCount = foregroundTools.length + context.pendingApprovals.length
  const foregroundActivityCount = foregroundLeafCount > 0
    ? foregroundLeafCount
    : Math.min(context.activeTurns.length, 1)
  const activeCount = foregroundActivityCount + activeProcesses.length

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
        {!detailsOpen ? (
          <button
            className="icon-button icon-button--small"
            type="button"
            onClick={onOpenDetails}
            aria-label="Expand Content & activity"
            aria-controls="thread-inspector"
            aria-expanded="false"
            title="Expand Content & activity"
          >
            <ChevronDown aria-hidden="true" size={15} />
          </button>
        ) : null}
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
          <dt title="Active managed background processes"><TerminalSquare aria-hidden="true" size={14} /> Managed procs</dt>
          <dd>{activeProcesses.length}</dd>
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
              {activeProcesses.slice(0, 2).map((process) => (
                <li key={process.id}>
                  <TerminalSquare aria-hidden="true" size={13} />
                  <span>
                    <strong>{process.status === 'stopping' ? 'Stopping background process' : 'Background process active'}</strong>
                    <small title={process.command}>{process.command}</small>
                  </span>
                </li>
              ))}
              {context.pendingApprovals.slice(0, 1).map((approval) => (
                <li key={approval.approval_id}>
                  <ShieldAlert aria-hidden="true" size={13} />
                  <span><strong>Waiting for approval</strong><small>{approval.name}</small></span>
                </li>
              ))}
              {foregroundTools.slice(0, 2).map((tool) => (
                <li key={tool.key}>
                  <Activity aria-hidden="true" size={13} />
                  <span>
                    <strong>{tool.kind === 'command' ? 'Running command' : `Running ${tool.name}`}</strong>
                    <small title={tool.detail}>{tool.detail || tool.name}</small>
                  </span>
                </li>
              ))}
              {context.activeTurns.length > 0 && foregroundTools.length === 0 && context.pendingApprovals.length === 0 ? (
                <li>
                  <Activity aria-hidden="true" size={13} />
                  <span><strong>Agent Turn active</strong><small>Model or context work in progress</small></span>
                </li>
              ) : null}
              {activeProcesses.length > 2 ? (
                <li className="thread-context-card__runtime-more">+{activeProcesses.length - 2} more managed processes</li>
              ) : null}
            </ul>
          )}
          {activeProcesses.length === 0 ? (
            <p className="thread-context-card__process-empty">
              <TerminalSquare aria-hidden="true" size={13} /> No active managed processes
            </p>
          ) : null}
        </section>
      </div> : null}

      {!detailsOpen ? (
        <WorkspacePath
          path={snapshot.workspace.root}
          pendingReferenceCount={context.pendingReferences.length}
          onCopyText={onCopyText}
        />
      ) : null}
    </aside>
  )
}

function WorkspacePath({
  path,
  pendingReferenceCount,
  onCopyText
}: {
  path: string
  pendingReferenceCount: number
  onCopyText: (text: string) => Promise<void>
}) {
  const [copied, setCopied] = useState(false)

  return (
    <footer className="thread-context-card__footer">
      <details className="thread-context-card__workspace-path">
        <summary title={path}>
          <FolderCog aria-hidden="true" size={13} />
          <code>{path}</code>
          {pendingReferenceCount > 0 ? (
            <span className="count-pill" title="References pending for the next message">+{pendingReferenceCount}</span>
          ) : null}
          <ChevronDown className="thread-context-card__workspace-chevron" aria-hidden="true" size={13} />
        </summary>
        <div className="thread-context-card__workspace-full">
          <code>{path}</code>
          <button
            className="icon-button icon-button--small"
            type="button"
            aria-label={copied ? 'Workspace path copied' : 'Copy Workspace path'}
            title={copied ? 'Copied' : 'Copy Workspace path'}
            onClick={async () => {
              try {
                await onCopyText(path)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1_500)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? <Check aria-hidden="true" size={13} /> : <Clipboard aria-hidden="true" size={13} />}
          </button>
        </div>
      </details>
    </footer>
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
