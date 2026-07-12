import * as Dialog from '@radix-ui/react-dialog'
import { FolderOpen, MessageCirclePlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface CreateThreadDialogProps {
  open: boolean
  initialDirectory?: string
  onOpenChange: (open: boolean) => void
  onPickDirectory: () => Promise<string | null>
  onCreate: (title: string, directory?: string) => Promise<boolean>
}

export function CreateThreadDialog({
  open,
  initialDirectory,
  onOpenChange,
  onPickDirectory,
  onCreate
}: CreateThreadDialogProps) {
  const [title, setTitle] = useState('')
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDirectory(initialDirectory ?? '')
    setError('')
  }, [open, initialDirectory])

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setError('Give this Thread a short, recognizable title.')
      return
    }
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setError('')
    try {
      const created = await onCreate(title.trim(), directory || undefined)
      if (created) onOpenChange(false)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="create-thread-description">
          <header className="dialog-header">
            <span className="dialog-glyph dialog-glyph--thread" aria-hidden="true">
              <MessageCirclePlus size={19} />
            </span>
            <div>
              <Dialog.Title>New Thread</Dialog.Title>
              <Dialog.Description id="create-thread-description">
                Start a durable conversation with its own temporary Workspace.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button" type="button" aria-label="Close new Thread dialog">
                <X aria-hidden="true" size={17} />
              </button>
            </Dialog.Close>
          </header>

          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label className="field" data-state={error ? 'error' : undefined}>
              <span>Thread title</span>
              <input
                type="text"
                value={title}
                autoFocus
                required
                aria-describedby={error ? 'thread-title-error' : undefined}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setTitle(event.target.value)
                  setError('')
                }}
              />
            </label>
            {error ? <p id="thread-title-error" className="field-error" role="alert">{error}</p> : null}

            <div className="field">
              <span id="working-folder-label">Working folder <small>Optional</small></span>
              <div className="folder-picker">
                <input
                  type="text"
                  value={directory}
                  readOnly
                  aria-labelledby="working-folder-label"
                  placeholder="No folder — create without a Project"
                />
                <button
                  className="secondary-button"
                  type="button"
                  onClick={async () => {
                    const path = await onPickDirectory()
                    if (path) setDirectory(path)
                  }}
                >
                  <FolderOpen aria-hidden="true" size={16} />
                  <span>Choose</span>
                </button>
              </div>
              <p className="field-hint">
                Every Thread gets a temporary Workspace. Choosing a folder also imports it as a Project and adds read/write default context.
              </p>
              {directory ? (
                <button className="text-button" type="button" onClick={() => setDirectory('')}>
                  Remove working folder
                </button>
              ) : null}
            </div>

            <footer className="dialog-actions">
              <Dialog.Close asChild>
                <button className="secondary-button" type="button">Cancel</button>
              </Dialog.Close>
              <button className="primary-button" type="submit">
                {creating ? 'Creating…' : 'Create Thread'}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
