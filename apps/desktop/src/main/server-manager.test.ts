import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { findCargoWorkspaceRoot, reserveLoopbackPort, resolveLaunchCommand } from './server-manager'

describe('server manager helpers', () => {
  it('finds the Cargo workspace from the desktop package', () => {
    const root = findCargoWorkspaceRoot([process.cwd()])
    expect(root).not.toBeNull()
    expect(basename(root!)).toBe('cody')
    expect(findCargoWorkspaceRoot([join(root!, 'apps', 'desktop', 'src', 'main')])).toBe(root)
  })

  it('resolves a development app-server launch without embedding credentials', () => {
    const root = findCargoWorkspaceRoot([process.cwd()])!
    const launch = resolveLaunchCommand({
      appPath: join(root, 'apps', 'desktop'),
      isPackaged: false,
      resourcesPath: join(root, 'unused-resources')
    })
    expect(launch.cwd).toBe(root)
    expect([basename(launch.command), launch.command]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(cargo|cody-app-server(?:\.exe)?)$/)])
    )
    expect([...launch.args, launch.command].join(' ')).not.toContain('CODY_SERVER_TOKEN')
  })

  it('asks the OS for an ephemeral loopback port', async () => {
    const port = await reserveLoopbackPort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
  })
})
