import {
  Activity,
  ChevronRight,
  ShieldAlert,
  TerminalSquare
} from 'lucide-react'
import type { Project, Thread, ThreadSnapshot } from '@shared/protocol'
import { deriveThreadRuntime, type ThreadContextView } from '../lib/threadContext'
import type { ContextDetailKind } from './ContextDetailsDialog'
import { RightRailDisclosure } from './RightRailDisclosure'

interface ThreadContextCardProps {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  context: ThreadContextView
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onOpenDetails: (kind: ContextDetailKind, trigger: HTMLButtonElement) => void
}

export function ThreadContextCard({
  snapshot,
  threads,
  projects,
  context,
  expanded,
  onExpandedChange,
  onOpenDetails
}: ThreadContextCardProps) {
  const { activeProcesses, foregroundTools, activeCount } = deriveThreadRuntime(snapshot, context)
  const pendingThreadCount = context.pendingReferences.filter((reference) => reference.kind === 'thread').length
  const pendingProjectCount = context.pendingReferences.filter((reference) => reference.kind === 'project').length

  return (
    <RightRailDisclosure
      id="thread-context-card"
      className="thread-context-card"
      eyebrow="Current Thread"
      title="Context"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="thread-context-card__body">
        <ContextGroup
          label="Referenced Threads"
          empty="No referenced Threads"
          items={context.threadReferences.map((reference) => ({
            key: reference.thread_id,
            name: threads.find((thread) => thread.id === reference.thread_id)?.title ?? 'Unavailable Thread',
            detail: threadModeLabel(reference.mode),
            kind: 'thread' as const
          }))}
          pendingCount={pendingThreadCount}
          onOpenDetails={(trigger) => onOpenDetails('threads', trigger)}
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
          pendingCount={pendingProjectCount}
          onOpenDetails={(trigger) => onOpenDetails('projects', trigger)}
        />

        <section className="thread-context-card__runtime" aria-labelledby="thread-runtime-title">
          <button
            className="thread-context-card__group-label thread-context-card__detail-trigger"
            type="button"
            aria-haspopup="dialog"
            aria-label="Show Runtime details"
            onClick={(event) => onOpenDetails('runtime', event.currentTarget)}
          >
            <span id="thread-runtime-title">Runtime</span>
            <span className="thread-context-card__detail-meta">
              {activeCount > 0 ? <span className="activity-count"><span aria-hidden="true" /> {activeCount} active</span> : null}
              <ChevronRight aria-hidden="true" size={13} />
            </span>
          </button>
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
      </div>
    </RightRailDisclosure>
  )
}

function ContextGroup({
  label,
  empty,
  items,
  pendingCount,
  onOpenDetails
}: {
  label: string
  empty: string
  items: Array<{ key: string; name: string; detail: string; kind: 'thread' | 'project' }>
  pendingCount: number
  onOpenDetails: (trigger: HTMLButtonElement) => void
}) {
  return (
    <section className="thread-context-card__group" aria-label={label}>
      <button
        className="thread-context-card__group-label thread-context-card__detail-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Show ${label} details`}
        onClick={(event) => onOpenDetails(event.currentTarget)}
      >
        <span>{label}</span>
        <span className="thread-context-card__detail-meta">
          <span>{items.length}{pendingCount > 0 ? ` · ${pendingCount} pending` : ''}</span>
          <ChevronRight aria-hidden="true" size={13} />
        </span>
      </button>
      {items.length === 0 ? (
        <p className="thread-context-card__empty">
          {pendingCount > 0 ? `No active ${label.toLowerCase()}` : empty}
        </p>
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
