import {
  AlertTriangle,
  LoaderCircle,
  RefreshCcw,
  WifiOff
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type {
  CodexAccountStatus,
  DesktopUpdateStatus,
  KodyDesktopBridge,
  ProviderProfileUpdate,
  ProviderSettingsResult
} from '@shared/bridge'
import type {
  ChatMessage,
  ContextReference,
  EventEnvelope,
  ModelDescriptor,
  PermissionMode,
  ProcessEventEnvelope,
  ProcessOutputPage,
  Project,
  ProviderDescriptor,
  ServerStatus,
  Thread,
  ThreadSnapshot,
  Turn,
  UserInputAnswers
} from '@shared/protocol'
import { AssetRail } from './components/AssetRail'
import { Composer } from './components/Composer'
import { Conversation } from './components/Conversation'
import { DraftConversation } from './components/DraftConversation'
import { Inspector } from './components/Inspector'
import { ProjectShelf } from './components/ProjectShelf'
import {
  ProviderSettingsDialog,
  type ProviderProfileSubmission
} from './components/ProviderSettings'
import { SidebarResizeHandle } from './components/SidebarResizeHandle'
import { ThreadContextCard } from './components/ThreadContextCard'
import { TitleBar } from './components/TitleBar'
import { getKodyBridge } from './lib/mockBridge'
import { referenceKey, upsertReference } from './lib/references'
import { isProcessActive, shouldRefreshProcessSnapshot } from './lib/processes'
import { deriveThreadContext } from './lib/threadContext'
import { ThreadProjectionLedger } from './lib/threadProjection'
import {
  ASSET_RAIL_LIMITS,
  clampSidebarWidth,
  fitSidebarWidths,
  MINIMUM_CONVERSATION_WIDTH,
  readStoredSidebarWidth,
  RIGHT_RAIL_LIMITS
} from './lib/sidebarSizing'

type ExtendedBridge = KodyDesktopBridge & { copyText?: (text: string) => Promise<void> }

const TERMINAL_EVENTS = new Set(['turn_completed', 'turn_failed', 'turn_cancelled'])
const ASSET_RAIL_WIDTH_KEY = 'kody.assetRailWidth'
const RIGHT_RAIL_WIDTH_KEY = 'kody.rightRailWidth'

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
  const saved = window.localStorage.getItem('kody.theme')
  if (saved === 'dark') return true
  if (saved === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = (): void => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return width
}

function runningTurn(snapshot?: ThreadSnapshot): Turn | undefined {
  return snapshot?.turns.findLast((turn) => turn.status === 'running' || turn.status === 'queued')
}

function withoutPendingApproval(snapshot: ThreadSnapshot, approvalId: string): ThreadSnapshot {
  if (!snapshot.pending_approvals.some((approval) => approval.approval_id === approvalId)) {
    return snapshot
  }
  return {
    ...snapshot,
    pending_approvals: snapshot.pending_approvals.filter(
      (approval) => approval.approval_id !== approvalId
    )
  }
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

interface ComposerDraftState {
  message: string
  references: ContextReference[]
  providerId: string
  model: string
  permissionMode: PermissionMode
}

const EMPTY_COMPOSER_DRAFT: ComposerDraftState = {
  message: '',
  references: [],
  providerId: '',
  model: '',
  permissionMode: 'ask'
}

export function App() {
  const bridge = useMemo(() => getKodyBridge(), [])
  const [status, setStatus] = useState<ServerStatus>({ phase: 'starting', detail: 'Starting local server…' })
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>({
    phase: 'disabled',
    currentVersion: ''
  })
  const [threads, setThreads] = useState<Thread[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [providers, setProviders] = useState<ProviderDescriptor[]>([])
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelDescriptor[]>>({})
  const [loadingModelProviders, setLoadingModelProviders] = useState<Set<string>>(new Set())
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false)
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsResult>({
    profiles: [],
    credentialStorage: { available: false, reason: 'Loading credential storage status…' }
  })
  const [codexAccount, setCodexAccount] = useState<CodexAccountStatus>({ state: 'signed-out' })
  const [activeThreadId, setActiveThreadId] = useState<string>()
  const [snapshot, setSnapshot] = useState<ThreadSnapshot>()
  const [composerDrafts, setComposerDrafts] = useState<Record<string, ComposerDraftState>>({})
  const [eventsByThread, setEventsByThread] = useState<Record<string, EventEnvelope[]>>({})
  const [runningTurns, setRunningTurns] = useState<Record<string, string>>({})
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(new Set())
  const [resolvingUserInputs, setResolvingUserInputs] = useState<Set<string>>(new Set())
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(new Set())
  const [processOutputCursors, setProcessOutputCursors] = useState<Record<string, number>>({})
  const [loadingThread, setLoadingThread] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [appError, setAppError] = useState('')
  const [announcement, setAnnouncement] = useState('Starting Kody')
  const [draftId, setDraftId] = useState(() => crypto.randomUUID())
  const [draftWorkingDirectory, setDraftWorkingDirectory] = useState<string>()
  const [railOpen, setRailOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(
    () => window.localStorage.getItem('kody.railCollapsed') === 'true'
  )
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorCollapsed, setInspectorCollapsed] = useState(
    () => window.localStorage.getItem('kody.inspectorCollapsed') !== 'false'
  )
  const [rightRailCollapsed, setRightRailCollapsed] = useState(
    () => window.localStorage.getItem('kody.rightRailCollapsed') === 'true'
  )
  const [assetRailWidth, setAssetRailWidth] = useState(
    () => readStoredSidebarWidth(window.localStorage, ASSET_RAIL_WIDTH_KEY, ASSET_RAIL_LIMITS)
  )
  const [rightRailWidth, setRightRailWidth] = useState(
    () => readStoredSidebarWidth(window.localStorage, RIGHT_RAIL_WIDTH_KEY, RIGHT_RAIL_LIMITS)
  )
  const [darkTheme, setDarkTheme] = useState(initialTheme)
  const [composerDockHeight, setComposerDockHeight] = useState(0)
  const inspectorIsNarrow = useMediaQuery('(max-width: 72rem)')
  const railIsNarrow = useMediaQuery('(max-width: 48rem)')
  const viewportWidth = useViewportWidth()

  const appShellRef = useRef<HTMLDivElement>(null)
  const activeThreadRef = useRef<string | undefined>(undefined)
  const draftIdRef = useRef(draftId)
  const loadRequestRef = useRef(0)
  const lastSequenceRef = useRef(new Map<string, number>())
  const threadRefreshRequestRef = useRef(new Map<string, number>())
  const threadProjectionRef = useRef(new ThreadProjectionLedger())
  const lastProcessSequenceRef = useRef(new Map<string, number>())
  const processRefreshTimersRef = useRef(new Map<string, number>())
  const processRefreshRequestRef = useRef(new Map<string, number>())
  const startTurnRef = useRef(false)
  const cancelTurnRef = useRef(false)
  const approvalRef = useRef(new Set<string>())
  const userInputRef = useRef(new Set<string>())
  const processStopRef = useRef(new Set<string>())
  const modelLoadRef = useRef(new Set<string>())
  const statusRef = useRef<ServerStatus['phase']>('starting')
  const hasHydratedRef = useRef(false)
  const preferDraftRef = useRef(false)
  const desktopAssetRailVisible = !railIsNarrow && !railCollapsed
  const desktopRightRailVisible = !inspectorIsNarrow && !rightRailCollapsed
  const fittedSidebarWidths = useMemo(() => fitSidebarWidths(
    viewportWidth,
    assetRailWidth,
    rightRailWidth,
    desktopAssetRailVisible,
    desktopRightRailVisible
  ), [
    assetRailWidth,
    desktopAssetRailVisible,
    desktopRightRailVisible,
    rightRailWidth,
    viewportWidth
  ])
  const assetRailResizeMax = Math.max(
    ASSET_RAIL_LIMITS.minWidth,
    Math.min(
      ASSET_RAIL_LIMITS.maxWidth,
      viewportWidth
        - MINIMUM_CONVERSATION_WIDTH
        - (desktopRightRailVisible ? fittedSidebarWidths.right : 0)
    )
  )
  const rightRailResizeMax = Math.max(
    RIGHT_RAIL_LIMITS.minWidth,
    Math.min(
      RIGHT_RAIL_LIMITS.maxWidth,
      viewportWidth
        - MINIMUM_CONVERSATION_WIDTH
        - (desktopAssetRailVisible ? fittedSidebarWidths.left : 0)
    )
  )
  const appShellStyle = {
    '--asset-rail-width': `${fittedSidebarWidths.left}px`,
    '--right-rail-width': `${fittedSidebarWidths.right}px`
  } as CSSProperties

  const applySnapshot = useCallback((nextSnapshot: ThreadSnapshot): void => {
    if (activeThreadRef.current !== nextSnapshot.thread.id) return
    const reconciledSnapshot = {
      ...nextSnapshot,
      thread: threadProjectionRef.current.reconcile(nextSnapshot.thread)
    }
    setSnapshot(reconciledSnapshot)
    setStoppingProcessIds((current) => new Set(
      [...current].filter((processId) => {
        const process = reconciledSnapshot.processes.find((item) => item.id === processId)
        return process ? isProcessActive(process) : false
      })
    ))
    setProcessOutputCursors((current) => {
      const next = { ...current }
      for (const process of reconciledSnapshot.processes) {
        next[process.id] = Math.max(next[process.id] ?? 0, process.output_end_cursor)
      }
      return next
    })
    setThreads((current) => current.map((thread) =>
      thread.id === reconciledSnapshot.thread.id ? reconciledSnapshot.thread : thread
    ))
    const activeTurn = runningTurn(reconciledSnapshot)
    setRunningTurns((current) => {
      const next = { ...current }
      if (activeTurn) next[nextSnapshot.thread.id] = activeTurn.id
      else delete next[nextSnapshot.thread.id]
      return next
    })
  }, [])

  const refreshThread = useCallback(async (threadId: string): Promise<void> => {
    const request = (threadRefreshRequestRef.current.get(threadId) ?? 0) + 1
    threadRefreshRequestRef.current.set(threadId, request)
    try {
      const [nextSnapshot, threadResult] = await Promise.all([
        bridge.rpc('thread/get', { thread_id: threadId }),
        bridge.rpc('thread/list', {})
      ])
      if (threadRefreshRequestRef.current.get(threadId) !== request) return
      setThreads(threadProjectionRef.current.reconcileAll(threadResult.threads))
      applySnapshot(nextSnapshot)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not refresh the Thread.')
    }
  }, [applySnapshot, bridge])

  const scheduleProcessRefresh = useCallback((threadId: string, immediate = false): void => {
    const existingTimer = processRefreshTimersRef.current.get(threadId)
    if (existingTimer !== undefined) window.clearTimeout(existingTimer)
    const request = (processRefreshRequestRef.current.get(threadId) ?? 0) + 1
    processRefreshRequestRef.current.set(threadId, request)
    const timer = window.setTimeout(() => {
      processRefreshTimersRef.current.delete(threadId)
      void bridge.rpc('thread/get', { thread_id: threadId })
        .then((nextSnapshot) => {
          if (processRefreshRequestRef.current.get(threadId) !== request) return
          applySnapshot(nextSnapshot)
        })
        .catch((error) => {
          if (processRefreshRequestRef.current.get(threadId) !== request) return
          setAppError(error instanceof Error ? error.message : 'Could not refresh managed processes.')
        })
    }, immediate ? 0 : 50)
    processRefreshTimersRef.current.set(threadId, timer)
  }, [applySnapshot, bridge])

  const selectThread = useCallback(async (threadId: string): Promise<void> => {
    const request = ++loadRequestRef.current
    preferDraftRef.current = false
    activeThreadRef.current = threadId
    setActiveThreadId(threadId)
    setDraftWorkingDirectory(undefined)
    setSnapshot(undefined)
    setStoppingProcessIds(new Set())
    processStopRef.current.clear()
    setProcessOutputCursors({})
    lastProcessSequenceRef.current.clear()
    for (const timer of processRefreshTimersRef.current.values()) window.clearTimeout(timer)
    processRefreshTimersRef.current.clear()
    processRefreshRequestRef.current.clear()
    setLoadingThread(true)
    setAppError('')
    window.localStorage.setItem('kody.activeThreadId', threadId)
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

  const bootstrap = useCallback(async (preserveNavigation = false): Promise<void> => {
    if (!preserveNavigation) setBootstrapping(true)
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
      setThreads(threadProjectionRef.current.reconcileAll(threadResult.threads))
      setProjects(projectResult.projects)
      setProviders(providerResult.providers)

      const activeId = activeThreadRef.current
      if (preserveNavigation) {
        if (activeId && threadResult.threads.some((thread) => thread.id === activeId)) {
          const nextSnapshot = await bridge.rpc('thread/get', { thread_id: activeId })
          applySnapshot(nextSnapshot)
        }
      } else {
        if (preferDraftRef.current) {
          activeThreadRef.current = undefined
          setActiveThreadId(undefined)
          setSnapshot(undefined)
          hasHydratedRef.current = true
          setAnnouncement('Kody is connected and ready')
          return
        }
        const persistedId = window.localStorage.getItem('kody.activeThreadId') ?? undefined
        const preferredId = activeId && threadResult.threads.some((thread) => thread.id === activeId)
          ? activeId
          : threadResult.threads.some((thread) => thread.id === persistedId)
            ? persistedId
            : threadResult.threads[0]?.id
        if (preferredId) await selectThread(preferredId)
        else {
          activeThreadRef.current = undefined
          setActiveThreadId(undefined)
          setSnapshot(undefined)
        }
      }
      hasHydratedRef.current = true
      setAnnouncement('Kody is connected and ready')
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Kody could not connect to the local server.'
      statusRef.current = 'error'
      setStatus({ phase: 'error', detail })
      setAppError(detail)
    } finally {
      if (!preserveNavigation) setBootstrapping(false)
    }
  }, [applySnapshot, bridge, selectThread])

  const refreshProviderCatalog = useCallback(async (): Promise<void> => {
    const result = await bridge.rpc('provider/list', {})
    setProviders(result.providers)
  }, [bridge])

  const refreshProviderSettings = useCallback(async (): Promise<void> => {
    const [settings, account] = await Promise.all([
      bridge.getProviderSettings(),
      bridge.getCodexAccountStatus()
    ])
    setProviderSettings(settings)
    setCodexAccount(account)
  }, [bridge])

  const openProviderSettings = useCallback((): void => {
    setProviderSettingsOpen(true)
    void refreshProviderSettings().catch((error) => {
      setAppError(error instanceof Error ? error.message : 'Could not load provider settings.')
    })
  }, [refreshProviderSettings])

  const checkForUpdates = useCallback((): void => {
    void bridge.checkForUpdates()
      .then(setUpdateStatus)
      .catch((error) => {
        setAppError(error instanceof Error ? error.message : 'Could not check for updates.')
      })
  }, [bridge])

  const handleUpdateAction = useCallback((): void => {
    const operation = updateStatus.phase === 'available'
      ? bridge.downloadUpdate()
      : updateStatus.phase === 'downloaded'
        ? bridge.restartAndInstallUpdate()
        : bridge.checkForUpdates()
    void operation
      .then((nextStatus) => {
        if (nextStatus) setUpdateStatus(nextStatus)
      })
      .catch((error) => {
        setAppError(error instanceof Error ? error.message : 'Could not update Kody.')
      })
  }, [bridge, updateStatus.phase])

  useEffect(() => {
    let cancelled = false
    const removeUpdateListener = bridge.onUpdateStatus((nextStatus) => {
      setUpdateStatus(nextStatus)
      if (nextStatus.phase === 'available') {
        setAnnouncement(`Kody ${nextStatus.availableVersion ?? 'update'} is available`)
      } else if (nextStatus.phase === 'downloaded') {
        setAnnouncement('Kody update downloaded and ready to install')
      }
    })
    void bridge.getUpdateStatus()
      .then((nextStatus) => {
        if (!cancelled) setUpdateStatus(nextStatus)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      removeUpdateListener()
    }
  }, [bridge])

  useEffect(() => {
    if (!providerSettingsOpen || codexAccount.state === 'signed-in' || codexAccount.state === 'unavailable') return
    let cancelled = false
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const account = await bridge.getCodexAccountStatus()
        if (!cancelled) {
          setCodexAccount(account)
          if (account.state === 'signed-in') {
            setModelsByProvider((current) => {
              const next = { ...current }
              delete next.codex
              return next
            })
            void refreshProviderCatalog().catch((error) => {
              setAppError(error instanceof Error ? error.message : 'Could not refresh providers.')
            })
          }
        }
      } catch (error) {
        if (!cancelled) {
          setCodexAccount({
            state: 'unavailable',
            detail: error instanceof Error ? error.message : 'Codex account status is unavailable.'
          })
        }
      } finally {
        polling = false
      }
    }
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, codexAccount.state, providerSettingsOpen, refreshProviderCatalog])

  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? 'dark' : 'light'
    window.localStorage.setItem('kody.theme', darkTheme ? 'dark' : 'light')
  }, [darkTheme])

  useLayoutEffect(() => {
    const dock = document.querySelector<HTMLElement>('.composer-dock')
    if (!dock || typeof ResizeObserver === 'undefined') {
      setComposerDockHeight(0)
      return
    }
    const updateOffset = (): void => {
      const height = Math.ceil(dock.getBoundingClientRect().height)
      document.documentElement.style.setProperty('--composer-dock-height', `${height}px`)
      setComposerDockHeight((current) => current === height ? current : height)
    }
    const observer = new ResizeObserver(updateOffset)
    observer.observe(dock)
    updateOffset()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--composer-dock-height')
    }
  }, [activeThreadId, bootstrapping, draftId, snapshot?.thread.id, status.phase])

  useEffect(() => {
    window.localStorage.setItem('kody.railCollapsed', String(railCollapsed))
  }, [railCollapsed])

  useEffect(() => {
    window.localStorage.setItem('kody.inspectorCollapsed', String(inspectorCollapsed))
  }, [inspectorCollapsed])

  useEffect(() => {
    window.localStorage.setItem('kody.rightRailCollapsed', String(rightRailCollapsed))
  }, [rightRailCollapsed])

  useEffect(() => {
    window.localStorage.setItem(ASSET_RAIL_WIDTH_KEY, String(assetRailWidth))
  }, [assetRailWidth])

  useEffect(() => {
    window.localStorage.setItem(RIGHT_RAIL_WIDTH_KEY, String(rightRailWidth))
  }, [rightRailWidth])

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
    const railIsDrawer = railOpen && railIsNarrow
    const inspectorIsDrawer = inspectorOpen && inspectorIsNarrow
    if (!railIsDrawer && !inspectorIsDrawer) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const drawer = document.querySelector<HTMLElement>(railIsDrawer ? '.asset-rail' : '.inspector')
    if (!drawer) return
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary'
    drawer.querySelector<HTMLElement>(focusableSelector)?.focus()
    const trapFocus = (event: KeyboardEvent): void => {
      const focusables = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
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
  }, [inspectorIsNarrow, inspectorOpen, railIsNarrow, railOpen])

  useEffect(() => {
    const removeEventListener = bridge.onEvent((envelope) => {
      threadRefreshRequestRef.current.set(
        envelope.thread_id,
        (threadRefreshRequestRef.current.get(envelope.thread_id) ?? 0) + 1
      )
      const previousSequence = lastSequenceRef.current.get(envelope.turn_id)
      if (previousSequence !== undefined && envelope.sequence <= previousSequence) return
      if (previousSequence !== undefined && envelope.sequence !== previousSequence + 1) {
        setAnnouncement('Activity gap detected. Refreshing durable Thread history.')
        setEventsByThread((current) => ({
          ...current,
          [envelope.thread_id]: (current[envelope.thread_id] ?? [])
            .filter((event) => event.turn_id !== envelope.turn_id)
        }))
        void refreshThread(envelope.thread_id)
      }
      lastSequenceRef.current.set(envelope.turn_id, envelope.sequence)
      setEventsByThread((current) => ({
        ...current,
        [envelope.thread_id]: appendLiveEvent(current[envelope.thread_id] ?? [], envelope)
      }))

      if (envelope.event.type === 'turn_started') {
        setRunningTurns((current) => ({ ...current, [envelope.thread_id]: envelope.turn_id }))
        setAnnouncement('Kody started working')
      } else if (envelope.event.type === 'approval_requested') {
        setAnnouncement(`Approval required for ${envelope.event.name}`)
        void refreshThread(envelope.thread_id)
      } else if (envelope.event.type === 'approval_resolved') {
        const approvalId = envelope.event.approval_id
        approvalRef.current.delete(approvalId)
        setResolvingApprovals((current) => {
          const next = new Set(current)
          next.delete(approvalId)
          return next
        })
        setSnapshot((current) => current?.thread.id === envelope.thread_id
          ? withoutPendingApproval(current, approvalId)
          : current)
        setAnnouncement(envelope.event.approved
          ? 'Command execution allowed once'
          : 'Command execution denied')
        void refreshThread(envelope.thread_id)
      } else if (envelope.event.type === 'user_input_requested') {
        setAnnouncement('Kody needs your input to continue')
        void refreshThread(envelope.thread_id)
      } else if (envelope.event.type === 'user_input_resolved') {
        const interactionId = envelope.event.interaction_id
        userInputRef.current.delete(interactionId)
        setResolvingUserInputs((current) => {
          const next = new Set(current)
          next.delete(interactionId)
          return next
        })
        setAnnouncement(envelope.event.cancelled ? 'Input request cancelled' : 'Input sent to Kody')
        void refreshThread(envelope.thread_id)
      } else if (envelope.event.type === 'file_changed') {
        setAnnouncement(`Changed ${envelope.event.path}`)
      } else if (envelope.event.type === 'thread_updated') {
        const title = envelope.event.title
        threadProjectionRef.current.observeTitle(envelope.thread_id, title)
        setThreads((current) => current.map((thread) =>
          thread.id === envelope.thread_id ? { ...thread, title } : thread
        ))
        setSnapshot((current) => current?.thread.id === envelope.thread_id
          ? { ...current, thread: { ...current.thread, title } }
          : current)
        setAnnouncement(`Thread named ${title}`)
        void refreshThread(envelope.thread_id)
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

    const removeProcessEventListener = bridge.onProcessEvent((envelope: ProcessEventEnvelope) => {
      if (activeThreadRef.current !== envelope.thread_id) return
      const previousSequence = lastProcessSequenceRef.current.get(envelope.process_id)
      if (previousSequence !== undefined && envelope.sequence <= previousSequence) return
      if (previousSequence !== undefined && envelope.sequence !== previousSequence + 1) {
        setAnnouncement(
          envelope.event.type === 'output'
            ? 'Process output gap detected. The byte cursor will reconcile retained output.'
            : 'Process activity gap detected. Refreshing authoritative state.'
        )
      }
      lastProcessSequenceRef.current.set(envelope.process_id, envelope.sequence)

      if (envelope.event.type === 'stopping') {
        setStoppingProcessIds((current) => new Set(current).add(envelope.process_id))
        setAnnouncement('Stopping managed background process…')
      } else if (
        envelope.event.type === 'exited'
        || envelope.event.type === 'stopped'
        || envelope.event.type === 'failed'
        || envelope.event.type === 'lost'
      ) {
        setStoppingProcessIds((current) => {
          const next = new Set(current)
          next.delete(envelope.process_id)
          return next
        })
        processStopRef.current.delete(envelope.process_id)
        setAnnouncement(`Managed process ${envelope.event.type}`)
      } else if (envelope.event.type === 'started') {
        setAnnouncement('Managed background process started')
      } else if (envelope.event.type === 'output') {
        const nextCursor = envelope.event.next_cursor
        setProcessOutputCursors((current) => ({
          ...current,
          [envelope.process_id]: Math.max(current[envelope.process_id] ?? 0, nextCursor)
        }))
      }

      // Process events remain independent from the bounded Turn-event timeline.
      // Lifecycle state is reconciled from the durable Thread snapshot. Output
      // bytes are fetched only through the bounded cursor RPC.
      if (shouldRefreshProcessSnapshot(envelope.event)) scheduleProcessRefresh(envelope.thread_id, true)
    })

    const removeStatusListener = bridge.onServerStatus((nextStatus) => {
      const previous = statusRef.current
      statusRef.current = nextStatus.phase
      setStatus(nextStatus)
      if (nextStatus.phase === 'connected' && (previous !== 'connected' || nextStatus.reconcile)) {
        setEventsByThread({})
        lastSequenceRef.current.clear()
        threadRefreshRequestRef.current.clear()
        threadProjectionRef.current.clear()
        lastProcessSequenceRef.current.clear()
        setAnnouncement(
          nextStatus.reconcile
            ? 'Live activity was interrupted. Refreshing durable history.'
            : 'Server reconnected. Refreshing durable history.'
        )
        void bootstrap(hasHydratedRef.current)
      } else if (nextStatus.phase !== 'connected') {
        setEventsByThread({})
        lastSequenceRef.current.clear()
        lastProcessSequenceRef.current.clear()
        for (const timer of processRefreshTimersRef.current.values()) window.clearTimeout(timer)
        processRefreshTimersRef.current.clear()
        processRefreshRequestRef.current.clear()
        setStoppingProcessIds(new Set())
        setResolvingUserInputs(new Set())
        userInputRef.current.clear()
        processStopRef.current.clear()
        setProcessOutputCursors({})
        setAnnouncement(`Server ${nextStatus.phase}`)
      }
    })

    void bootstrap()
    return () => {
      removeEventListener()
      removeProcessEventListener()
      removeStatusListener()
      for (const timer of processRefreshTimersRef.current.values()) window.clearTimeout(timer)
      processRefreshTimersRef.current.clear()
    }
  }, [bootstrap, bridge, refreshThread, scheduleProcessRefresh])

  const activeEvents = activeThreadId ? eventsByThread[activeThreadId] ?? [] : []
  const activeRunningTurnId = activeThreadId
    ? runningTurns[activeThreadId] ?? runningTurn(snapshot)?.id
    : undefined
  const conversationTurnId = activeRunningTurnId ?? activeEvents.at(-1)?.turn_id
  const conversationEvents = conversationTurnId
    ? activeEvents.filter((event) => event.turn_id === conversationTurnId)
    : []
  const isRunning = Boolean(activeRunningTurnId)

  const composerDraftKey = activeThreadId ? `thread:${activeThreadId}` : `draft:${draftId}`
  const latestThreadTurn = snapshot && snapshot.thread.id === activeThreadId
    ? snapshot.turns.at(-1)
    : undefined
  const initialComposerDraft = useMemo<ComposerDraftState>(() => latestThreadTurn ? {
    ...EMPTY_COMPOSER_DRAFT,
    providerId: latestThreadTurn.provider,
    model: latestThreadTurn.model,
    permissionMode: latestThreadTurn.permission_mode
  } : EMPTY_COMPOSER_DRAFT, [
    latestThreadTurn?.model,
    latestThreadTurn?.permission_mode,
    latestThreadTurn?.provider
  ])
  useEffect(() => {
    if (!activeThreadId || !latestThreadTurn) return
    const threadDraftKey = `thread:${activeThreadId}`
    setComposerDrafts((current) => {
      if (current[threadDraftKey]) return current
      return { ...current, [threadDraftKey]: initialComposerDraft }
    })
  }, [activeThreadId, initialComposerDraft, latestThreadTurn])
  const composerDraft = composerDrafts[composerDraftKey] ?? initialComposerDraft
  const draftReferences = composerDraft.references
  const composerProvider = providers.find((item) => (
    item.id === composerDraft.providerId && item.auth !== 'missing'
  )) ?? providers.find((item) => item.auth !== 'missing')
  const composerProviderId = composerProvider?.id ?? ''
  const composerModels = composerProviderId ? modelsByProvider[composerProviderId] ?? [] : []
  const defaultCatalogModel = composerModels.find((model) => model.is_default) ?? composerModels[0]
  const composerModel = (
    composerDraft.providerId === composerProviderId ? composerDraft.model : ''
  ) || composerProvider?.default_model || defaultCatalogModel?.id || ''
  const setDraftReferences = useCallback((
    update: ContextReference[] | ((current: ContextReference[]) => ContextReference[])
  ): void => {
    setComposerDrafts((current) => {
      const existing = current[composerDraftKey] ?? initialComposerDraft
      const references = typeof update === 'function' ? update(existing.references) : update
      return { ...current, [composerDraftKey]: { ...existing, references } }
    })
  }, [composerDraftKey, initialComposerDraft])
  const setComposerMessage = useCallback((message: string): void => {
    setComposerDrafts((current) => {
      const existing = current[composerDraftKey] ?? initialComposerDraft
      return { ...current, [composerDraftKey]: { ...existing, message } }
    })
  }, [composerDraftKey, initialComposerDraft])
  const setComposerProvider = useCallback((providerId: string): void => {
    const descriptor = providers.find((item) => item.id === providerId)
    const catalog = modelsByProvider[providerId] ?? []
    const model = descriptor?.default_model ?? catalog.find((item) => item.is_default)?.id ?? catalog[0]?.id ?? ''
    setComposerDrafts((current) => {
      const existing = current[composerDraftKey] ?? initialComposerDraft
      return { ...current, [composerDraftKey]: { ...existing, providerId, model } }
    })
  }, [composerDraftKey, initialComposerDraft, modelsByProvider, providers])
  const setComposerModel = useCallback((model: string): void => {
    setComposerDrafts((current) => {
      const existing = current[composerDraftKey] ?? initialComposerDraft
      return {
        ...current,
        [composerDraftKey]: { ...existing, providerId: composerProviderId, model }
      }
    })
  }, [composerDraftKey, composerProviderId, initialComposerDraft])
  const setComposerPermissionMode = useCallback((permissionMode: PermissionMode): void => {
    setComposerDrafts((current) => {
      const existing = current[composerDraftKey] ?? initialComposerDraft
      return { ...current, [composerDraftKey]: { ...existing, permissionMode } }
    })
  }, [composerDraftKey, initialComposerDraft])

  useEffect(() => {
    if (
      !composerProviderId
      || !composerProvider?.capabilities.model_catalog
      || Object.prototype.hasOwnProperty.call(modelsByProvider, composerProviderId)
      || modelLoadRef.current.has(composerProviderId)
    ) return
    let cancelled = false
    modelLoadRef.current.add(composerProviderId)
    setLoadingModelProviders((current) => new Set(current).add(composerProviderId))
    void bridge.rpc('provider/models', { provider_id: composerProviderId })
      .then((result) => {
        if (!cancelled) {
          setModelsByProvider((current) => ({ ...current, [composerProviderId]: result.models }))
          // Some catalogs (notably Codex) discover authentication while the
          // sidecar is being initialized. Refresh the public descriptor so a
          // signed-out provider cannot remain selectable as `unknown`.
          void refreshProviderCatalog().catch((error) => {
            setAppError(error instanceof Error ? error.message : 'Could not refresh providers.')
          })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setModelsByProvider((current) => ({ ...current, [composerProviderId]: [] }))
          setAnnouncement(error instanceof Error ? error.message : 'Could not load provider models.')
        }
      })
      .finally(() => {
        modelLoadRef.current.delete(composerProviderId)
        setLoadingModelProviders((current) => {
          const next = new Set(current)
          next.delete(composerProviderId)
          return next
        })
      })
    return () => {
      cancelled = true
    }
  }, [bridge, composerProvider, composerProviderId, modelsByProvider, refreshProviderCatalog])

  const beginDraft = useCallback((workingDirectory?: string): void => {
    preferDraftRef.current = true
    if (!activeThreadRef.current && !startTurnRef.current) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#composer-message')?.focus())
      setAnnouncement('The new conversation is ready')
      return
    }
    loadRequestRef.current += 1
    activeThreadRef.current = undefined
    setActiveThreadId(undefined)
    setSnapshot(undefined)
    setStoppingProcessIds(new Set())
    processStopRef.current.clear()
    setProcessOutputCursors({})
    lastProcessSequenceRef.current.clear()
    for (const timer of processRefreshTimersRef.current.values()) window.clearTimeout(timer)
    processRefreshTimersRef.current.clear()
    processRefreshRequestRef.current.clear()
    setDraftWorkingDirectory(workingDirectory)
    const nextDraftId = crypto.randomUUID()
    draftIdRef.current = nextDraftId
    setDraftId(nextDraftId)
    setLoadingThread(false)
    setAppError('')
    window.localStorage.removeItem('kody.activeThreadId')
    setAnnouncement('Ready for a new conversation')
  }, [])

  const handleImportProject = useCallback(async (): Promise<void> => {
    try {
      const path = await bridge.pickDirectory('project')
      if (!path) return
      const imported = await bridge.rpc('project/import', { path })
      setProjects((current) => [imported, ...current.filter((project) => project.id !== imported.id)])
      setAnnouncement(`Imported Project ${imported.name}`)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not import the Project.')
    }
  }, [bridge])

  const addProjectContext = (project: Project): void => {
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
    references: ContextReference[],
    providerId: string,
    model: string,
    permissionMode: PermissionMode
  ): Promise<boolean> => {
    if (!providerId || !model || startTurnRef.current || isRunning) return false
    startTurnRef.current = true
    setAppError('')
    try {
      if (!snapshot) {
        const requestDraftId = draftId
        const started = await bridge.rpc('thread/create-and-start', {
          client_request_id: requestDraftId,
          message,
          references,
          provider: providerId,
          model,
          permission_mode: permissionMode,
          working_directory: draftWorkingDirectory
        })
        if (started.imported_project) {
          setProjects((current) => [
            started.imported_project as Project,
            ...current.filter((project) => project.id !== started.imported_project?.id)
          ])
        }
        const reconciledThread = threadProjectionRef.current.reconcile(started.thread)
        setComposerDrafts((current) => ({
          ...current,
          [`thread:${started.thread.id}`]: {
            message: '',
            references: [],
            providerId,
            model,
            permissionMode
          }
        }))
        setThreads((current) => [
          reconciledThread,
          ...current.filter((thread) => thread.id !== started.thread.id)
        ])
        setRunningTurns((current) => ({ ...current, [started.thread.id]: started.turn.id }))
        const shouldActivate = !activeThreadRef.current && draftIdRef.current === requestDraftId
        if (shouldActivate) {
          preferDraftRef.current = false
          activeThreadRef.current = started.thread.id
          setActiveThreadId(started.thread.id)
          setSnapshot({
            thread: { ...reconciledThread, status: 'running', updated_at: started.turn.created_at },
            workspace: started.workspace,
            messages: [optimisticMessage(started.thread.id, started.turn, message, references)],
            turns: [started.turn],
            pending_approvals: [],
            pending_user_inputs: [],
            processes: []
          })
          setDraftWorkingDirectory(undefined)
          window.localStorage.setItem('kody.activeThreadId', started.thread.id)
          setAnnouncement('Thread created. Kody is starting the first turn.')
        } else {
          setAnnouncement('Thread created; Kody started working')
        }
        void refreshThread(started.thread.id)
        return true
      }
      if (snapshot.thread.id !== activeThreadRef.current || loadingThread) return false
      const turn = await bridge.rpc('turn/start', {
        thread_id: snapshot.thread.id,
        message,
        references,
        provider: providerId,
        model,
        permission_mode: permissionMode
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
      setAnnouncement('Message sent. Kody is starting the turn.')
      void refreshThread(snapshot.thread.id)
      return true
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not start the conversation.')
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
    const approvalThreadId = activeThreadRef.current
    approvalRef.current.add(approvalId)
    setResolvingApprovals((current) => new Set(current).add(approvalId))
    try {
      const result = await bridge.rpc('approval/respond', { approval_id: approvalId, approved })
      // Both outcomes mean the request is no longer actionable. `resolved: false`
      // is the expected stale-client race when another client answered first.
      setSnapshot((current) => {
        if (!current || !approvalThreadId || current.thread.id !== approvalThreadId) return current
        return withoutPendingApproval(current, approvalId)
      })
      if (result.resolved) {
        setAnnouncement(approved ? 'Command execution allowed once' : 'Command execution denied')
      } else {
        setAnnouncement('Command approval was already handled; Thread state refreshed')
      }
      if (approvalThreadId) void refreshThread(approvalThreadId)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not respond to approval.')
    } finally {
      approvalRef.current.delete(approvalId)
      setResolvingApprovals((current) => {
        const next = new Set(current)
        next.delete(approvalId)
        return next
      })
    }
  }

  const handleUserInput = async (
    interactionId: string,
    answers: UserInputAnswers,
    cancelled: boolean
  ): Promise<void> => {
    if (userInputRef.current.has(interactionId)) return
    userInputRef.current.add(interactionId)
    setResolvingUserInputs((current) => new Set(current).add(interactionId))
    try {
      const result = await bridge.rpc('user-input/respond', {
        interaction_id: interactionId,
        answers,
        cancelled
      })
      if (!result.resolved) throw new Error('This input request was already resolved.')
      setSnapshot((current) => current ? {
        ...current,
        pending_user_inputs: (current.pending_user_inputs ?? []).filter(
          (request) => request.interaction_id !== interactionId
        )
      } : current)
      setAnnouncement(cancelled ? 'Input request cancelled' : 'Input sent. Kody is continuing.')
      if (activeThreadRef.current) void refreshThread(activeThreadRef.current)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not respond to Kody.')
    } finally {
      userInputRef.current.delete(interactionId)
      setResolvingUserInputs((current) => {
        const next = new Set(current)
        next.delete(interactionId)
        return next
      })
    }
  }

  const handleReadProcessOutput = async (
    processId: string,
    afterCursor: number,
    limit: number
  ): Promise<ProcessOutputPage> => {
    const threadId = activeThreadRef.current
    if (!threadId) throw new Error('No active Thread is available for this process.')
    return bridge.rpc('process/read-output', {
      thread_id: threadId,
      process_id: processId,
      after_cursor: afterCursor,
      limit
    })
  }

  const handleStopProcess = async (processId: string): Promise<void> => {
    const threadId = activeThreadRef.current
    if (!threadId || processStopRef.current.has(processId)) return
    processStopRef.current.add(processId)
    setStoppingProcessIds((current) => new Set(current).add(processId))
    setAnnouncement('Stopping managed background process…')
    try {
      const process = await bridge.rpc('process/stop', {
        thread_id: threadId,
        process_id: processId
      })
      setSnapshot((current) => {
        if (!current || current.thread.id !== threadId) return current
        return {
          ...current,
          processes: current.processes.map((item) => item.id === process.id ? process : item)
        }
      })
      setAnnouncement(`Managed process ${process.status}`)
      scheduleProcessRefresh(threadId, true)
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not stop the managed process.')
    } finally {
      processStopRef.current.delete(processId)
      setStoppingProcessIds((current) => {
        const next = new Set(current)
        next.delete(processId)
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

  const handleSaveProvider = async (profile: ProviderProfileSubmission): Promise<void> => {
    const saved = await bridge.upsertProviderProfile(profile as ProviderProfileUpdate)
    setProviderSettings((current) => ({
      ...current,
      profiles: [saved, ...current.profiles.filter((item) => item.id !== saved.id)]
    }))
    setModelsByProvider((current) => {
      const next = { ...current }
      delete next[saved.id]
      return next
    })
    void refreshProviderCatalog().catch((error) => {
      setAppError(error instanceof Error ? error.message : 'Could not refresh providers.')
    })
  }

  const handleDeleteProvider = async (profileId: string): Promise<void> => {
    await bridge.deleteProviderProfile(profileId)
    setProviderSettings((current) => ({
      ...current,
      profiles: current.profiles.filter((item) => item.id !== profileId)
    }))
    setModelsByProvider((current) => {
      const next = { ...current }
      delete next[profileId]
      return next
    })
    void refreshProviderCatalog().catch((error) => {
      setAppError(error instanceof Error ? error.message : 'Could not refresh providers.')
    })
  }

  const handleConnectCodexAccount = async (): Promise<void> => {
    const result = await bridge.connectCodexAccount()
    setCodexAccount({
      state: 'signed-out',
      detail: result.mode === 'device_code' && result.userCode
        ? `Enter code ${result.userCode} in the opened browser. Waiting for sign-in…`
        : 'Continue sign-in in the opened browser. Waiting for completion…'
    })
  }

  const handleDisconnectCodexAccount = async (): Promise<void> => {
    await bridge.disconnectCodexAccount()
    setCodexAccount(await bridge.getCodexAccountStatus())
    void refreshProviderCatalog().catch((error) => {
      setAppError(error instanceof Error ? error.message : 'Could not refresh providers.')
    })
  }

  useEffect(() => bridge.onCommand((command) => {
    if (command === 'new-thread') {
      beginDraft()
      return
    }
    if (command === 'import-project') {
      void handleImportProject()
      return
    }
    if (command === 'focus-assets') {
      setRailCollapsed(false)
      if (railIsNarrow) {
        setInspectorOpen(false)
        setRailOpen(true)
      }
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#asset-filter')?.focus())
      return
    }
    if (command === 'open-settings') {
      openProviderSettings()
      return
    }
    if (command === 'check-for-updates') {
      checkForUpdates()
      return
    }
    if (command === 'toggle-rail') {
      if (railIsNarrow) {
        setInspectorOpen(false)
        setRailOpen((current) => !current)
      }
      else setRailCollapsed((current) => !current)
      return
    }
    if (inspectorIsNarrow) {
      setRailOpen(false)
      setRightRailCollapsed(false)
      setInspectorCollapsed(false)
      setInspectorOpen((current) => !current)
    } else {
      setRightRailCollapsed(false)
      setInspectorCollapsed((current) => !current)
    }
  }), [
    beginDraft,
    bridge,
    checkForUpdates,
    handleImportProject,
    inspectorIsNarrow,
    openProviderSettings,
    railIsNarrow
  ])

  const emptyDisconnected = status.phase !== 'connected' && !snapshot
  const selectedProjectIds = new Set(
    [...(snapshot?.thread.default_references ?? []), ...draftReferences]
      .filter((reference): reference is Extract<ContextReference, { kind: 'project' }> => reference.kind === 'project')
      .map((reference) => reference.project_id)
  )
  const threadContext = useMemo(
    () => snapshot ? deriveThreadContext(snapshot, activeEvents, draftReferences) : undefined,
    [activeEvents, draftReferences, snapshot]
  )
  const contextCount = threadContext
    ? threadContext.threadReferences.length + threadContext.projectReferences.length
    : 0
  const contextActive = Boolean(
    threadContext
    && (threadContext.activeTurns.length > 0
      || threadContext.runningTools.length > 0
      || threadContext.pendingApprovals.length > 0
      || snapshot?.processes.some(isProcessActive))
  )

  const resizeAssetRail = useCallback((width: number): void => {
    const nextWidth = clampSidebarWidth(
      width,
      ASSET_RAIL_LIMITS.minWidth,
      assetRailResizeMax
    )
    setAssetRailWidth(nextWidth)
    setAnnouncement(`Asset sidebar width ${nextWidth} pixels`)
  }, [assetRailResizeMax])

  const resizeRightRail = useCallback((width: number): void => {
    const nextWidth = clampSidebarWidth(
      width,
      RIGHT_RAIL_LIMITS.minWidth,
      rightRailResizeMax
    )
    setRightRailWidth(nextWidth)
    setAnnouncement(`Right sidebar width ${nextWidth} pixels`)
  }, [rightRailResizeMax])

  const toggleInspectorDetails = (): void => {
    setInspectorCollapsed((current) => !current)
  }
  const toggleRightSidebar = (): void => {
    if (inspectorIsNarrow) {
      setRailOpen(false)
      setRightRailCollapsed(false)
      setInspectorCollapsed(false)
      setInspectorOpen((current) => !current)
    } else {
      setRightRailCollapsed((current) => !current)
    }
  }

  return (
    <div
      ref={appShellRef}
      className={`app-shell${railCollapsed ? ' app-shell--rail-collapsed' : ''}${inspectorCollapsed ? ' app-shell--inspector-collapsed' : ''}${rightRailCollapsed && !inspectorIsNarrow ? ' app-shell--right-rail-collapsed' : ''}${bridge.platform === 'darwin' ? ' app-shell--darwin' : ''}`}
      style={appShellStyle}
    >
      <a className="skip-link" href="#main-content">Skip to conversation</a>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <AssetRail
        threads={threads}
        activeThreadId={activeThreadId}
        status={status}
        updateStatus={updateStatus}
        open={railOpen}
        onClose={() => setRailOpen(false)}
        onCollapse={() => setRailCollapsed(true)}
        onNewThread={() => beginDraft()}
        onSelectThread={(threadId) => void selectThread(threadId)}
        onOpenSettings={openProviderSettings}
        onUpdateAction={handleUpdateAction}
      />

      {((railOpen && railIsNarrow) || (inspectorOpen && inspectorIsNarrow)) ? (
        <button
          className={`drawer-scrim drawer-scrim--${railOpen && railIsNarrow ? 'asset' : 'inspector'}`}
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
          showRightSidebar={!inspectorIsNarrow || Boolean(snapshot)}
          rightSidebarExpanded={inspectorIsNarrow ? inspectorOpen : !rightRailCollapsed}
          contextCount={contextCount}
          contextActive={contextActive}
          onOpenRail={() => {
            setInspectorOpen(false)
            setRailCollapsed(false)
            setRailOpen(true)
          }}
          onToggleRightSidebar={toggleRightSidebar}
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
              <h2>{status.phase === 'error' ? 'Kody could not start' : 'Server disconnected'}</h2>
              <p>{status.detail || 'The desktop app cannot reach its local Kody server.'}</p>
              <button className="primary-button" type="button" onClick={() => void bootstrap()}>
                <RefreshCcw aria-hidden="true" size={15} /> Retry connection
              </button>
            </section>
          ) : bootstrapping && !snapshot ? (
            <section className="loading-state" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={23} />
              <h2>Opening Kody</h2>
              <p>Connecting to the local agent runtime…</p>
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
                pendingUserInputs={snapshot.pending_user_inputs ?? []}
                running={isRunning}
                resolvingApprovals={resolvingApprovals}
                resolvingUserInputs={resolvingUserInputs}
                bottomInset={composerDockHeight}
                onApproval={handleApproval}
                onUserInput={handleUserInput}
              />
              <div className="composer-dock">
                <Composer
                  key={snapshot.thread.id}
                  currentThreadId={snapshot.thread.id}
                  threads={threads}
                  projects={projects}
                  references={draftReferences}
                  providers={providers}
                  providerId={composerProviderId}
                  models={composerModels}
                  model={composerModel}
                  permissionMode={composerDraft.permissionMode}
                  modelsLoading={loadingModelProviders.has(composerProviderId)}
                  running={isRunning}
                  message={composerDraft.message}
                  unavailable={status.phase !== 'connected' || loadingThread || snapshot.thread.id !== activeThreadId}
                  onReferencesChange={setDraftReferences}
                  onProviderChange={setComposerProvider}
                  onModelChange={setComposerModel}
                  onPermissionModeChange={setComposerPermissionMode}
                  onMessageChange={setComposerMessage}
                  onSend={handleStartTurn}
                  onCancel={handleCancelTurn}
                />
              </div>
            </>
          ) : (
            <>
              <DraftConversation />
              <div className="composer-dock">
                <Composer
                  key={draftId}
                  threads={threads}
                  projects={projects}
                  references={draftReferences}
                  providers={providers}
                  providerId={composerProviderId}
                  models={composerModels}
                  model={composerModel}
                  permissionMode={composerDraft.permissionMode}
                  modelsLoading={loadingModelProviders.has(composerProviderId)}
                  running={false}
                  message={composerDraft.message}
                  draft
                  workingDirectory={draftWorkingDirectory}
                  unavailable={status.phase !== 'connected'}
                  onReferencesChange={setDraftReferences}
                  onProviderChange={setComposerProvider}
                  onModelChange={setComposerModel}
                  onPermissionModeChange={setComposerPermissionMode}
                  onMessageChange={setComposerMessage}
                  onPickWorkingDirectory={async () => {
                    const path = await bridge.pickDirectory('working-directory')
                    if (path) setDraftWorkingDirectory(path)
                  }}
                  onClearWorkingDirectory={() => setDraftWorkingDirectory(undefined)}
                  onSend={handleStartTurn}
                  onCancel={async () => undefined}
                />
              </div>
            </>
          )}
          {loadingThread && snapshot ? <div className="thread-loading-overlay" role="status">Refreshing Thread…</div> : null}
        </main>
      </section>

      <div
        id="right-rail"
        className={`right-rail${inspectorOpen && inspectorIsNarrow ? ' right-rail--inspector-open' : ''}`}
      >
        {snapshot && threadContext ? (
          <ThreadContextCard
            snapshot={snapshot}
            threads={threads}
            projects={projects}
            context={threadContext}
            detailsOpen={!inspectorCollapsed}
            onOpenDetails={toggleInspectorDetails}
          />
        ) : null}
        {snapshot ? (
          <Inspector
            snapshot={snapshot}
            threads={threads}
            projects={projects}
            draftReferences={draftReferences}
            events={activeEvents}
            open={inspectorOpen}
            modal={inspectorIsNarrow}
            stoppingProcessIds={stoppingProcessIds}
            processOutputCursors={processOutputCursors}
            onClose={() => {
              if (inspectorIsNarrow) setInspectorOpen(false)
              else {
                setInspectorCollapsed(true)
                requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(
                  '#thread-context-card button[aria-controls="thread-inspector"]'
                )?.focus())
              }
            }}
            onCopyText={copyText}
            onReadProcessOutput={handleReadProcessOutput}
            onStopProcess={handleStopProcess}
          />
        ) : null}
        <ProjectShelf
          projects={projects}
          selectedProjectIds={selectedProjectIds}
          unavailable={status.phase !== 'connected'}
          onImportProject={handleImportProject}
          onAddProject={addProjectContext}
        />
      </div>

      {desktopAssetRailVisible ? (
        <SidebarResizeHandle
          side="left"
          label="Resize asset sidebar"
          controls="asset-rail"
          value={fittedSidebarWidths.left}
          min={ASSET_RAIL_LIMITS.minWidth}
          max={assetRailResizeMax}
          defaultValue={ASSET_RAIL_LIMITS.defaultWidth}
          containerRef={appShellRef}
          onChange={resizeAssetRail}
        />
      ) : null}

      {desktopRightRailVisible ? (
        <SidebarResizeHandle
          side="right"
          label="Resize right sidebar"
          controls="right-rail"
          value={fittedSidebarWidths.right}
          min={RIGHT_RAIL_LIMITS.minWidth}
          max={rightRailResizeMax}
          defaultValue={RIGHT_RAIL_LIMITS.defaultWidth}
          containerRef={appShellRef}
          onChange={resizeRightRail}
        />
      ) : null}

      <ProviderSettingsDialog
        open={providerSettingsOpen}
        profiles={providerSettings.profiles}
        credentialStorage={providerSettings.credentialStorage}
        codexAccount={codexAccount}
        onClose={() => setProviderSettingsOpen(false)}
        onSave={handleSaveProvider}
        onDelete={handleDeleteProvider}
        onConnectCodexAccount={handleConnectCodexAccount}
        onDisconnectCodexAccount={handleDisconnectCodexAccount}
      />
    </div>
  )
}
