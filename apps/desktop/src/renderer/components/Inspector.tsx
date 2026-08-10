import {
  Check,
  CircleDot,
  Clipboard,
  Code2,
  FileCode2,
  ShieldCheck,
  Terminal,
  X
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type {
  EventEnvelope,
  Project,
  ThreadSnapshot
} from '@shared/protocol'
import { RightRailDisclosure } from './RightRailDisclosure'
import type { RightRailSectionId, RightRailSectionsState } from '../lib/rightRailSections'

interface InspectorProps {
  snapshot: ThreadSnapshot
  projects: Project[]
  events: EventEnvelope[]
  open: boolean
  modal: boolean
  modalSuspended?: boolean
  sections: RightRailSectionsState
  children?: ReactNode
  onClose: () => void
  onSectionExpandedChange: (id: RightRailSectionId, expanded: boolean) => void
  onCopyText: (text: string) => Promise<void>
}

function eventCopy(event: EventEnvelope['event']): { label: string; detail?: string; kind: string } | null {
  switch (event.type) {
    case 'turn_started':
      return { label: 'Turn started', kind: 'turn' }
    case 'step_started':
      return { label: `Agent step ${event.step}`, kind: 'turn' }
    case 'model_started':
      return { label: 'Model started', detail: `${event.provider} · ${event.model}`, kind: 'model' }
    case 'model_completed':
      return { label: 'Model completed', detail: event.stop_reason, kind: 'model' }
    case 'approval_requested':
      return { label: 'Approval requested', detail: event.name, kind: 'approval' }
    case 'approval_resolved':
      return { label: event.approved ? 'Access allowed' : 'Access denied', kind: 'approval' }
    case 'user_input_requested':
      return {
        label: 'User input requested',
        detail: event.questions.map((question) => question.header).join(', '),
        kind: 'input'
      }
    case 'user_input_resolved':
      return { label: event.cancelled ? 'Input request cancelled' : 'User input received', kind: 'input' }
    case 'tool_started':
      return { label: `${event.name} started`, detail: toolDetail(event.arguments), kind: 'tool' }
    case 'tool_completed':
      return {
        label: `${event.name} ${event.is_error ? 'failed' : 'completed'}`,
        detail: event.content.length > 140 ? `${event.content.slice(0, 140)}…` : event.content,
        kind: 'tool'
      }
    case 'file_changed':
      return { label: 'File changed', detail: event.path, kind: 'file' }
    case 'thread_updated':
      return { label: 'Thread named', detail: event.title, kind: 'turn' }
    case 'turn_completed':
      return { label: 'Turn completed', kind: 'turn' }
    case 'turn_failed':
      return { label: 'Turn failed', detail: event.error, kind: 'error' }
    case 'turn_cancelled':
      return { label: 'Turn cancelled', kind: 'error' }
    case 'model_output_delta':
    case 'model_reasoning_delta':
      return null
  }
}

function toolDetail(argumentsValue: unknown): string | undefined {
  if (!argumentsValue || typeof argumentsValue !== 'object') return undefined
  const args = argumentsValue as Record<string, unknown>
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  return undefined
}

function eventIcon(kind: string) {
  if (kind === 'tool') return <Terminal aria-hidden="true" size={13} />
  if (kind === 'file') return <FileCode2 aria-hidden="true" size={13} />
  if (kind === 'approval') return <ShieldCheck aria-hidden="true" size={13} />
  if (kind === 'model') return <Code2 aria-hidden="true" size={13} />
  return <CircleDot aria-hidden="true" size={13} />
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

export function Inspector({
  snapshot,
  projects,
  events,
  open,
  modal,
  modalSuspended = false,
  sections,
  children,
  onClose,
  onSectionExpandedChange,
  onCopyText
}: InspectorProps) {
  const [copied, setCopied] = useState(false)
  const changedFiles = useMemo(() => {
    const byPath = new Map<string, { path: string; projectId?: string }>()
    for (const envelope of events) {
      if (envelope.event.type !== 'file_changed') continue
      byPath.set(`${envelope.event.project_id ?? 'workspace'}:${envelope.event.path}`, {
        path: envelope.event.path,
        projectId: envelope.event.project_id
      })
    }
    return [...byPath.values()]
  }, [events])
  const timeline = useMemo(
    () => events
      .map((envelope) => ({ envelope, copy: eventCopy(envelope.event) }))
      .filter((item): item is { envelope: EventEnvelope; copy: NonNullable<ReturnType<typeof eventCopy>> } => Boolean(item.copy))
      .slice(-20)
      .reverse(),
    [events]
  )
  return (
    <section
      id="thread-inspector"
      className={`inspector${open ? ' inspector--open' : ''}`}
      role={open && modal && !modalSuspended ? 'dialog' : undefined}
      aria-modal={open && modal && !modalSuspended ? true : undefined}
      aria-label={open && modal && !modalSuspended ? 'Thread context and activity' : undefined}
    >
      {modal ? (
        <header className="inspector__header">
          <div>
            <p className="eyebrow">Thread lens</p>
            <h2>Context &amp; activity</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close right sidebar"
            title="Close right sidebar"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
      ) : null}

      <div className="inspector__scroll">
        {children}
        <RightRailDisclosure
          id="right-rail-workspace"
          className="workspace-card"
          eyebrow="Ephemeral runtime"
          title="Workspace"
          expanded={sections.workspace}
          onExpandedChange={(expanded) => onSectionExpandedChange('workspace', expanded)}
        >
          <div className="path-copy">
            <div
              className="path-copy__scroll"
              role="region"
              aria-label="Workspace path"
              tabIndex={0}
            >
              <code title={snapshot.workspace.root}>{snapshot.workspace.root}</code>
            </div>
            <button
              className="icon-button icon-button--small"
              type="button"
              aria-label="Copy Workspace path"
              onClick={async () => {
                try {
                  await onCopyText(snapshot.workspace.root)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1_500)
                } catch {
                  setCopied(false)
                }
              }}
            >
              {copied ? <Check aria-hidden="true" size={14} /> : <Clipboard aria-hidden="true" size={14} />}
            </button>
          </div>
          <p>Temporary files and generated artifacts for this Thread live here.</p>
        </RightRailDisclosure>

        <RightRailDisclosure
          id="right-rail-changes"
          eyebrow="Current app session"
          title="Changed files"
          badge={<span className="count-pill">{changedFiles.length}</span>}
          expanded={sections.changes}
          onExpandedChange={(expanded) => onSectionExpandedChange('changes', expanded)}
        >
          {changedFiles.length === 0 ? (
            <p className="inspector-empty">No file changes observed in this app session.</p>
          ) : (
            <ul className="changed-files">
              {changedFiles.map((file) => {
                const project = projects.find((item) => item.id === file.projectId)
                return (
                  <li key={`${file.projectId ?? 'workspace'}:${file.path}`}>
                    <FileCode2 aria-hidden="true" size={14} />
                    <span><strong>{file.path.split(/[\\/]/).pop()}</strong><small>{project?.name || 'Workspace'} · {file.path}</small></span>
                  </li>
                )
              })}
            </ul>
          )}
        </RightRailDisclosure>

        <RightRailDisclosure
          id="right-rail-timeline"
          eyebrow="Current app session"
          title="Execution timeline"
          badge={<span className="count-pill">{timeline.length}</span>}
          expanded={sections.timeline}
          onExpandedChange={(expanded) => onSectionExpandedChange('timeline', expanded)}
        >
          {timeline.length === 0 ? (
            <p className="inspector-empty">Activity from the next turn will appear here.</p>
          ) : (
            <ol className="timeline">
              {timeline.map(({ envelope, copy }) => (
                <li className={`timeline-item timeline-item--${copy.kind}`} key={envelope.id}>
                  <span className="timeline-item__icon">{eventIcon(copy.kind)}</span>
                  <div>
                    <strong>{copy.label}</strong>
                    {copy.detail ? <span title={copy.detail}>{copy.detail}</span> : null}
                    <time dateTime={envelope.created_at}>{formatEventTime(envelope.created_at)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </RightRailDisclosure>
      </div>
    </section>
  )
}
