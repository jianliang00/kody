import { Check, ChevronRight, Command, LoaderCircle, X } from 'lucide-react'

export type ToolActivityStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface ToolActivityItem {
  id: string
  name: string
  arguments?: unknown
  content?: string
  metadata?: unknown
  status: ToolActivityStatus
}

interface ToolActivityListProps {
  items: ToolActivityItem[]
}

const SUMMARY_KEYS = [
  'command',
  'cmd',
  'path',
  'query',
  'pattern',
  'url',
  'process_id',
  'project_id'
]

function humanizeToolName(name: string): string {
  const words = name.trim().replace(/[-_]+/g, ' ')
  return words.length > 0 ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : 'Tool'
}

function compactValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const compact = value.trim().replace(/\s+/g, ' ')
    return compact || undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function summarizeArguments(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return compactValue(value)
  const record = value as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const summary = compactValue(record[key])
    if (summary) return summary
  }
  for (const candidate of Object.values(record)) {
    const summary = compactValue(candidate)
    if (summary) return summary
  }
  return undefined
}

function formatDetail(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2)
      } catch {
        return value
      }
    }
    return value
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function hasDetail(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return String(value).length > 0
}

function statusCopy(status: ToolActivityStatus): string {
  if (status === 'running') return 'Running'
  if (status === 'completed') return 'Done'
  if (status === 'failed') return 'Failed'
  return 'Pending'
}

function StatusIcon({ status }: { status: ToolActivityStatus }) {
  if (status === 'running') return <LoaderCircle className="spin" aria-hidden="true" size={13} />
  if (status === 'completed') return <Check aria-hidden="true" size={13} />
  if (status === 'failed') return <X aria-hidden="true" size={13} />
  return <span className="tool-activity__pending-dot" aria-hidden="true" />
}

export function ToolActivityList({ items }: ToolActivityListProps) {
  if (items.length === 0) return null

  return (
    <div className="tool-activity-list" role="group" aria-label="Tool activity">
      {items.map((item) => {
        const summary = summarizeArguments(item.arguments)
        const hasResult = item.status === 'completed' || item.status === 'failed'
        return (
          <details className={`tool-activity tool-activity--${item.status}`} key={item.id}>
            <summary>
              <ChevronRight className="tool-activity__chevron" aria-hidden="true" size={14} />
              <span className="tool-activity__icon" aria-hidden="true"><Command size={14} /></span>
              <span className="tool-activity__summary">
                <span className="tool-activity__name">{humanizeToolName(item.name)}</span>
                {summary ? <code className="tool-activity__brief" title={summary}>{summary}</code> : null}
              </span>
              <span className="tool-activity__status" aria-live="polite" aria-atomic="true">
                <StatusIcon status={item.status} /> {statusCopy(item.status)}
              </span>
            </summary>
            <div className="tool-activity__details">
              {item.arguments !== undefined ? (
                <section>
                  <span className="tool-activity__detail-label">Arguments</span>
                  <pre><code>{formatDetail(item.arguments)}</code></pre>
                </section>
              ) : null}
              {hasResult ? (
                <section>
                  <span className="tool-activity__detail-label">Result</span>
                  {item.content
                    ? <pre><code>{item.content}</code></pre>
                    : <p className="tool-activity__empty">The tool returned no text output.</p>}
                </section>
              ) : (
                <p className="tool-activity__empty">
                  {item.status === 'running' ? 'Kody is running this tool.' : 'This tool is waiting to run.'}
                </p>
              )}
              {hasDetail(item.metadata) ? (
                <section>
                  <span className="tool-activity__detail-label">Metadata</span>
                  <pre><code>{formatDetail(item.metadata)}</code></pre>
                </section>
              ) : null}
            </div>
          </details>
        )
      })}
    </div>
  )
}
