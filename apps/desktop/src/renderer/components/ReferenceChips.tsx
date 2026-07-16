import { Eye, FileArchive, FileText, Pencil, X } from 'lucide-react'
import type { ContextReference, Project, Thread } from '@shared/protocol'
import {
  referenceKey,
  referenceModeLabel,
  resolveReferenceName
} from '../lib/references'
import { KodySelect } from './KodySelect'

const PROJECT_ACCESS_OPTIONS = [
  { value: 'read_only', label: 'Read only' },
  { value: 'read_write', label: 'Read & write' }
]
const THREAD_REFERENCE_MODE_OPTIONS = [
  { value: 'summary', label: 'Summary' },
  { value: 'full', label: 'Full context' },
  { value: 'artifacts', label: 'Artifacts' }
]

interface ReferenceChipsProps {
  references: ContextReference[]
  threads: Thread[]
  projects: Project[]
  onChange?: (reference: ContextReference) => void
  onRemove?: (reference: ContextReference) => void
  compact?: boolean
  emptyLabel?: string
}

function ModeIcon({ reference }: { reference: ContextReference }) {
  if (reference.kind === 'project') {
    return reference.access === 'read_write' ? (
      <Pencil aria-hidden="true" size={12} />
    ) : (
      <Eye aria-hidden="true" size={12} />
    )
  }
  return reference.mode === 'artifacts' ? (
    <FileArchive aria-hidden="true" size={12} />
  ) : (
    <FileText aria-hidden="true" size={12} />
  )
}

export function ReferenceChips({
  references,
  threads,
  projects,
  onChange,
  onRemove,
  compact = false,
  emptyLabel
}: ReferenceChipsProps) {
  if (references.length === 0) {
    return emptyLabel ? <p className="reference-empty">{emptyLabel}</p> : null
  }

  return (
    <ul className={`reference-chips${compact ? ' reference-chips--compact' : ''}`}>
      {references.map((reference) => {
        const name = resolveReferenceName(reference, threads, projects)
        const mode = referenceModeLabel(reference)
        const mutable = Boolean(onChange)
        return (
          <li
            className={`reference-chip reference-chip--${reference.kind}`}
            key={referenceKey(reference)}
          >
            <span className="reference-node" aria-hidden="true" />
            <span className="reference-chip__name" title={name}>
              {name}
            </span>
            {mutable ? (
              <span className="reference-chip__mode reference-chip__mode--select">
                <ModeIcon reference={reference} />
                <KodySelect
                  value={reference.kind === 'project' ? reference.access : reference.mode}
                  variant="chip"
                  ariaLabel={`${name} context mode`}
                  options={reference.kind === 'project'
                    ? PROJECT_ACCESS_OPTIONS
                    : THREAD_REFERENCE_MODE_OPTIONS}
                  onValueChange={(value) => {
                    if (reference.kind === 'project') {
                      onChange?.({
                        ...reference,
                        access: value as 'read_only' | 'read_write'
                      })
                    } else {
                      onChange?.({
                        ...reference,
                        mode: value as 'summary' | 'full' | 'artifacts',
                        message_ids: undefined
                      })
                    }
                  }}
                />
              </span>
            ) : (
              <span className="reference-chip__mode reference-chip__mode--static">
                <ModeIcon reference={reference} />
                <span>{mode}</span>
              </span>
            )}
            {onRemove ? (
              <button
                className="reference-chip__remove"
                type="button"
                onClick={() => onRemove(reference)}
                aria-label={`Remove ${name} from this message`}
              >
                <X aria-hidden="true" size={13} />
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
