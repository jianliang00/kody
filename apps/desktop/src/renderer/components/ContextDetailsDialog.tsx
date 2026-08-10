import { Activity, ShieldAlert } from 'lucide-react'
import { useMemo, type RefObject } from 'react'
import type {
  ContextReference,
  ProcessOutputPage,
  Project,
  Thread,
  ThreadSnapshot
} from '@shared/protocol'
import { deriveThreadRuntime, type ThreadContextView } from '../lib/threadContext'
import { referenceKey } from '../lib/references'
import { BackgroundProcesses } from './BackgroundProcesses'
import { KodyDialog } from './KodyDialog'
import { ReferenceChips } from './ReferenceChips'

import './context-details-dialog.css'

export type ContextDetailKind = 'threads' | 'projects' | 'runtime'

interface ContextDetailsDialogProps {
  kind: ContextDetailKind | null
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  context: ThreadContextView
  returnFocusRef: RefObject<HTMLElement | null>
  stoppingProcessIds: Set<string>
  processOutputCursors: Record<string, number>
  onOpenChange: (open: boolean) => void
  onReadProcessOutput: (processId: string, afterCursor: number, limit: number) => Promise<ProcessOutputPage>
  onStopProcess: (processId: string) => Promise<void>
}

const DIALOG_COPY: Record<ContextDetailKind, { title: string; description: string }> = {
  threads: {
    title: 'Referenced Threads',
    description: 'Thread context included by default, collected from history, or waiting for the next message.'
  },
  projects: {
    title: 'Referenced Projects',
    description: 'Project context included by default, collected from history, or waiting for the next message.'
  },
  runtime: {
    title: 'Runtime',
    description: 'Current agent activity and managed background processes for this Thread.'
  }
}

export function ContextDetailsDialog({
  kind,
  snapshot,
  threads,
  projects,
  context,
  returnFocusRef,
  stoppingProcessIds,
  processOutputCursors,
  onOpenChange,
  onReadProcessOutput,
  onStopProcess
}: ContextDetailsDialogProps) {
  const activeKind = kind ?? 'threads'
  const copy = DIALOG_COPY[activeKind]
  const historyReferences = useMemo(() => {
    const references = new Map<string, ContextReference>()
    for (const message of snapshot.messages) {
      for (const reference of message.references) references.set(referenceKey(reference), reference)
    }
    return [...references.values()]
  }, [snapshot.messages])

  return (
    <KodyDialog
      open={kind !== null}
      title={copy.title}
      description={copy.description}
      className="context-details-dialog"
      returnFocusRef={returnFocusRef}
      fallbackFocusSelector="#thread-context-card .right-rail-disclosure__toggle, .right-rail-trigger"
      onOpenChange={onOpenChange}
    >
      {activeKind === 'runtime' ? (
        <RuntimeDetails
          snapshot={snapshot}
          projects={projects}
          context={context}
          stoppingProcessIds={stoppingProcessIds}
          processOutputCursors={processOutputCursors}
          onReadProcessOutput={onReadProcessOutput}
          onStopProcess={onStopProcess}
        />
      ) : (
        <ReferenceDetails
          kind={activeKind}
          snapshot={snapshot}
          threads={threads}
          projects={projects}
          historyReferences={historyReferences}
          pendingReferences={context.pendingReferences}
        />
      )}
    </KodyDialog>
  )
}

function ReferenceDetails({
  kind,
  snapshot,
  threads,
  projects,
  historyReferences,
  pendingReferences
}: {
  kind: Exclude<ContextDetailKind, 'runtime'>
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  historyReferences: ContextReference[]
  pendingReferences: ContextReference[]
}) {
  const referenceKind = kind === 'threads' ? 'thread' : 'project'
  const defaultReferences = snapshot.thread.default_references.filter((reference) => reference.kind === referenceKind)
  const filteredHistory = historyReferences.filter((reference) => reference.kind === referenceKind)
  const filteredPending = pendingReferences.filter((reference) => reference.kind === referenceKind)
  const assetLabel = kind === 'threads' ? 'Threads' : 'Projects'

  return (
    <div className="context-details__references">
      <ReferenceGroup
        label="Default context"
        detail="Always included in future turns"
        references={defaultReferences}
        threads={threads}
        projects={projects}
        emptyLabel={`No persistent ${assetLabel.toLowerCase()}`}
      />
      <ReferenceGroup
        label="Active history"
        detail="Accumulated from earlier messages"
        references={filteredHistory}
        threads={threads}
        projects={projects}
        emptyLabel={`No ${assetLabel.toLowerCase()} attached in history`}
      />
      <ReferenceGroup
        label="Pending context"
        detail="Editable in the composer"
        references={filteredPending}
        threads={threads}
        projects={projects}
        emptyLabel={`Mention ${kind === 'threads' ? 'a Thread' : 'a Project'} to add context`}
      />
    </div>
  )
}

function ReferenceGroup({
  label,
  detail,
  references,
  threads,
  projects,
  emptyLabel
}: {
  label: string
  detail: string
  references: ContextReference[]
  threads: Thread[]
  projects: Project[]
  emptyLabel: string
}) {
  return (
    <section className="reference-group" aria-label={label}>
      <div className="reference-group__label">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <ReferenceChips
        references={references}
        threads={threads}
        projects={projects}
        compact
        emptyLabel={emptyLabel}
      />
    </section>
  )
}

function RuntimeDetails({
  snapshot,
  projects,
  context,
  stoppingProcessIds,
  processOutputCursors,
  onReadProcessOutput,
  onStopProcess
}: {
  snapshot: ThreadSnapshot
  projects: Project[]
  context: ThreadContextView
  stoppingProcessIds: Set<string>
  processOutputCursors: Record<string, number>
  onReadProcessOutput: (processId: string, afterCursor: number, limit: number) => Promise<ProcessOutputPage>
  onStopProcess: (processId: string) => Promise<void>
}) {
  const runtime = deriveThreadRuntime(snapshot, context)
  const showGenericTurn = context.activeTurns.length > 0
    && runtime.foregroundTools.length === 0
    && context.pendingApprovals.length === 0

  return (
    <div className="context-details__runtime">
      <section className="context-details__activity" aria-labelledby="context-details-activity-title">
        <header className="section-heading">
          <h3 id="context-details-activity-title">Current activity</h3>
          <span className="count-pill">{runtime.foregroundActivityCount}</span>
        </header>
        {runtime.foregroundActivityCount === 0 ? (
          <p className="inspector-empty">No foreground operations.</p>
        ) : (
          <ul className="context-details__activity-list">
            {showGenericTurn ? (
              <li>
                <Activity aria-hidden="true" size={14} />
                <span><strong>Agent Turn active</strong><small>Model or context work in progress</small></span>
              </li>
            ) : null}
            {context.pendingApprovals.map((approval) => (
              <li key={approval.approval_id}>
                <ShieldAlert aria-hidden="true" size={14} />
                <span><strong>Waiting for approval</strong><small>{approval.reason || approval.name}</small></span>
              </li>
            ))}
            {runtime.foregroundTools.map((tool) => (
              <li key={tool.key}>
                <Activity aria-hidden="true" size={14} />
                <span>
                  <strong>{tool.kind === 'command' ? 'Running command' : `Running ${tool.name}`}</strong>
                  <small>{tool.detail || tool.name}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BackgroundProcesses
        key={snapshot.thread.id}
        processes={snapshot.processes}
        projects={projects}
        stoppingProcessIds={stoppingProcessIds}
        liveOutputCursors={processOutputCursors}
        onReadOutput={onReadProcessOutput}
        onStop={onStopProcess}
      />
    </div>
  )
}
