import { AtSign, Send, Square } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ContextReference, Project, Thread } from '@shared/protocol'
import {
  createCandidates,
  filterCandidates,
  findMention,
  removeMention,
  removeReference,
  upsertReference,
  type MentionMatch,
  type ReferenceCandidate
} from '../lib/references'
import { MentionPalette } from './MentionPalette'
import { ReferenceChips } from './ReferenceChips'

interface ComposerProps {
  currentThreadId: string
  threads: Thread[]
  projects: Project[]
  references: ContextReference[]
  providers: string[]
  provider: string
  running: boolean
  unavailable?: boolean
  onReferencesChange: (references: ContextReference[]) => void
  onProviderChange: (provider: string) => void
  onSend: (message: string, references: ContextReference[]) => Promise<boolean>
  onCancel: () => Promise<void>
}

export function Composer({
  currentThreadId,
  threads,
  projects,
  references,
  providers,
  provider,
  running,
  unavailable = false,
  onReferencesChange,
  onProviderChange,
  onSend,
  onCancel
}: ComposerProps) {
  const [message, setMessage] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [manualPalette, setManualPalette] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [validationError, setValidationError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const cancellingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const contextButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const candidates = useMemo(
    () => createCandidates(threads, projects, currentThreadId),
    [threads, projects, currentThreadId]
  )
  const visibleCandidates = useMemo(
    () => filterCandidates(candidates, paletteQuery, references),
    [candidates, paletteQuery, references]
  )

  const closePalette = (restore: 'composer' | 'button' = 'composer'): void => {
    setPaletteOpen(false)
    setManualPalette(false)
    setMention(null)
    setPaletteQuery('')
    requestAnimationFrame(() => {
      if (restore === 'button') contextButtonRef.current?.focus()
      else textareaRef.current?.focus()
    })
  }

  const selectCandidate = (candidate: ReferenceCandidate): void => {
    onReferencesChange(upsertReference(references, candidate.reference))
    if (mention) setMessage((current) => removeMention(current, mention))
    closePalette('composer')
    setValidationError('')
  }

  const openManualPalette = (): void => {
    if (unavailable || running) return
    if (paletteOpen && manualPalette) {
      closePalette('button')
      return
    }
    setManualPalette(true)
    setMention(null)
    setPaletteQuery('')
    setActiveIndex(0)
    setPaletteOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }

  const updateMessage = (value: string, cursor: number): void => {
    setMessage(value)
    setValidationError('')
    const nextMention = findMention(value, cursor)
    if (nextMention) {
      setMention(nextMention)
      setPaletteQuery(nextMention.query)
      setManualPalette(false)
      setActiveIndex(0)
      setPaletteOpen(true)
    } else if (!manualPalette) {
      setMention(null)
      setPaletteOpen(false)
    }
  }

  const submit = async (): Promise<void> => {
    const trimmed = message.trim()
    if (!trimmed) {
      setValidationError('Write a message before starting a turn.')
      textareaRef.current?.focus()
      return
    }
    if (running || submittingRef.current || unavailable) return
    submittingRef.current = true
    setSubmitting(true)
    setValidationError('')
    try {
      const sent = await onSend(trimmed, references)
      if (sent) {
        setMessage('')
        onReferencesChange([])
        closePalette('composer')
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (paletteOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePalette('composer')
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (visibleCandidates.length > 0) {
          const direction = event.key === 'ArrowDown' ? 1 : -1
          setActiveIndex(
            (activeIndex + direction + visibleCandidates.length) % visibleCandidates.length
          )
        }
        return
      }
      if (event.key === 'Enter' && !event.shiftKey && visibleCandidates[activeIndex]) {
        event.preventDefault()
        selectCandidate(visibleCandidates[activeIndex])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <form
      className="composer"
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {paletteOpen ? (
        <MentionPalette
          candidates={visibleCandidates}
          query={paletteQuery}
          showSearch={manualPalette}
          activeIndex={Math.min(activeIndex, Math.max(visibleCandidates.length - 1, 0))}
          searchInputRef={searchInputRef}
          onQueryChange={(query) => {
            setPaletteQuery(query)
            setActiveIndex(0)
          }}
          onActiveIndexChange={setActiveIndex}
          onSelect={selectCandidate}
          onClose={() => closePalette(manualPalette ? 'button' : 'composer')}
        />
      ) : null}

      <div className="composer__topline">
        <label htmlFor="composer-message">Message</label>
        <div className="composer__provider">
          <label htmlFor="composer-provider">Provider</label>
          <select
            id="composer-provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            disabled={running || unavailable || providers.length === 0}
          >
            {providers.length === 0 ? <option>Unavailable</option> : null}
            {providers.map((item) => (
              <option value={item} key={item}>{item}</option>
            ))}
          </select>
        </div>
      </div>

      {references.length > 0 ? (
        <div className="composer__references">
          <span className="composer__references-label">For this message</span>
          <ReferenceChips
            references={references}
            threads={threads}
            projects={projects}
            onChange={(reference) => onReferencesChange(upsertReference(references, reference))}
            onRemove={(reference) => onReferencesChange(removeReference(references, reference))}
          />
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        id="composer-message"
        value={message}
        rows={3}
        disabled={unavailable}
        placeholder="Ask Cody to inspect, explain, or change something…"
        aria-describedby={`composer-hint${validationError ? ' composer-error' : ''}`}
        aria-invalid={Boolean(validationError)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={paletteOpen}
        aria-controls={paletteOpen ? 'context-reference-options' : undefined}
        aria-activedescendant={
          paletteOpen && visibleCandidates[activeIndex]
            ? `context-option-${visibleCandidates[activeIndex].key.replace(':', '-')}`
            : undefined
        }
        onChange={(event) => updateMessage(event.target.value, event.target.selectionStart)}
        onKeyDown={handleComposerKeyDown}
      />
      <p id="composer-error" className="composer__error" role={validationError ? 'alert' : undefined}>
        {validationError}
      </p>

      <footer className="composer__footer">
        <div className="composer__context-controls">
          <button
            ref={contextButtonRef}
            className="context-button"
            type="button"
            disabled={unavailable || running}
            onClick={openManualPalette}
            aria-expanded={paletteOpen && manualPalette}
          >
            <AtSign aria-hidden="true" size={16} />
            <span>Add context</span>
          </button>
          <span id="composer-hint" className="composer__hint">
            References attach here and remain active in later Thread context · <kbd>Enter</kbd> send
          </span>
        </div>
        {running ? (
          <button
            className="turn-button turn-button--stop"
            type="button"
            onClick={() => {
              if (cancellingRef.current) return
              cancellingRef.current = true
              void onCancel().finally(() => {
                cancellingRef.current = false
              })
            }}
          >
            <Square aria-hidden="true" fill="currentColor" size={12} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="turn-button"
            type="submit"
            disabled={unavailable || submitting || providers.length === 0}
            aria-describedby={unavailable ? 'composer-unavailable' : undefined}
          >
            <Send aria-hidden="true" size={15} />
            <span>{submitting ? 'Starting…' : 'Send'}</span>
          </button>
        )}
      </footer>
      {unavailable ? (
        <p id="composer-unavailable" className="composer__unavailable">
          Reconnect to the server before starting a turn.
        </p>
      ) : null}
    </form>
  )
}
