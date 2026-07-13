import {
  ChevronDown,
  CircleStop,
  LoaderCircle,
  RotateCw,
  TerminalSquare
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ManagedProcess, ProcessOutputChunk, ProcessOutputPage, Project } from '@shared/protocol'
import { isProcessActive, processStatusLabel, sortManagedProcesses } from '../lib/processes'

const OUTPUT_PAGE_LIMIT = 64 * 1024
const MAX_RENDERED_OUTPUT_CHARS = 128 * 1024
const RECENT_TERMINAL_PROCESS_LIMIT = 8

interface BackgroundProcessesProps {
  processes: ManagedProcess[]
  projects: Project[]
  stoppingProcessIds: Set<string>
  liveOutputCursors: Record<string, number>
  onReadOutput: (processId: string, afterCursor: number, limit: number) => Promise<ProcessOutputPage>
  onStop: (processId: string) => Promise<void>
}

interface OutputViewState {
  open: boolean
  loading: boolean
  chunks: ProcessOutputChunk[]
  nextCursor?: number
  startCursor?: number
  endCursor?: number
  hasMore: boolean
  sourceTruncated: boolean
  localTruncated: boolean
  error?: string
}

const CLOSED_OUTPUT: OutputViewState = {
  open: false,
  loading: false,
  chunks: [],
  hasMore: false,
  sourceTruncated: false,
  localTruncated: false
}

export function BackgroundProcesses({
  processes,
  projects,
  stoppingProcessIds,
  liveOutputCursors,
  onReadOutput,
  onStop
}: BackgroundProcessesProps) {
  const [outputByProcess, setOutputByProcess] = useState<Record<string, OutputViewState>>({})
  const [showAllProcesses, setShowAllProcesses] = useState(false)
  const readingProcessIds = useRef(new Set<string>())
  const orderedProcesses = useMemo(() => sortManagedProcesses(processes), [processes])
  const activeCount = processes.filter(isProcessActive).length
  const displayedProcesses = useMemo(() => {
    const active = orderedProcesses.filter(isProcessActive)
    const terminal = orderedProcesses.filter((process) => !isProcessActive(process))
    return [...active, ...(showAllProcesses ? terminal : terminal.slice(0, RECENT_TERMINAL_PROCESS_LIMIT))]
  }, [orderedProcesses, showAllProcesses])
  const hiddenProcessCount = processes.length - displayedProcesses.length

  const readOutput = async (process: ManagedProcess, reset: boolean): Promise<void> => {
    const current = outputByProcess[process.id] ?? CLOSED_OUTPUT
    if (current.loading || readingProcessIds.current.has(process.id)) return
    readingProcessIds.current.add(process.id)
    const afterCursor = reset
      ? process.output_start_cursor
      : current.nextCursor ?? process.output_start_cursor
    setOutputByProcess((states) => ({
      ...states,
      [process.id]: {
        ...(states[process.id] ?? CLOSED_OUTPUT),
        open: true,
        loading: true,
        error: undefined
      }
    }))
    try {
      const page = await onReadOutput(process.id, afterCursor, OUTPUT_PAGE_LIMIT)
      setOutputByProcess((states) => {
        const previous = states[process.id] ?? CLOSED_OUTPUT
        const sourceChunks = reset || page.truncated
          ? page.chunks
          : [...previous.chunks, ...page.chunks]
        const bounded = boundOutputChunks(sourceChunks)
        return {
          ...states,
          [process.id]: {
            open: true,
            loading: false,
            chunks: bounded.chunks,
            nextCursor: page.next_cursor,
            startCursor: bounded.chunks[0]?.cursor ?? (
              reset || page.truncated
                ? page.start_cursor
                : previous.startCursor ?? page.start_cursor
            ),
            endCursor: page.end_cursor,
            hasMore: page.has_more,
            sourceTruncated: previous.sourceTruncated || page.truncated,
            localTruncated: previous.localTruncated || bounded.truncated,
            error: undefined
          }
        }
      })
    } catch (error) {
      setOutputByProcess((states) => ({
        ...states,
        [process.id]: {
          ...(states[process.id] ?? CLOSED_OUTPUT),
          open: true,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not read process output.'
        }
      }))
    } finally {
      readingProcessIds.current.delete(process.id)
    }
  }

  const toggleOutput = (process: ManagedProcess): void => {
    const current = outputByProcess[process.id]
    if (!current?.open) {
      if (current?.nextCursor !== undefined) {
        setOutputByProcess((states) => ({
          ...states,
          [process.id]: { ...current, open: true }
        }))
      } else {
        void readOutput(process, true)
      }
      return
    }
    setOutputByProcess((states) => ({
      ...states,
      [process.id]: { ...current, open: false }
    }))
  }

  return (
    <section className="inspector-section process-section" aria-labelledby="background-processes-title">
      <header className="section-heading">
        <div>
          <p className="eyebrow">Process manager</p>
          <h3 id="background-processes-title">Background processes</h3>
        </div>
        <span className="process-section__counts">
          {activeCount > 0 ? <span className="activity-count"><span aria-hidden="true" /> {activeCount} active</span> : null}
          <span className="count-pill" title={`${processes.length} managed process records`}>{processes.length}</span>
        </span>
      </header>

      {orderedProcesses.length === 0 ? (
        <p className="inspector-empty process-section__empty">
          <TerminalSquare aria-hidden="true" size={14} /> No managed background processes.
        </p>
      ) : (
        <ul className="process-list" id="background-process-list">
          {displayedProcesses.map((process) => {
            const output = outputByProcess[process.id] ?? CLOSED_OUTPUT
            const project = projects.find((item) => item.id === process.project_id)
            const stopping = stoppingProcessIds.has(process.id) || process.status === 'stopping'
            const observedOutputEnd = Math.max(
              process.output_end_cursor,
              liveOutputCursors[process.id] ?? 0
            )
            const outputHasAdvanced = output.nextCursor !== undefined
              && output.nextCursor < observedOutputEnd
            const outputPanelId = `process-output-${process.id}`
            return (
              <li className="process-card" key={process.id}>
                <header className="process-card__header">
                  <span className={`process-status process-status--${process.status}`}>
                    <span aria-hidden="true" /> {processStatusLabel(process.status)}
                  </span>
                  <span className="process-card__identity">
                    {process.pid !== undefined ? `PID ${process.pid}` : 'PID pending'}
                  </span>
                </header>
                <code className="process-card__command" title={process.command}>{process.command}</code>
                <p className="process-card__location" title={process.cwd}>
                  {project?.name ?? 'Workspace'} · {process.cwd}
                </p>
                {process.error ? <p className="process-card__error" role="status">{process.error}</p> : null}
                {process.exit_code !== undefined && !isProcessActive(process) ? (
                  <p className="process-card__exit">Exit code {process.exit_code}</p>
                ) : null}

                <div className="process-card__actions">
                  <button
                    className="process-action"
                    type="button"
                    aria-expanded={output.open}
                    aria-controls={outputPanelId}
                    onClick={() => toggleOutput(process)}
                  >
                    <ChevronDown className={output.open ? 'process-action__chevron--open' : undefined} aria-hidden="true" size={13} />
                    {output.open ? 'Hide output' : 'View output'}
                  </button>
                  {isProcessActive(process) ? (
                    <button
                      className="process-action process-action--stop"
                      type="button"
                      disabled={stopping}
                      title={stopping ? 'Kody is stopping this process' : 'Stop this managed process'}
                      onClick={() => void onStop(process.id)}
                    >
                      {stopping
                        ? <LoaderCircle className="spin" aria-hidden="true" size={13} />
                        : <CircleStop aria-hidden="true" size={13} />}
                      {stopping ? 'Stopping…' : 'Stop'}
                    </button>
                  ) : null}
                </div>

                {output.open ? (
                  <div className="process-output" id={outputPanelId}>
                    <div className="process-output__meta">
                      <span>{formatCursorRange(output, process)}</span>
                      {(process.output_truncated || output.sourceTruncated || output.localTruncated)
                        ? <span>Earlier output omitted</span>
                        : null}
                    </div>
                    {output.error ? <p className="process-output__error" role="status">{output.error}</p> : null}
                    <pre
                      className="process-output__log"
                      role="log"
                      aria-live="off"
                      aria-label={`Output for ${process.command}`}
                    >
                      {output.loading && output.chunks.length === 0 ? 'Loading output…' : null}
                      {!output.loading && output.chunks.length === 0 ? 'No output captured.' : null}
                      {output.chunks.map((chunk) => (
                        <span
                          className={`process-output__chunk process-output__chunk--${chunk.stream}`}
                          key={`${chunk.cursor}:${chunk.next_cursor}:${chunk.stream}`}
                        >
                          {chunk.stream === 'stderr' ? <span className="process-output__stream">[stderr] </span> : null}
                          {chunk.text}
                        </span>
                      ))}
                    </pre>
                    {(output.hasMore || outputHasAdvanced) ? (
                      <button
                        className="process-output__more"
                        type="button"
                        disabled={output.loading}
                        onClick={() => void readOutput(process, false)}
                      >
                        {output.loading
                          ? <LoaderCircle className="spin" aria-hidden="true" size={12} />
                          : <RotateCw aria-hidden="true" size={12} />}
                        {output.hasMore ? 'Load more' : 'Read new output'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {hiddenProcessCount > 0 ? (
        <button
          className="process-section__history"
          type="button"
          aria-controls="background-process-list"
          aria-expanded={false}
          onClick={() => setShowAllProcesses(true)}
        >
          Show {hiddenProcessCount} older process {hiddenProcessCount === 1 ? 'record' : 'records'}
        </button>
      ) : showAllProcesses && processes.length > RECENT_TERMINAL_PROCESS_LIMIT ? (
        <button
          className="process-section__history"
          type="button"
          aria-controls="background-process-list"
          aria-expanded={true}
          onClick={() => setShowAllProcesses(false)}
        >
          Show recent processes only
        </button>
      ) : null}
    </section>
  )
}

function boundOutputChunks(chunks: ProcessOutputChunk[]): {
  chunks: ProcessOutputChunk[]
  truncated: boolean
} {
  let renderedCharacters = 0
  let firstRetained = chunks.length
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (!chunk) continue
    if (renderedCharacters > 0 && renderedCharacters + chunk.text.length > MAX_RENDERED_OUTPUT_CHARS) break
    renderedCharacters += chunk.text.length
    firstRetained = index
  }
  return { chunks: chunks.slice(firstRetained), truncated: firstRetained > 0 }
}

function formatCursorRange(output: OutputViewState, process: ManagedProcess): string {
  const start = output.startCursor ?? process.output_start_cursor
  const end = output.nextCursor ?? process.output_end_cursor
  return `Output bytes ${start.toLocaleString()}–${end.toLocaleString()}`
}
