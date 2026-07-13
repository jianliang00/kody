import {
  Check,
  ChevronDown,
  CircleDot,
  Clipboard,
  Code2,
  FileCode2,
  FolderCog,
  PanelRightClose,
  ShieldCheck,
  Terminal,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ContextReference, EventEnvelope, Project, Thread, ThreadSnapshot } from '@shared/protocol'
import { ReferenceChips } from './ReferenceChips'
import { referenceKey } from '../lib/references'

interface InspectorProps {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  draftReferences: ContextReference[]
  events: EventEnvelope[]
  open: boolean
  onClose: () => void
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
  threads,
  projects,
  draftReferences,
  events,
  open,
  onClose,
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
  const historyReferences = useMemo(() => {
    const references = new Map<string, ContextReference>()
    for (const message of snapshot.messages) {
      for (const reference of message.references) references.set(referenceKey(reference), reference)
    }
    return [...references.values()]
  }, [snapshot.messages])
  const timeline = useMemo(
    () => events
      .map((envelope) => ({ envelope, copy: eventCopy(envelope.event) }))
      .filter((item): item is { envelope: EventEnvelope; copy: NonNullable<ReturnType<typeof eventCopy>> } => Boolean(item.copy))
      .slice(-20)
      .reverse(),
    [events]
  )

  return (
    <aside className={`inspector${open ? ' inspector--open' : ''}`} aria-label="Thread context and activity">
      <header className="inspector__header">
        <div>
          <p className="eyebrow">Thread lens</p>
          <h2>Context &amp; activity</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close context drawer">
          <X className="inspector-mobile-close" aria-hidden="true" size={17} />
          <PanelRightClose className="inspector-desktop-close" aria-hidden="true" size={17} />
        </button>
      </header>

      <div className="inspector__scroll">
        <section className="inspector-section workspace-card" aria-labelledby="workspace-title">
          <header>
            <span className="constellation-node constellation-node--workspace"><FolderCog aria-hidden="true" size={15} /></span>
            <div>
              <p className="eyebrow">Ephemeral runtime</p>
              <h3 id="workspace-title">Workspace</h3>
            </div>
          </header>
          <div className="path-copy">
            <code title={snapshot.workspace.root}>{snapshot.workspace.root}</code>
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
        </section>

        <section className="inspector-section context-constellation" aria-labelledby="constellation-title">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Context constellation</p>
              <h3 id="constellation-title">Active references</h3>
            </div>
            <span className="count-pill">
              {snapshot.thread.default_references.length + historyReferences.length + draftReferences.length}
            </span>
          </header>
          <div className="constellation-graphic" aria-hidden="true">
            <span className="constellation-orbit" />
            <span className="constellation-core">C</span>
            <span className="constellation-dot constellation-dot--workspace" />
            {snapshot.thread.default_references.slice(0, 3).map((reference, index) => (
              <span
                className={`constellation-dot constellation-dot--${reference.kind} constellation-dot--position-${index + 1}`}
                key={`${reference.kind}-${index}`}
              />
            ))}
          </div>

          <div className="reference-group">
            <div className="reference-group__label">
              <strong>Default context</strong>
              <span>Always included in future turns</span>
            </div>
            <ReferenceChips
              references={snapshot.thread.default_references}
              threads={threads}
              projects={projects}
              compact
              emptyLabel="No persistent defaults"
            />
          </div>
          <div className="reference-group">
            <div className="reference-group__label">
              <strong>Active history</strong>
              <span>Accumulated from earlier messages</span>
            </div>
            <ReferenceChips
              references={historyReferences}
              threads={threads}
              projects={projects}
              compact
              emptyLabel="No references attached in history"
            />
          </div>
          <div className="reference-group">
            <div className="reference-group__label">
              <strong>Pending context</strong>
              <span>Editable in the composer</span>
            </div>
            <ReferenceChips
              references={draftReferences}
              threads={threads}
              projects={projects}
              compact
              emptyLabel="Mention an asset to add context"
            />
            {draftReferences.length > 0 ? (
              <p className="reference-group__note">
                These references attach to the next message, then remain available to later turns in this Thread.
              </p>
            ) : null}
          </div>
        </section>

        <details className="inspector-section disclosure" open>
          <summary>
            <span><FileCode2 aria-hidden="true" size={15} /> Changed files</span>
            <span className="summary-tail"><span className="count-pill">{changedFiles.length}</span><ChevronDown aria-hidden="true" size={14} /></span>
          </summary>
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
        </details>

        <section className="inspector-section" aria-labelledby="timeline-title">
          <header className="section-heading">
            <div>
              <p className="eyebrow">Current app session</p>
              <h3 id="timeline-title">Execution timeline</h3>
            </div>
            <span className="count-pill">{timeline.length}</span>
          </header>
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
        </section>
      </div>
    </aside>
  )
}
