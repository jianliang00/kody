import { AtSign, FolderOpen, Send, ShieldCheck, Square, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type {
  ContextReference,
  ModelDescriptor,
  PermissionMode,
  Project,
  ProviderDescriptor,
  Thread
} from '@shared/protocol'
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
import { KodySelect } from './KodySelect'
import { MentionPalette } from './MentionPalette'
import { ReferenceChips } from './ReferenceChips'

const PERMISSION_MODE_OPTIONS = [
  { value: 'read_only', label: 'Read only' },
  { value: 'ask', label: 'Ask for commands' },
  { value: 'full_access', label: 'Full access' }
]

interface ComposerProps {
  currentThreadId?: string
  threads: Thread[]
  projects: Project[]
  references: ContextReference[]
  providers: ProviderDescriptor[]
  providerId: string
  models: ModelDescriptor[]
  model: string
  permissionMode: PermissionMode
  modelsLoading?: boolean
  running: boolean
  message: string
  draft?: boolean
  workingDirectory?: string
  unavailable?: boolean
  onReferencesChange: (references: ContextReference[]) => void
  onProviderChange: (providerId: string) => void
  onModelChange: (model: string) => void
  onPermissionModeChange: (mode: PermissionMode) => void
  onMessageChange: (message: string) => void
  onPickWorkingDirectory?: () => Promise<void>
  onClearWorkingDirectory?: () => void
  onSend: (
    message: string,
    references: ContextReference[],
    providerId: string,
    model: string,
    permissionMode: PermissionMode
  ) => Promise<boolean>
  onCancel: () => Promise<void>
}

export function Composer({
  currentThreadId,
  threads,
  projects,
  references,
  providers,
  providerId,
  models,
  model,
  permissionMode,
  modelsLoading = false,
  running,
  message,
  draft = false,
  workingDirectory,
  unavailable = false,
  onReferencesChange,
  onProviderChange,
  onModelChange,
  onPermissionModeChange,
  onMessageChange,
  onPickWorkingDirectory,
  onClearWorkingDirectory,
  onSend,
  onCancel
}: ComposerProps) {
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
  const selectedProvider = providers.find((item) => item.id === providerId)
  const modelOptions = useMemo(() => {
    const byId = new Map<string, ModelDescriptor>()
    if (selectedProvider?.default_model) {
      byId.set(selectedProvider.default_model, {
        id: selectedProvider.default_model,
        display_name: selectedProvider.default_model
      })
    }
    for (const item of models) byId.set(item.id, item)
    if (model && !byId.has(model)) byId.set(model, { id: model, display_name: model })
    return [...byId.values()]
  }, [model, models, selectedProvider?.default_model])
  const usesCodexAgentLoop = selectedProvider
    ? selectedProvider.kind === 'codex' || selectedProvider.id === 'codex'
    : false

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
    if (mention) onMessageChange(removeMention(message, mention))
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
    onMessageChange(value)
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
    if (!providerId || !model) {
      setValidationError('Choose a provider and model before starting a turn.')
      return
    }
    if (running || submittingRef.current || unavailable) return
    submittingRef.current = true
    setSubmitting(true)
    setValidationError('')
    try {
      const sent = await onSend(trimmed, references, providerId, model, permissionMode)
      if (sent) {
        onMessageChange('')
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
          <KodySelect
            id="composer-provider"
            value={providerId}
            variant="toolbar"
            placeholder={providers.length === 0 ? 'Unavailable' : 'No configured provider'}
            options={providers.map((item) => ({
              value: item.id,
              label: `${item.display_name}${item.auth === 'missing' ? ' · setup required' : ''}`,
              disabled: item.auth === 'missing'
            }))}
            onValueChange={onProviderChange}
            disabled={running || unavailable || providers.length === 0}
          />
          <label htmlFor="composer-model">Model</label>
          <KodySelect
            id="composer-model"
            value={model}
            variant="toolbar"
            placeholder={modelsLoading ? 'Loading models…' : 'Unavailable'}
            options={modelOptions.map((item) => ({ value: item.id, label: item.display_name }))}
            onValueChange={onModelChange}
            disabled={running || unavailable || !providerId || modelOptions.length === 0}
          />
        </div>
      </div>

      {usesCodexAgentLoop ? (
        <p className="composer__hint">Uses the Codex agent loop and tools for this Turn.</p>
      ) : null}

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
        rows={2}
        disabled={unavailable}
        placeholder="Ask Kody to inspect, explain, or change something…"
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
          <div
            className={`permission-mode-control permission-mode-control--${permissionMode}`}
            title={permissionMode === 'read_only'
              ? 'Only inspection tools can run for this turn.'
              : permissionMode === 'full_access'
                ? 'Tools and commands run without approval or a Codex sandbox.'
                : 'File changes are allowed; commands ask for approval.'}
          >
            <ShieldCheck aria-hidden="true" size={15} />
            <KodySelect
              value={permissionMode}
              variant="compact"
              ariaLabel="Permission mode"
              disabled={unavailable || running}
              ariaDescribedBy="permission-mode-description"
              options={PERMISSION_MODE_OPTIONS}
              onValueChange={(mode) => onPermissionModeChange(mode as PermissionMode)}
            />
          </div>
          <span id="permission-mode-description" className="sr-only">
            {permissionMode === 'read_only'
              ? 'Only inspection tools can run for this turn.'
              : permissionMode === 'full_access'
                ? 'Tools and commands run without approval or a Codex sandbox.'
                : 'File changes are allowed; commands ask for approval.'}
          </span>
          {draft && workingDirectory ? (
            <div className="working-directory-chip" title={workingDirectory}>
              <FolderOpen aria-hidden="true" size={15} />
              <span>{workingDirectory}</span>
              <button
                type="button"
                onClick={onClearWorkingDirectory}
                aria-label="Clear working directory"
              >
                <X aria-hidden="true" size={13} />
              </button>
            </div>
          ) : draft ? (
            <button
              className="context-button"
              type="button"
              disabled={unavailable || running}
              onClick={() => void onPickWorkingDirectory?.()}
            >
              <FolderOpen aria-hidden="true" size={16} />
              <span>Working directory</span>
            </button>
          ) : null}
          <span id="composer-hint" className="composer__hint">
            {draft
              ? <>Your first message creates the Thread · <kbd>Enter</kbd> send</>
              : <>References attach here and remain active later · <kbd>Enter</kbd> send</>}
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
            disabled={unavailable || submitting || !providerId || !model}
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
