import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateStatus } from '../shared/bridge'
import { KodyUpdateManager } from './update-manager'

afterEach(() => vi.useRealTimers())

describe('KodyUpdateManager', () => {
  it('checks, downloads, reports progress, and prepares the app before installing', async () => {
    const updater = new FakeUpdater()
    const statuses: DesktopUpdateStatus[] = []
    const beforeInstall = vi.fn(async () => undefined)
    const manager = createManager(updater, statuses, { beforeInstall })

    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.2.0' })
      return null
    })
    await manager.check(true)
    expect(manager.getStatus()).toMatchObject({
      phase: 'available',
      currentVersion: '0.1.1',
      availableVersion: '0.2.0'
    })

    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42.26, transferred: 42, total: 100 })
      updater.emit('update-downloaded', { version: '0.2.0' })
      return ['/tmp/update.zip']
    })
    await manager.download()
    expect(statuses).toContainEqual(expect.objectContaining({
      phase: 'downloading',
      percent: 42.3,
      transferred: 42,
      total: 100
    }))
    expect(manager.getStatus()).toMatchObject({ phase: 'downloaded', percent: 100 })

    await manager.restartAndInstall()
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(updater.invocationOrder()).toEqual(['prepare', 'install'])
  })

  it('keeps scheduled network failures silent but surfaces a failed manual check', async () => {
    const updater = new FakeUpdater()
    const manager = createManager(updater)
    updater.checkForUpdates.mockRejectedValue(new Error('release host unavailable'))

    await manager.check(false)
    expect(manager.getStatus()).toEqual({ phase: 'idle', currentVersion: '0.1.1' })

    await manager.check(true)
    expect(manager.getStatus()).toMatchObject({
      phase: 'error',
      detail: 'release host unavailable'
    })
  })

  it('does not access the updater in unpackaged builds', async () => {
    const updater = new FakeUpdater()
    const manager = new KodyUpdateManager({
      updater: updater as never,
      currentVersion: '0.1.1',
      enabled: false,
      onStatus: vi.fn()
    })

    manager.start()
    await manager.check(true)
    expect(manager.getStatus().phase).toBe('disabled')
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})

function createManager(
  updater: FakeUpdater,
  statuses: DesktopUpdateStatus[] = [],
  options: { beforeInstall?: () => Promise<void> } = {}
): KodyUpdateManager {
  const order: string[] = []
  const beforeInstall = options.beforeInstall
  return new KodyUpdateManager({
    updater: updater as never,
    currentVersion: '0.1.1',
    enabled: true,
    onStatus: (status) => statuses.push(status),
    beforeInstall: beforeInstall
      ? async () => {
          order.push('prepare')
          updater.order = order
          await beforeInstall()
        }
      : undefined
  })
}

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = false
  allowPrerelease = true
  allowDowngrade = true
  order: string[] = []
  checkForUpdates = vi.fn(async (): Promise<null> => null)
  downloadUpdate = vi.fn(async (): Promise<string[]> => [])
  quitAndInstall = vi.fn(() => this.order.push('install'))

  invocationOrder(): string[] {
    return this.order
  }
}
