import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'

import type {
  EventEnvelope,
  ProcessEventEnvelope,
  RpcMethod,
  RpcMethodMap,
  ServerStatus
} from '../shared/protocol'

const HEALTH_TIMEOUT_MS = 15_000
const RPC_TIMEOUT_MS = 60_000
const RECONNECT_MAX_DELAY_MS = 5_000

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface ServerManagerOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
  stateRoot: string
  onEvent(event: EventEnvelope): void
  onProcessEvent(event: ProcessEventEnvelope): void
  onStatus(status: ServerStatus): void
  onLog?(line: string): void
}

interface LaunchCommand {
  command: string
  args: string[]
  cwd: string
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

/** Owns the one private app-server process and authenticated WebSocket. */
export class CodyServerManager {
  private status: ServerStatus = { phase: 'starting', detail: 'Starting Cody engine…' }
  private child: ChildProcess | null = null
  private socket: WebSocket | null = null
  private token: string | null = null
  private port: number | null = null
  private pending = new Map<string, PendingRequest>()
  private subscriptions = new Set<string>()
  private nextRequestId = 1
  private startPromise: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private closed = false

  constructor(private readonly options: ServerManagerOptions) {}

  getStatus(): ServerStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Cody server manager is shutting down')
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.startPromise) return this.startPromise

    this.clearReconnectTimer()
    const operation = this.hasLiveChild() && this.token && this.port
      ? this.connectExisting(true)
      : this.launchFresh()
    this.startPromise = operation
      .catch((error) => {
        if (this.status.phase === 'starting') {
          this.updateStatus({
            phase: 'error',
            detail: `Cody engine is unavailable: ${safeErrorMessage(error, this.token ?? '')}`
          })
        }
        throw error
      })
      .finally(() => {
        this.startPromise = null
      })
    return this.startPromise
  }

  async rpc<M extends RpcMethod>(
    method: M,
    params: RpcMethodMap[M]['params']
  ): Promise<RpcMethodMap[M]['result']> {
    await this.start()
    const result = await this.sendRpc<RpcMethodMap[M]['result']>(method, params)
    if (method === 'thread/create-and-start') {
      const threadId = (result as { thread?: { id?: unknown } }).thread?.id
      if (typeof threadId === 'string') {
        // The WebSocket endpoint atomically subscribes this connection before
        // it acknowledges create-and-start. Keep the local set only so a new
        // socket can restore that subscription after reconnecting.
        this.subscriptions.add(threadId)
      }
    }
    if (
      method === 'thread/get'
      || method === 'turn/start'
      || method === 'process/list'
      || method === 'process/get'
      || method === 'process/read-output'
      || method === 'process/stop'
    ) {
      const threadId = (params as { thread_id?: unknown }).thread_id
      if (typeof threadId === 'string') this.subscriptions.add(threadId)
    }
    return result
  }

  async stop(): Promise<void> {
    if (this.closed && !this.child && !this.socket) return
    this.closed = true
    this.clearReconnectTimer()
    this.rejectPending(new Error('Cody app server stopped'))
    this.closeSocket()
    const child = this.child
    this.child = null
    this.token = null
    this.port = null
    if (child) await terminateProcessTree(child)
    this.updateStatus({ phase: 'disconnected', detail: 'Cody engine stopped.' })
  }

  private async launchFresh(): Promise<void> {
    this.updateStatus({ phase: 'starting', detail: 'Starting Cody engine…' })
    this.closeSocket()
    if (this.child) {
      const staleChild = this.child
      this.child = null
      await terminateProcessTree(staleChild)
    }

    const port = await reserveLoopbackPort()
    const token = randomBytes(48).toString('base64url')
    const launch = resolveLaunchCommand(this.options)
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        CODY_BIND: `127.0.0.1:${port}`,
        CODY_SERVER_TOKEN: token,
        CODY_HOME: this.options.stateRoot
      },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.child = child
    this.port = port
    this.token = token
    this.consumeChildOutput(child, token)
    this.observeChild(child)

    try {
      await waitForSpawn(child)
      await waitForHealth(port, HEALTH_TIMEOUT_MS, () => this.child === child && this.hasLiveChild())
      await this.connectExisting(false)
    } catch (error) {
      if (this.child === child) this.child = null
      await terminateProcessTree(child)
      this.token = null
      this.port = null
      const detail = `Cody engine failed to start: ${safeErrorMessage(error, token)}`
      this.updateStatus({ phase: 'error', detail })
      throw new Error(detail)
    }
  }

  private async connectExisting(isReconnect: boolean): Promise<void> {
    const port = this.port
    const token = this.token
    if (!port || !token || !this.hasLiveChild()) throw new Error('Cody app server is not running')

    this.updateStatus({
      phase: 'starting',
      detail: isReconnect ? 'Reconnecting to Cody engine…' : 'Connecting to Cody engine…'
    })
    try {
      await this.openSocket(port, token)
      await this.sendRpc('initialize', {})
      await this.restoreSubscriptions()
    } catch (error) {
      this.closeSocket()
      this.rejectPending(new Error('Could not establish the Cody RPC connection'))
      throw error
    }
    this.reconnectAttempt = 0
    this.updateStatus({
      phase: 'connected',
      detail: isReconnect ? 'Reconnected. Refreshing durable Thread history is required.' : undefined,
      reconcile: isReconnect || undefined
    })
  }

  private openSocket(port: number, token: string): Promise<void> {
    this.closeSocket()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 5_000,
      perMessageDeflate: false
    })
    this.socket = socket
    socket.on('message', (data) => this.handleSocketMessage(data))
    socket.on('close', () => this.handleSocketClose(socket))
    socket.on('error', (error) => {
      this.options.onLog?.(`WebSocket: ${safeErrorMessage(error, token)}`)
    })

    return new Promise((resolveOpen, rejectOpen) => {
      const onOpen = (): void => {
        cleanup()
        resolveOpen()
      }
      const onError = (error: Error): void => {
        cleanup()
        rejectOpen(error)
      }
      const onClose = (): void => {
        cleanup()
        rejectOpen(new Error('WebSocket closed during connection'))
      }
      const cleanup = (): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
  }

  private handleSocketMessage(data: RawData): void {
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      this.options.onLog?.('Ignored an invalid JSON message from Cody app server.')
      return
    }
    if (!isRecord(message)) return

    if ('id' in message && (typeof message.id === 'string' || typeof message.id === 'number')) {
      const key = String(message.id)
      const pending = this.pending.get(key)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(key)
      const response = message as unknown as JsonRpcResponse
      if (response.error) {
        pending.reject(new JsonRpcError(response.error.code, response.error.message, response.error.data))
      } else {
        pending.resolve(response.result)
      }
      return
    }

    if (message.method === 'turn/event' && isEventEnvelope(message.params)) {
      this.options.onEvent(message.params)
      return
    }
    if (message.method === 'process/event' && isProcessEventEnvelope(message.params)) {
      this.options.onProcessEvent(message.params)
      return
    }
    if (message.method === 'server/event_gap') {
      const skipped = isRecord(message.params) && typeof message.params.skipped === 'number'
        ? message.params.skipped
        : 'some'
      this.updateStatus({
        phase: 'connected',
        detail: `Live stream skipped ${skipped} event(s). Refreshing durable Thread history is required.`,
        reconcile: true
      })
    }
  }

  private handleSocketClose(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.rejectPending(new Error('Connection to Cody app server was closed'))
    if (this.closed) return
    if (this.hasLiveChild()) {
      this.updateStatus({ phase: 'disconnected', detail: 'Cody engine connection was interrupted.' })
      this.scheduleReconnect()
    } else {
      this.updateStatus({ phase: 'error', detail: 'Cody engine exited unexpectedly.' })
    }
  }

  private sendRpc<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Cody app server is not connected'))
    }
    const id = `desktop-${this.nextRequestId++}`
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`Cody RPC '${method}' timed out`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timeout
      })
      socket.send(payload, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pending.delete(id)
        pending.reject(error)
      })
    })
  }

  private async restoreSubscriptions(): Promise<void> {
    for (const threadId of this.subscriptions) {
      await this.sendRpc('thread/subscribe', { thread_id: threadId })
    }
  }

  private observeChild(child: ChildProcess): void {
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.token = null
      this.port = null
      this.closeSocket()
      this.rejectPending(new Error('Cody app server exited'))
      if (!this.closed) {
        const suffix = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
        this.updateStatus({ phase: 'error', detail: `Cody engine exited unexpectedly (${suffix}).` })
      }
    })
  }

  private consumeChildOutput(child: ChildProcess, token: string): void {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        if (!this.options.onLog) return
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          this.options.onLog(line.split(token).join('[redacted]'))
        }
      })
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.removeAllListeners()
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate()
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }

  private hasLiveChild(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed || !this.hasLiveChild()) return
    const delay = Math.min(250 * 2 ** this.reconnectAttempt++, RECONNECT_MAX_DELAY_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start().catch((error) => {
        if (this.closed || !this.hasLiveChild()) return
        this.updateStatus({ phase: 'disconnected', detail: safeErrorMessage(error, this.token ?? '') })
        this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private updateStatus(status: ServerStatus): void {
    this.status = { ...status }
    this.options.onStatus(this.getStatus())
  }
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPort)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a loopback port'))
        return
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

export function resolveLaunchCommand(
  options: Pick<ServerManagerOptions, 'appPath' | 'isPackaged' | 'resourcesPath'>
): LaunchCommand {
  const executable = process.platform === 'win32' ? 'cody-app-server.exe' : 'cody-app-server'
  if (options.isPackaged) {
    const binary = join(options.resourcesPath, 'bin', executable)
    if (!existsSync(binary)) throw new Error('Packaged Cody app-server binary is missing')
    return { command: binary, args: [], cwd: dirname(binary) }
  }

  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const workspaceRoot = findCargoWorkspaceRoot([process.cwd(), options.appPath, moduleDirectory])
  if (!workspaceRoot) throw new Error('Could not locate Cody Cargo workspace')
  const debugBinary = join(workspaceRoot, 'target', 'debug', executable)
  if (existsSync(debugBinary)) return { command: debugBinary, args: [], cwd: workspaceRoot }
  return {
    command: 'cargo',
    args: ['run', '--quiet', '--manifest-path', join(workspaceRoot, 'Cargo.toml'), '-p', 'cody-app-server'],
    cwd: workspaceRoot
  }
}

export function findCargoWorkspaceRoot(starts: string[]): string | null {
  for (const start of starts) {
    let current = resolve(start)
    while (true) {
      if (existsSync(join(current, 'Cargo.toml')) && existsSync(join(current, 'crates', 'cody-app-server'))) {
        return current
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return null
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve()
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })
}

async function waitForHealth(port: number, timeoutMs: number, isAlive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('Health endpoint did not respond')
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('Cody app server exited before becoming healthy')
    try {
      await healthRequest(port)
      return
    } catch (error) {
      lastError = error
      await delay(75)
    }
  }
  throw new Error(`Timed out waiting for Cody app server health: ${safeErrorMessage(lastError, '')}`)
}

function healthRequest(port: number): Promise<void> {
  return new Promise((resolveHealth, rejectHealth) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 750 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          rejectHealth(new Error(`Health endpoint returned HTTP ${res.statusCode ?? 'unknown'}`))
          return
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          if (!isRecord(body) || body.status !== 'ok' || body.service !== 'cody-app-server') {
            rejectHealth(new Error('Unexpected health response'))
            return
          }
          resolveHealth()
        } catch (error) {
          rejectHealth(error instanceof Error ? error : new Error('Invalid health response'))
        }
      })
    })
    req.once('timeout', () => req.destroy(new Error('Health request timed out')))
    req.once('error', rejectHealth)
    req.end()
  })
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    await new Promise<void>((resolveKill) => killer.once('exit', () => resolveKill()))
    await Promise.race([exited, delay(1_500)])
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  // The Rust server drains active Turns and asks every managed process group
  // to terminate before exiting. Give that graceful barrier time to finish;
  // SIGKILL remains the final fallback for a wedged server.
  // Rust reserves up to 5s for Turn cancellation, 3s for process-group
  // escalation, 2s for output-pipe drain detection, and 2s for connection
  // draining. Leave margin around the complete shutdown contract before the
  // desktop applies SIGKILL; parent-death guardians remain the crash fallback.
  await Promise.race([exited, delay(15_000)])
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    await Promise.race([exited, delay(500)])
  }
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isRecord(value) || !isRecord(value.event)) return false
  return typeof value.id === 'string'
    && typeof value.thread_id === 'string'
    && typeof value.turn_id === 'string'
    && typeof value.sequence === 'number'
    && typeof value.created_at === 'string'
    && typeof value.event.type === 'string'
}

function isProcessEventEnvelope(value: unknown): value is ProcessEventEnvelope {
  if (!isRecord(value) || !isRecord(value.event)) return false
  const envelopeFieldsAreValid = typeof value.id === 'string'
    && typeof value.thread_id === 'string'
    && typeof value.process_id === 'string'
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) > 0
    && typeof value.created_at === 'string'
  if (!envelopeFieldsAreValid) return false

  const event = value.event
  switch (event.type) {
    case 'started':
      return Number.isSafeInteger(event.pid)
        && (event.pid as number) > 0
        && (event.pid as number) <= 0xffff_ffff
        && (event.process_group_id === undefined || (
          Number.isSafeInteger(event.process_group_id)
          && (event.process_group_id as number) >= -0x8000_0000
          && (event.process_group_id as number) <= 0x7fff_ffff
        ))
    case 'output':
      if (
        (event.stream !== 'stdout' && event.stream !== 'stderr')
        || !Number.isSafeInteger(event.cursor)
        || !Number.isSafeInteger(event.next_cursor)
        || (event.cursor as number) < 0
        || (event.next_cursor as number) < (event.cursor as number)
      ) return false
      return true
    case 'stopping':
      return true
    case 'exited':
      return event.exit_code === undefined || Number.isSafeInteger(event.exit_code)
    case 'stopped':
      return (event.exit_code === undefined || Number.isSafeInteger(event.exit_code))
        && typeof event.forced === 'boolean'
    case 'failed':
      return typeof event.error === 'string'
    case 'lost':
      return typeof event.reason === 'string'
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeErrorMessage(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return secret ? message.split(secret).join('[redacted]') : message
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
