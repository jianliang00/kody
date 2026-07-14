import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import type { AppUpdater, UpdateDownloadedEvent } from 'electron-updater'

import type { DesktopUpdateStatus } from '../shared/bridge'

const DEFAULT_INITIAL_CHECK_DELAY_MS = 15_000
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

export interface UpdateManagerOptions {
  updater: AppUpdater
  currentVersion: string
  enabled: boolean
  disabledReason?: string
  onStatus(status: DesktopUpdateStatus): void
  beforeInstall?(): Promise<void>
  initialCheckDelayMs?: number
  checkIntervalMs?: number
}

/**
 * Owns the desktop update state machine. The renderer never receives release
 * URLs or credentials; it can only request explicit state transitions.
 */
export class KodyUpdateManager {
  private readonly updater: AppUpdater
  private readonly onStatus: (status: DesktopUpdateStatus) => void
  private readonly enabled: boolean
  private readonly beforeInstall: () => Promise<void>
  private readonly initialCheckDelayMs: number
  private readonly checkIntervalMs: number
  private status: DesktopUpdateStatus
  private automaticCheck = false
  private checkPromise?: Promise<DesktopUpdateStatus>
  private downloadPromise?: Promise<DesktopUpdateStatus>
  private initialCheckTimer?: NodeJS.Timeout
  private periodicCheckTimer?: NodeJS.Timeout

  constructor(options: UpdateManagerOptions) {
    this.updater = options.updater
    this.onStatus = options.onStatus
    this.enabled = options.enabled
    this.beforeInstall = options.beforeInstall ?? (() => Promise.resolve())
    this.initialCheckDelayMs = options.initialCheckDelayMs ?? DEFAULT_INITIAL_CHECK_DELAY_MS
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    this.status = options.enabled
      ? { phase: 'idle', currentVersion: options.currentVersion }
      : {
          phase: 'disabled',
          currentVersion: options.currentVersion,
          detail: options.disabledReason ?? 'Updates are available in signed production builds.'
        }

    if (!this.enabled) return

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.autoRunAppAfterInstall = true
    this.updater.allowPrerelease = false
    this.updater.allowDowngrade = false

    this.updater.on('checking-for-update', () => {
      this.setStatus({ phase: 'checking' })
    })
    this.updater.on('update-available', (info: UpdateInfo) => {
      this.setStatus({
        phase: 'available',
        availableVersion: info.version,
        checkedAt: new Date().toISOString(),
        detail: `Kody ${info.version} is ready to download.`
      })
    })
    this.updater.on('update-not-available', () => {
      this.setStatus({
        phase: this.automaticCheck ? 'idle' : 'up-to-date',
        checkedAt: new Date().toISOString(),
        detail: this.automaticCheck ? undefined : 'You are using the latest version of Kody.'
      })
    })
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      this.setStatus({
        phase: 'downloading',
        availableVersion: this.status.availableVersion,
        percent: clampPercent(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        detail: 'Downloading the signed update…'
      })
    })
    this.updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.setStatus({
        phase: 'downloaded',
        availableVersion: event.version,
        percent: 100,
        transferred: this.status.total,
        total: this.status.total,
        checkedAt: this.status.checkedAt,
        detail: 'The update is ready. Restart Kody to install it.'
      })
    })
    this.updater.on('error', (error: Error) => {
      this.handleError(error)
    })
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status }
  }

  start(): void {
    if (!this.enabled || this.initialCheckTimer || this.periodicCheckTimer) return
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = undefined
      void this.check(false)
    }, this.initialCheckDelayMs)
    this.initialCheckTimer.unref()
    this.periodicCheckTimer = setInterval(() => void this.check(false), this.checkIntervalMs)
    this.periodicCheckTimer.unref()
  }

  stop(): void {
    if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer)
    if (this.periodicCheckTimer) clearInterval(this.periodicCheckTimer)
    this.initialCheckTimer = undefined
    this.periodicCheckTimer = undefined
  }

  check(manual = true): Promise<DesktopUpdateStatus> {
    if (!this.enabled) return Promise.resolve(this.getStatus())
    if (this.checkPromise) return this.checkPromise
    if (this.status.phase === 'downloading' || this.status.phase === 'downloaded') {
      return Promise.resolve(this.getStatus())
    }

    this.automaticCheck = !manual
    this.setStatus({ phase: 'checking' })
    const operation = this.updater.checkForUpdates()
      .then(() => this.getStatus())
      .catch((error: unknown) => {
        this.handleError(error)
        return this.getStatus()
      })
      .finally(() => {
        this.automaticCheck = false
        this.checkPromise = undefined
      })
    this.checkPromise = operation
    return operation
  }

  download(): Promise<DesktopUpdateStatus> {
    if (!this.enabled) return Promise.resolve(this.getStatus())
    if (this.downloadPromise) return this.downloadPromise
    if (this.status.phase !== 'available') {
      return Promise.reject(new Error('No Kody update is ready to download.'))
    }

    this.setStatus({
      phase: 'downloading',
      availableVersion: this.status.availableVersion,
      percent: 0,
      transferred: 0,
      detail: 'Downloading the signed update…'
    })
    const operation = this.updater.downloadUpdate()
      .then(() => this.getStatus())
      .catch((error: unknown) => {
        this.handleError(error)
        return this.getStatus()
      })
      .finally(() => {
        this.downloadPromise = undefined
      })
    this.downloadPromise = operation
    return operation
  }

  async restartAndInstall(): Promise<void> {
    if (this.status.phase !== 'downloaded') {
      throw new Error('The Kody update has not finished downloading.')
    }
    this.stop()
    await this.beforeInstall()
    this.updater.quitAndInstall(false, true)
  }

  private handleError(error: unknown): void {
    if (this.automaticCheck) {
      this.setStatus({ phase: 'idle' })
      return
    }
    this.setStatus({
      phase: 'error',
      checkedAt: new Date().toISOString(),
      detail: safeUpdateError(error)
    })
  }

  private setStatus(update: Omit<DesktopUpdateStatus, 'currentVersion'>): void {
    this.status = {
      ...update,
      currentVersion: this.status.currentVersion
    }
    this.onStatus(this.getStatus())
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10
}

function safeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim()
  return (firstLine || 'Kody could not check for updates.').slice(0, 500)
}
