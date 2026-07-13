import { CircleAlert, KeyRound, Plus, ShieldCheck, Trash2, UserRoundCheck, X } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'

import './provider-settings.css'

export type ProviderKind = 'openai' | 'openai-compatible'

export interface ProviderProfileView {
  id: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  defaultModel: string
  customModels: string[]
  hasSecret: boolean
  updatedAt?: string
}

export interface ProviderProfileSubmission {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl?: string
  defaultModel: string
  customModels: string[]
  /** Write-only; callers must not reflect this value back into renderer state. */
  secret?: string
  clearSecret?: boolean
}

export interface CredentialStorageView {
  available: boolean
  backend?: string
  reason?: string
}

export interface CodexAccountView {
  state: 'signed-out' | 'signed-in' | 'expired' | 'unavailable'
  accountLabel?: string
  detail?: string
}

export interface ProviderSettingsProps {
  open: boolean
  profiles: ProviderProfileView[]
  credentialStorage: CredentialStorageView
  codexAccount: CodexAccountView
  onClose: () => void
  onSave: (profile: ProviderProfileSubmission) => Promise<void>
  onDelete: (profileId: string) => Promise<void>
  onConnectCodexAccount?: () => Promise<void>
  onDisconnectCodexAccount?: () => Promise<void>
}

interface ProfileDraft {
  name: string
  kind: ProviderKind
  baseUrl: string
  defaultModel: string
  customModels: string
}

type DraftErrors = Partial<Record<keyof ProfileDraft | 'form', string>>

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const EMPTY_DRAFT: ProfileDraft = {
  name: '',
  kind: 'openai',
  baseUrl: '',
  defaultModel: '',
  customModels: ''
}

export function ProviderSettingsDialog({
  open,
  profiles,
  credentialStorage,
  codexAccount,
  onClose,
  onSave,
  onDelete,
  onConnectCodexAccount,
  onDisconnectCodexAccount
}: ProviderSettingsProps) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [selectedId, setSelectedId] = useState<string>('new')
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT)
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedId),
    [profiles, selectedId]
  )

  useEffect(() => {
    if (!open) return
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      returnFocus?.focus()
    }
  }, [open])

  useEffect(() => {
    if (selectedId !== 'new' && !profiles.some((profile) => profile.id === selectedId)) {
      setSelectedId('new')
    }
  }, [profiles, selectedId])

  useEffect(() => {
    setDraft(selectedProfile ? draftFromProfile(selectedProfile) : EMPTY_DRAFT)
    setSecret('')
    setClearSecret(false)
    setErrors({})
    setDeletePending(false)
  }, [selectedId, selectedProfile?.updatedAt])

  if (!open) return null

  const selectProfile = (profileId: string) => {
    setSelectedId(profileId)
    window.requestAnimationFrame(() => nameRef.current?.focus())
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    const nextErrors = validateDraft(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      window.requestAnimationFrame(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus()
      })
      return
    }
    const submittedSecret = secret
    // Secrets are write-only and leave component state before any async work.
    setSecret('')
    setSubmitting(true)
    try {
      await onSave({
        ...(selectedProfile ? { id: selectedProfile.id } : {}),
        name: draft.name.trim(),
        kind: draft.kind,
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        defaultModel: draft.defaultModel.trim(),
        customModels: parseCustomModels(draft.customModels),
        ...(submittedSecret ? { secret: submittedSecret } : {}),
        ...(clearSecret ? { clearSecret: true } : {})
      })
      setClearSecret(false)
      setErrors({})
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : 'Provider profile could not be saved.' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const validateField = (field: keyof ProfileDraft) => {
    const message = validateDraft(draft)[field]
    setErrors((current) => ({ ...current, [field]: message }))
  }

  const deleteSelectedProfile = async () => {
    if (!selectedProfile || deleting) return
    setDeleting(true)
    try {
      await onDelete(selectedProfile.id)
      setSelectedId('new')
      setErrors({})
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : 'Provider profile could not be deleted.' })
    } finally {
      setDeleting(false)
      setDeletePending(false)
    }
  }

  return (
    <div className="provider-settings-backdrop" data-testid="provider-settings-backdrop">
      <dialog
        ref={dialogRef}
        open
        className="provider-settings"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onKeyDown={handleKeyDown}
      >
        <header className="provider-settings__header">
          <div>
            <p className="eyebrow">Model connections</p>
            <h2 id={`${id}-title`}>Provider settings</h2>
            <p id={`${id}-description`}>Configure reusable provider profiles without exposing saved credentials.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close provider settings" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="provider-settings__body">
          <nav className="provider-profile-nav" aria-label="Provider profiles">
            <button
              type="button"
              className="provider-profile-add"
              aria-current={selectedId === 'new' ? 'page' : undefined}
              onClick={() => selectProfile('new')}
            >
              <Plus aria-hidden="true" size={16} />
              Add provider
            </button>
            {profiles.length === 0 ? <p>No saved provider profiles.</p> : null}
            <ul>
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <button
                    type="button"
                    aria-current={profile.id === selectedId ? 'page' : undefined}
                    onClick={() => selectProfile(profile.id)}
                  >
                    <span>{profile.name}</span>
                    <small>{kindLabel(profile.kind)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="provider-settings__content">
            <CodexAccountStatus
              titleId={`${id}-codex-account-title`}
              account={codexAccount}
              onConnect={onConnectCodexAccount}
              onDisconnect={onDisconnectCodexAccount}
            />

            {!credentialStorage.available ? (
              <div className="provider-storage-warning" role="alert">
                <CircleAlert aria-hidden="true" size={17} />
                <div>
                  <strong>Credential storage unavailable</strong>
                  <p>{credentialStorage.reason ?? 'Secure operating-system storage is unavailable. API keys cannot be saved.'}</p>
                </div>
              </div>
            ) : null}

            <form className="provider-profile-form" noValidate onSubmit={submit}>
              <div className="provider-profile-form__heading">
                <div>
                  <p className="eyebrow">{selectedProfile ? 'Edit profile' : 'New profile'}</p>
                  <h3>{selectedProfile?.name ?? 'Connection details'}</h3>
                </div>
                {selectedProfile ? (
                  <button type="button" className="provider-danger-button" onClick={() => setDeletePending(true)}>
                    <Trash2 aria-hidden="true" size={15} /> Delete
                  </button>
                ) : null}
              </div>

              {deletePending && selectedProfile ? (
                <div className="provider-delete-confirmation" role="alert">
                  <p>Delete “{selectedProfile.name}”? Threads using it will need another provider.</p>
                  <div>
                    <button
                      type="button"
                      className="provider-danger-button"
                      aria-busy={deleting}
                      onClick={() => void deleteSelectedProfile()}
                    >
                      {deleting ? 'Deleting…' : 'Delete profile'}
                    </button>
                    <button type="button" className="provider-secondary-button" onClick={() => setDeletePending(false)}>
                      Keep profile
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="provider-form-grid">
                <Field label="Profile name" required error={errors.name} id={`${id}-name`}>
                  <input
                    ref={nameRef}
                    id={`${id}-name`}
                    name="provider-name"
                    value={draft.name}
                    required
                    maxLength={100}
                    autoComplete="off"
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? `${id}-name-error` : undefined}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    onBlur={() => validateField('name')}
                  />
                </Field>

                <Field label="Provider kind" required error={errors.kind} id={`${id}-kind`}>
                  <select
                    id={`${id}-kind`}
                    name="provider-kind"
                    value={draft.kind}
                    required
                    aria-invalid={Boolean(errors.kind)}
                    onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as ProviderKind }))}
                  >
                    <option value="openai">OpenAI API</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                  </select>
                </Field>
              </div>

              <Field
                label="Base URL"
                required={draft.kind === 'openai-compatible'}
                error={errors.baseUrl}
                hint="HTTPS is required except for exact local loopback hosts. Credentials, queries, and fragments are rejected."
                id={`${id}-base-url`}
              >
                <input
                  id={`${id}-base-url`}
                  name="base-url"
                  type="url"
                  inputMode="url"
                  value={draft.baseUrl}
                  required={draft.kind === 'openai-compatible'}
                  placeholder="https://api.example.com/v1"
                  maxLength={2048}
                  autoComplete="url"
                  aria-invalid={Boolean(errors.baseUrl)}
                  aria-describedby={`${id}-base-url-hint${errors.baseUrl ? ` ${id}-base-url-error` : ''}`}
                  onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  onBlur={() => validateField('baseUrl')}
                />
              </Field>

              <div className="provider-form-grid">
                <Field label="Default model" required error={errors.defaultModel} id={`${id}-default-model`}>
                  <input
                    id={`${id}-default-model`}
                    name="default-model"
                    value={draft.defaultModel}
                    required
                    maxLength={200}
                    autoComplete="off"
                    placeholder="Model used for new Threads"
                    aria-invalid={Boolean(errors.defaultModel)}
                    aria-describedby={errors.defaultModel ? `${id}-default-model-error` : undefined}
                    onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}
                    onBlur={() => validateField('defaultModel')}
                  />
                </Field>

                <Field
                  label="Custom models"
                  error={errors.customModels}
                  hint="Optional. Separate model names with commas or new lines."
                  id={`${id}-custom-models`}
                >
                  <textarea
                    id={`${id}-custom-models`}
                    name="custom-models"
                    rows={2}
                    value={draft.customModels}
                    maxLength={10_000}
                    spellCheck={false}
                    aria-invalid={Boolean(errors.customModels)}
                    aria-describedby={`${id}-custom-models-hint${errors.customModels ? ` ${id}-custom-models-error` : ''}`}
                    onChange={(event) => setDraft((current) => ({ ...current, customModels: event.target.value }))}
                    onBlur={() => validateField('customModels')}
                  />
                </Field>
              </div>

              <fieldset className="provider-secret-fieldset">
                  <legend>Credential</legend>
                  <div className="provider-secret-field">
                    <KeyRound aria-hidden="true" size={17} />
                    <div>
                      <label htmlFor={`${id}-secret`}>API key</label>
                      <p id={`${id}-secret-hint`}>
                        {selectedProfile?.hasSecret && !clearSecret
                          ? 'A credential is saved. Enter a new key only to replace it.'
                          : 'The key is encrypted by the operating system and is never displayed again.'}
                      </p>
                    </div>
                    <input
                      id={`${id}-secret`}
                      name="provider-secret"
                      type="password"
                      value={secret}
                      disabled={!credentialStorage.available}
                      autoComplete="new-password"
                      spellCheck={false}
                      aria-describedby={`${id}-secret-hint`}
                      onChange={(event) => {
                        setSecret(event.target.value)
                        if (event.target.value) setClearSecret(false)
                      }}
                    />
                  </div>
                  {selectedProfile?.hasSecret ? (
                    <button
                      type="button"
                      className="provider-link-button"
                      aria-pressed={clearSecret}
                      onClick={() => {
                        setClearSecret((current) => !current)
                        setSecret('')
                      }}
                    >
                      {clearSecret ? 'Keep saved credential' : 'Remove saved credential on save'}
                    </button>
                  ) : null}
              </fieldset>

              {errors.form ? <p className="provider-form-error" role="alert">{errors.form}</p> : null}

              <footer className="provider-profile-form__actions">
                <button type="button" className="provider-secondary-button" onClick={onClose}>Cancel</button>
                <button type="submit" className="provider-primary-button" aria-busy={submitting}>
                  {submitting ? 'Saving…' : 'Save provider'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      </dialog>
    </div>
  )
}

function Field({
  label,
  id,
  required = false,
  hint,
  error,
  children
}: {
  label: string
  id: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="provider-field" data-state={error ? 'error' : undefined}>
      <label htmlFor={id}>
        {label}
        {required ? <><span aria-hidden="true"> *</span><span className="sr-only"> (required)</span></> : null}
      </label>
      {children}
      {hint ? <p className="provider-field__hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="provider-field__error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  )
}

function CodexAccountStatus({
  titleId,
  account,
  onConnect,
  onDisconnect
}: {
  titleId: string
  account: CodexAccountView
  onConnect?: () => Promise<void>
  onDisconnect?: () => Promise<void>
}) {
  const signedIn = account.state === 'signed-in'
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const runAction = async (action: (() => Promise<void>) | undefined) => {
    if (!action || actionPending) return
    setActionPending(true)
    setActionError(undefined)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Codex account action failed.')
    } finally {
      setActionPending(false)
    }
  }
  return (
    <section className="codex-account-status" aria-labelledby={titleId}>
      <span className={`codex-account-status__icon codex-account-status__icon--${account.state}`}>
        {signedIn ? <UserRoundCheck aria-hidden="true" size={18} /> : <ShieldCheck aria-hidden="true" size={18} />}
      </span>
      <div>
        <h3 id={titleId}>Codex account</h3>
        <p role="status" aria-live="polite">
          <strong>{accountStateLabel(account.state)}</strong>
          {account.accountLabel ? ` · ${account.accountLabel}` : ''}
        </p>
        {account.detail ? <small>{account.detail}</small> : null}
      </div>
      {signedIn && onDisconnect ? (
        <button
          type="button"
          className="provider-secondary-button"
          aria-busy={actionPending}
          onClick={() => void runAction(onDisconnect)}
        >
          {actionPending ? 'Signing out…' : 'Sign out'}
        </button>
      ) : !signedIn && account.state !== 'unavailable' && onConnect ? (
        <button
          type="button"
          className="provider-secondary-button"
          aria-busy={actionPending}
          onClick={() => void runAction(onConnect)}
        >
          {actionPending ? 'Signing in…' : 'Sign in'}
        </button>
      ) : null}
      {actionError ? <p className="codex-account-status__error" role="alert">{actionError}</p> : null}
    </section>
  )
}

function draftFromProfile(profile: ProviderProfileView): ProfileDraft {
  return {
    name: profile.name,
    kind: profile.kind,
    baseUrl: profile.baseUrl ?? '',
    defaultModel: profile.defaultModel,
    customModels: profile.customModels.join('\n')
  }
}

function validateDraft(draft: ProfileDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) errors.name = 'Enter a profile name.'
  if (!draft.defaultModel.trim()) errors.defaultModel = 'Enter a default model.'
  const baseUrl = draft.baseUrl.trim()
  if (draft.kind === 'openai-compatible' && !baseUrl) {
    errors.baseUrl = 'Enter the gateway base URL.'
  } else if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.baseUrl = 'Use an HTTP or HTTPS URL.'
      } else if (url.username || url.password) {
        errors.baseUrl = 'Remove credentials from the URL.'
      } else if (url.search || url.hash) {
        errors.baseUrl = 'Remove query strings and fragments from the Base URL.'
      } else if (url.protocol === 'http:' && !LOOPBACK_HTTP_HOSTS.has(url.hostname)) {
        errors.baseUrl = 'Use HTTPS unless the host is exactly localhost, 127.0.0.1, or [::1].'
      }
    } catch {
      errors.baseUrl = 'Enter a valid URL, such as https://api.example.com/v1.'
    }
  }
  const customModels = parseCustomModels(draft.customModels)
  if (customModels.length > 200) {
    errors.customModels = 'Save no more than 200 custom model names.'
  } else if (customModels.some((model) => model.length > 200)) {
    errors.customModels = 'Each custom model name must be 200 characters or fewer.'
  }
  return errors
}

function parseCustomModels(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
}

function kindLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'openai': return 'OpenAI API'
    case 'openai-compatible': return 'OpenAI-compatible'
  }
}

function accountStateLabel(state: CodexAccountView['state']): string {
  switch (state) {
    case 'signed-in': return 'Signed in'
    case 'signed-out': return 'Not signed in'
    case 'expired': return 'Session expired'
    case 'unavailable': return 'Unavailable'
  }
}
