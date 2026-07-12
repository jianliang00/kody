import {
  AlertTriangle,
  FolderPlus,
  LoaderCircle,
  MessageCirclePlus,
  PanelLeftOpen,
  RefreshCcw,
  WifiOff
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodyDesktopBridge } from '@shared/bridge'
import type {
  ChatMessage,
  ContextReference,
  EventEnvelope,
  Project,
  ServerStatus,
  Thread,
  ThreadSnapshot,
  Turn
} from '@shared/protocol'
import { AssetRail } from './components/AssetRail'
import { Composer } from './components/Composer'
import { Conversation } from './components/Conversation'
import { CreateThreadDialog } from './components/CreateThreadDialog'
import { Inspector } from './components/Inspector'
import { TitleBar } from './components/TitleBar'
import { getCodyBridge } from './lib/mockBridge'
import { referenceKey, upsertReference } from './lib/references'

type ExtendedBridge = CodyDesktopBridge & { copyText?: (text: string) => Promise<void> }

const TERMINAL_EVENTS = new Set(['turn_completed', 'turn_failed', 'turn_cancelled'])

function appendLiveEvent(history: EventEnvelope[], envelope: EventEnvelope): EventEnvelope[] {
  const last = history.at(-1)
  if (
    last?.turn_id === envelope.turn_id
    && last.event.type === 'model_output_delta'
    && envelope.event.type === 'model_output_delta'
  ) {
    const merged: EventEnvelope = {
      ...envelope,
      event: { type: 'model_output_delta', delta: last.event.delta + envelope.event.delta }
    }
    return [
      ...history.slice(0, -1),
      merged
    ].slice(-200)
  }
  if (
    last?.turn_id === envelope.turn_id
    && last.event.type === 'model_reasoning_delta'
    && envelope.event.type === 'model_reasoning_delta'
  ) {
    const merged: EventEnvelope = {
      ...envelope,
      event: { type: 'model_reasoning_delta', delta: last.event.delta + envelope.event.delta }
    }
    return [
      ...history.slice(0, -1),
      merged
    ].slice(-200)
  }
  return [...history, envelope].slice(-200)
}

function initialTheme(): boolean {
  const saved = window.localStorage.getItem('cody.theme')
  if (saved === 'dark') return true
  if (saved === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function runningTurn(snapshot?: ThreadSnapshot): Turn | undefined {
  return snapshot?.turns.findLast((turn) => turn.status === 'running' || turn.status === 'queued')
}

function optimisticMessage(
  threadId: string,
  turn: Turn,
  message: string,
  references: ContextReference[]
): ChatMessage {
  return {
    id: turn.input_message_id,
    thread_id: threadId,
    turn_id: turn.id,
    role: 'user',
    parts: [{ type: 'text', text: message }],
    references,
    created_at: turn.created_at
  }
}

export function App() {
  const bridge = useMemo(() => getCodyBridge(), [])
  const [status, setStatus] = useState<ServerStatus>({ phase: 'starting', detail: 'Starting local server…' })
  const [threads, setThreads] = useState<Thread[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [providers, setProviders] = useState<string[]>([])
  const [provider, setProvider] = useState('')
  const [activeThreadId, setActiveThreadId] = useState<string>()
  const [snapshot, setSnapshot] = useState<ThreadSnapshot>()
  const [draftReferences, setDraftReferences] = useState<ContextReference[]>([])
  const [eventsByThread, setEventsByThread] = useState<Record<string, EventEnvelope[]>>({})
  const [runningTurns, setRunningTurns] = useState<Record<string, string>>({})
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(new Set())
  const [loadingThread, setLoadingThread] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [appError, setAppError] = useState('')
  const [announcement, setAnnouncement] = useState('Starting Cody')
  const [createOpen, setCreateOpen] = useState(false)
  const [createDirectory, setCreateDirectory] = useState<string>()
  const [railOpen, setRailOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(
    () => window.localStorage.getItem('cody.railCollapsed') === 'true'
  )
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(
    () => window.localStorage.getItem('cody.inspectorCollapsed') === 'true'
  )
  const [darkTheme, setDarkTheme] = useState(initialTheme)

  const activeThreadRef = useRef<string | undefined>(undefined)
  const loadRequestRef = useRef(0)
  const lastSequenceRef = useRef(new Map<string, number>())
  const startTurnRef = useRef(false)
  const cancelTurnRef = useRef(false)
  const approvalRef = useRef(new Set<string>())
  const statusRef = useRef<ServerStatus['phase']>('starting')

  const applySnapshot = useCallback((nextSnapshot: ThreadSnapshot): void => {
    if (activeThreadRef.current !== nextSnapshot.thread.id) return
    setSnapshot(nextSnapshot)
    setThreads((current) => current.map((thread) =>
      thread.id === nextSnapshot.thread.id ? nextSnapshot.thread : thread
    ))
    const activeTurn = runningTurn(nextSnapshot)
    setRunningTurns((current) => {
      const next = { ...current }
      if (activeTurn) next[nextSnapshot.thread.id] = activeTurn.id
      else delete next[nextSnapshot.thread.id]
      return next
    })
  }, [])

  const refreshThread = useCallback(async (threadId: string): Promise<void> => {
    try {
      const [nextSnapshot, threadResult] = await Promise.all([
        bridge.rpc('thread/get', { thread_id: threadId }),
        bridge.rpc('thread/list', {})
      ])
      setThreads(threadResult.threads)
      applySnapshot(nextSnapshot)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not refresh the Thread.')
    }
  }, [applySnapshot, bridge])

  const selectThread = useCallback(async (threadId: string): Promise<void> => {
    const request = ++loadRequestRef.current
    activeThreadRef.current = threadId
    setActiveThreadId(threadId)
    setDraftReferences([])
    setLoadingThread(true)
    setAppError('')
    window.localStorage.setItem('cody.activeThreadId', threadId)
    try {
      const nextSnapshot = await bridge.rpc('thread/get', { thread_id: threadId })
      if (request !== loadRequestRef.current || activeThreadRef.current !== threadId) return
      applySnapshot(nextSnapshot)
      setAnnouncement(`Opened ${nextSnapshot.thread.title}`)
    } catch (error) {
      if (request !== loadRequestRef.current) return
      setSnapshot(undefined)
      setAppError(error instanceof Error ? error.message : 'Could not load this Thread.')
    } finally {
      if (request === loadRequestRef.current) setLoadingThread(false)
    }
  }, [applySnapshot, bridge])

  const bootstrap = useCallback(async (): Promise<void> => {
    setBootstrapping(true)
    setAppError('')
    try {
      const nextStatus = await bridge.getServerStatus()
      statusRef.current = nextStatus.phase
      setStatus(nextStatus)
      if (nextStatus.phase !== 'connected') {
        setBootstrapping(false)
        return
      }
      await bridge.rpc('initialize', {})
      const [threadResult, projectResult, providerResult] = await Promise.all([
        bridge.rpc('thread/list', {}),
        bridge.rpc('project/list', {}),
        bridge.rpc('provider/list', {})
      ])
      setThreads(threadResult.threads)
      setProjects(projectResult.projects)
      setProviders(providerResult.providers)
      setProvider((current) =>
        current && providerResult.providers.includes(current)
          ? current
          : providerResult.providers[0] ?? ''
      )

      const persistedId = window.localStorage.getItem('cody.activeThreadId') ?? undefined
      const preferredId = activeThreadRef.current && threadResult.threads.some((thread) => thread.id === activeThreadRef.current)
        ? activeThreadRef.current
        : threadResult.threads.some((thread) => thread.id === persistedId)
          ? persistedId
          : threadResult.threads[0]?.id
      if (preferredId) await selectThread(preferredId)
      else {
        activeThreadRef.current = undefined
        setActiveThreadId(undefined)
        setSnapshot(undefined)
      }
      setAnnouncement('Cody is connected and ready')
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Cody could not connect to the local server.'
      statusRef.current = 'error'
      setStatus({ phase: 'error', detail })
      setAppError(detail)
    } finally {
      setBootstrapping(false)
    }
  }, [bridge, selectThread])

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? 'dark' : 'light'
    window.localStorage.setItem('cody.theme', darkTheme ? 'dark' : 'light')
  }, [darkTheme])

  useEffect(() => {
    window.localStorage.setItem('cody.railCollapsed', String(railCollapsed))
  }, [railCollapsed])

  useEffect(() => {
    window.localStorage.setItem('cody.inspectorCollapsed', String(inspectorCollapsed))
  }, [inspectorCollapsed])

  useEffect(() => {
    if (!railOpen && !inspectorOpen) return
    const closeDrawer = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setRailOpen(false)
      setInspectorOpen(false)
    }
    window.addEventListener('keydown', closeDrawer)
    return () => window.removeEventListener('keydown', closeDrawer)
  }, [inspectorOpen, railOpen])

  useEffect(() => {
    const railIsDrawer = railOpen && window.matchMedia('(max-width: 48rem)').matches
    const inspectorIsDrawer = inspectorOpen && window.matchMedia('(max-width: 72rem)').matches
    if (!railIsDrawer && !inspectorIsDrawer) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const drawer = document.querySelector<HTMLElement>(railIsDrawer ? '.asset-rail' : '.inspector')
    if (!drawer) return
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary'
    const focusables = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
    focusables[0]?.focus()
    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || focusables.length === 0) return
      const first = focusables[0]
      const last = focusables.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    drawer.addEventListener('keydown', trapFocus)
    return () => {
      drawer.removeEventListener('keydown', trapFocus)
      previousFocus?.focus()
    }
  }, [inspectorOpen, railOpen])

  useEffect(() => {
    const removeEventListener = bridge.onEvent((envelope) => {
      const previousSequence = lastSequenceRef.current.get(envelope.turn_id)
      if (previousSequence !== undefined && envelope.sequence <= previousSequence) return
      if (previousSequence !== undefined && envelope.sequence !== previousSequence + 1) {
        setAnnouncement('Activity gap detected. Refreshing durable Thread history.')
        void refreshThread(envelope.thread_id)
      }
      lastSequenceRef.current.set(envelope.turn_id, envelope.sequence)
      setEventsByThread((current) => ({
        ...current,
        [envelope.thread_id]: appendLiveEvent(current[envelope.thread_id] ?? [], envelope)
      }))

      if (envelope.event.type === 'turn_started') {
        setRunningTurns((current) => ({ ...current, [envelope.thread_id]: envelope.turn_id }))
        setAnnouncement('Cody started working')
      } else if (envelope.event.type === 'approval_requested') {
        setAnnouncement(`Approval required for ${envelope.event.name}`)
        void refreshThread(envelope.thread_id)
      } else if (envelope.event.type === 'file_changed') {
        setAnnouncement(`Changed ${envelope.event.path}`)
      } else if (TERMINAL_EVENTS.has(envelope.event.type)) {
        setRunningTurns((current) => {
          const next = { ...current }
          delete next[envelope.thread_id]
          return next
        })
        setAnnouncement(
          envelope.event.type === 'turn_completed'
            ? 'Turn completed'
            : envelope.event.type === 'turn_cancelled'
              ? 'Turn cancelled'
              : 'Turn failed'
        )
        void refreshThread(envelope.thread_id)
      }
    })

    const removeStatusListener = bridge.onServerStatus((nextStatus) => {
      const previous = statusRef.current
      statusRef.current = nextStatus.phase
      setStatus(nextStatus)
      if (nextStatus.phase === 'connected' && (previous !== 'connected' || nextStatus.reconcile)) {
        setAnnouncement(
          nextStatus.reconcile
            ? 'Live activity was interrupted. Refreshing durable history.'
            : 'Server reconnected. Refreshing durable history.'
        )
        void bootstrap()
      } else if (nextStatus.phase !== 'connected') {
        setAnnouncement(`Server ${nextStatus.phase}`)
      }
    })

    void bootstrap()
    return () => {
      removeEventListener()
      removeStatusListener()
    }
  }, [bootstrap, bridge, refreshThread])

  const activeEvents = activeThreadId ? eventsByThread[activeThreadId] ?? [] : []
  const activeRunningTurnId = activeThreadId
    ? runningTurns[activeThreadId] ?? runningTurn(snapshot)?.id
    : undefined
  const conversationTurnId = activeRunningTurnId ?? activeEvents.at(-1)?.turn_id
  const conversationEvents = conversationTurnId
    ? activeEvents.filter((event) => event.turn_id === conversationTurnId)
    : []
  const isRunning = Boolean(activeRunningTurnId)

  const handleCreateThread = async (title: string, directory?: string): Promise<boolean> => {
    try {
      const created = await bridge.rpc('thread/create', {
        title,
        working_directory: directory
      })
      if (created.imported_project) {
        setProjects((current) => [
          created.imported_project as Project,
          ...current.filter((project) => project.id !== created.imported_project?.id)
        ])
      }
      setThreads((current) => [created.thread, ...current.filter((thread) => thread.id !== created.thread.id)])
      activeThreadRef.current = created.thread.id
      setActiveThreadId(created.thread.id)
      setSnapshot({
        thread: created.thread,
        workspace: created.workspace,
        messages: [],
        turns: [],
        pending_approvals: []
      })
      setDraftReferences([])
      window.localStorage.setItem('cody.activeThreadId', created.thread.id)
      setAnnouncement(`Created ${created.thread.title}`)
      setCreateDirectory(undefined)
      return true
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not create the Thread.')
      return false
    }
  }

  const handleImportProject = async (): Promise<void> => {
    try {
      const path = await bridge.pickDirectory()
      if (!path) return
      const imported = await bridge.rpc('project/import', { path })
      setProjects((current) => [imported, ...current.filter((project) => project.id !== imported.id)])
      setAnnouncement(`Imported Project ${imported.name}`)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not import the Project.')
    }
  }

  const addProjectContext = (project: Project): void => {
    if (!snapshot) {
      setCreateDirectory(project.root)
      setCreateOpen(true)
      return
    }
    const reference: ContextReference = {
      kind: 'project',
      project_id: project.id,
      access: 'read_only'
    }
    if (draftReferences.some((item) => referenceKey(item) === referenceKey(reference))) {
      setAnnouncement(`${project.name} is already pending in context`)
      return
    }
    setDraftReferences((current) => upsertReference(current, reference))
    setAnnouncement(`Added ${project.name} as read-only context`)
  }

  const handleStartTurn = async (
    message: string,
    references: ContextReference[]
  ): Promise<boolean> => {
    if (!snapshot || !provider || startTurnRef.current || isRunning) return false
    startTurnRef.current = true
    setAppError('')
    try {
      const turn = await bridge.rpc('turn/start', {
        thread_id: snapshot.thread.id,
        message,
        references,
        provider
      })
      setRunningTurns((current) => ({ ...current, [snapshot.thread.id]: turn.id }))
      setSnapshot((current) => {
        if (!current || current.thread.id !== snapshot.thread.id) return current
        return {
          ...current,
          thread: { ...current.thread, status: 'running', updated_at: turn.created_at },
          messages: [...current.messages, optimisticMessage(snapshot.thread.id, turn, message, references)],
          turns: [...current.turns.filter((item) => item.id !== turn.id), turn]
        }
      })
      setAnnouncement('Message sent. Cody is starting the turn.')
      void refreshThread(snapshot.thread.id)
      return true
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not start the Turn.')
      return false
    } finally {
      startTurnRef.current = false
    }
  }

  const handleCancelTurn = async (): Promise<void> => {
    if (!activeRunningTurnId || cancelTurnRef.current) return
    cancelTurnRef.current = true
    try {
      await bridge.rpc('turn/cancel', { turn_id: activeRunningTurnId })
      setAnnouncement('Stopping the current Turn…')
      if (activeThreadId) void refreshThread(activeThreadId)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not stop the Turn.')
    } finally {
      cancelTurnRef.current = false
    }
  }

  const handleApproval = async (approvalId: string, approved: boolean): Promise<void> => {
    if (approvalRef.current.has(approvalId)) return
    approvalRef.current.add(approvalId)
    setResolvingApprovals((current) => new Set(current).add(approvalId))
    try {
      const result = await bridge.rpc('approval/respond', { approval_id: approvalId, approved })
      if (!result.resolved) throw new Error('This approval was already resolved.')
      setAnnouncement(approved ? 'Shell access allowed once' : 'Shell access denied')
      if (activeThreadRef.current) void refreshThread(activeThreadRef.current)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not respond to approval.')
      approvalRef.current.delete(approvalId)
    } finally {
      setResolvingApprovals((current) => {
        const next = new Set(current)
        next.delete(approvalId)
        return next
      })
    }
  }

  const copyText = async (text: string): Promise<void> => {
    const extendedBridge = bridge as ExtendedBridge
    if (extendedBridge.copyText) {
      await extendedBridge.copyText(text)
      setAnnouncement('Workspace path copied')
      return
    }
    if (import.meta.env.DEV && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      setAnnouncement('Workspace path copied')
      return
    }
    setAppError('Clipboard access is unavailable.')
    throw new Error('Clipboard access is unavailable.')
  }

  useEffect(() => bridge.onCommand((command) => {
    if (command === 'new-thread') {
      setCreateDirectory(undefined)
      setCreateOpen(true)
      return
    }
    if (command === 'import-project') {
      void handleImportProject()
      return
    }
    if (command === 'focus-assets') {
      setRailCollapsed(false)
      if (window.matchMedia('(max-width: 48rem)').matches) setRailOpen(true)
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#asset-filter')?.focus())
      return
    }
    if (command === 'toggle-rail') {
      if (window.matchMedia('(max-width: 48rem)').matches) setRailOpen((current) => !current)
      else setRailCollapsed((current) => !current)
      return
    }
    if (window.matchMedia('(max-width: 72rem)').matches) {
      setInspectorOpen((current) => !current)
    } else {
      setInspectorCollapsed((current) => !current)
    }
  }), [bridge])

  const emptyDisconnected = status.phase !== 'connected' && !snapshot

  return (
    <div className={`app-shell${railCollapsed ? ' app-shell--rail-collapsed' : ''}${inspectorCollapsed ? ' app-shell--inspector-collapsed' : ''}${snapshot ? '' : ' app-shell--no-inspector'}${bridge.platform === 'darwin' ? ' app-shell--darwin' : ''}`}>
      <a className="skip-link" href="#main-content">Skip to conversation</a>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <AssetRail
        threads={threads}
        projects={projects}
        activeThreadId={activeThreadId}
        status={status}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        onCollapse={() => setRailCollapsed(true)}
        onNewThread={() => {
          setCreateDirectory(undefined)
          setCreateOpen(true)
        }}
        onImportProject={() => void handleImportProject()}
        onSelectThread={(threadId) => void selectThread(threadId)}
        onAddProject={addProjectContext}
      />

      {(railOpen || inspectorOpen) ? (
        <button
          className="drawer-scrim"
          type="button"
          onClick={() => {
            setRailOpen(false)
            setInspectorOpen(false)
          }}
          aria-label="Close open drawer"
        />
      ) : null}

      <section className="conversation-workspace">
        <TitleBar
          thread={snapshot?.thread}
          status={status}
          platform={bridge.platform}
          darkTheme={darkTheme}
          railCollapsed={railCollapsed}
          onOpenRail={() => {
            setRailCollapsed(false)
            setRailOpen(true)
          }}
          onOpenInspector={() => {
            if (window.matchMedia('(max-width: 72rem)').matches) setInspectorOpen(true)
            else setInspectorCollapsed(false)
          }}
          onRetry={() => void bootstrap()}
          onToggleTheme={() => setDarkTheme((current) => !current)}
          onWindowAction={(action) => void bridge.windowAction(action)}
        />

        {status.phase !== 'connected' && snapshot ? (
          <div className="connection-banner" role="status">
            <WifiOff aria-hidden="true" size={15} />
            <span><strong>Server {status.phase}.</strong> {status.detail || 'Live actions are paused.'}</span>
            <button type="button" onClick={() => void bootstrap()}><RefreshCcw aria-hidden="true" size={14} /> Retry</button>
          </div>
        ) : null}

        {appError ? (
          <div className="error-banner" role="alert">
            <AlertTriangle aria-hidden="true" size={15} />
            <span>{appError}</span>
            <button type="button" onClick={() => setAppError('')} aria-label="Dismiss error">Dismiss</button>
          </div>
        ) : null}

        <main id="main-content" className="conversation-main" tabIndex={-1}>
          {emptyDisconnected ? (
            <section className="connection-state">
              <span className="connection-state__icon"><WifiOff aria-hidden="true" size={24} /></span>
              <p className="eyebrow">Local agent server</p>
              <h2>{status.phase === 'error' ? 'Cody could not start' : 'Server disconnected'}</h2>
              <p>{status.detail || 'The desktop app cannot reach its local Cody server.'}</p>
              <button className="primary-button" type="button" onClick={() => void bootstrap()}>
                <RefreshCcw aria-hidden="true" size={15} /> Retry connection
              </button>
            </section>
          ) : bootstrapping && !snapshot ? (
            <section className="loading-state" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={23} />
              <h2>Opening Cody</h2>
              <p>Connecting to the local agent runtime…</p>
            </section>
          ) : threads.length === 0 && !snapshot ? (
            <section className="first-run">
              <div className="first-run__constellation" aria-hidden="true"><span /><span /><span /><strong>C</strong></div>
              <p className="eyebrow">A fresh Cody workspace</p>
              <h2>Start with a conversation or a code asset</h2>
              <p>
                Threads keep the durable working record. Projects stay reusable and can be mentioned from any Thread.
              </p>
              <div className="first-run__actions">
                <button className="start-card start-card--thread" type="button" onClick={() => setCreateOpen(true)}>
                  <MessageCirclePlus aria-hidden="true" size={20} />
                  <span><strong>Create a Thread</strong><small>Start without choosing a Project</small></span>
                </button>
                <button className="start-card start-card--project" type="button" onClick={() => void handleImportProject()}>
                  <FolderPlus aria-hidden="true" size={20} />
                  <span><strong>Import a Project</strong><small>Add a folder or Git repository</small></span>
                </button>
              </div>
            </section>
          ) : loadingThread && !snapshot ? (
            <section className="loading-state" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={23} />
              <h2>Loading Thread</h2>
            </section>
          ) : snapshot ? (
            <>
              <Conversation
                snapshot={snapshot}
                threads={threads}
                projects={projects}
                events={conversationEvents}
                pendingApprovals={snapshot.pending_approvals}
                running={isRunning}
                resolvingApprovals={resolvingApprovals}
                onApproval={handleApproval}
              />
              <div className="composer-dock">
                <Composer
                  key={snapshot.thread.id}
                  currentThreadId={snapshot.thread.id}
                  threads={threads}
                  projects={projects}
                  references={draftReferences}
                  providers={providers}
                  provider={provider}
                  running={isRunning}
                  unavailable={status.phase !== 'connected'}
                  onReferencesChange={setDraftReferences}
                  onProviderChange={setProvider}
                  onSend={handleStartTurn}
                  onCancel={handleCancelTurn}
                />
              </div>
            </>
          ) : (
            <section className="loading-state">
              <PanelLeftOpen aria-hidden="true" size={23} />
              <h2>Select a Thread</h2>
              <p>Choose a durable conversation from the asset rail.</p>
            </section>
          )}
          {loadingThread && snapshot ? <div className="thread-loading-overlay" role="status">Refreshing Thread…</div> : null}
        </main>
      </section>

      {snapshot ? (
        <Inspector
          snapshot={snapshot}
          threads={threads}
          projects={projects}
          draftReferences={draftReferences}
          events={activeEvents}
          open={inspectorOpen}
          onClose={() => {
            if (window.matchMedia('(max-width: 72rem)').matches) setInspectorOpen(false)
            else setInspectorCollapsed(true)
          }}
          onCopyText={copyText}
        />
      ) : null}

      <CreateThreadDialog
        open={createOpen}
        initialDirectory={createDirectory}
        onOpenChange={setCreateOpen}
        onPickDirectory={() => bridge.pickDirectory()}
        onCreate={handleCreateThread}
      />
    </div>
  )
}
