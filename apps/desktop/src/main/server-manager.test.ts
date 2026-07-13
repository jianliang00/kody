import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  KodyServerManager,
  findCargoWorkspaceRoot,
  reserveLoopbackPort,
  resolveLaunchCommand,
  sanitizedChildEnvironment,
  trustedCodexAuthUrl
} from './server-manager'

describe('server manager helpers', () => {
  it('finds the Cargo workspace from the desktop package', () => {
    const root = findCargoWorkspaceRoot([process.cwd()])
    expect(root).not.toBeNull()
    expect(basename(root!)).toBe('kody')
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
      expect.arrayContaining([expect.stringMatching(/^(cargo|kody-app-server(?:\.exe)?)$/)])
    )
    expect([...launch.args, launch.command].join(' ')).not.toContain('KODY_SERVER_TOKEN')
  })

  it('asks the OS for an ephemeral loopback port', async () => {
    const port = await reserveLoopbackPort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
  })

  it('waits for the complete connection bootstrap even after the socket opens', async () => {
    let releaseBootstrap!: () => void
    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    const manager = new KodyServerManager({
      appPath: '/unused',
      isPackaged: false,
      resourcesPath: '/unused',
      stateRoot: '/unused',
      onEvent: () => undefined,
      onProcessEvent: () => undefined,
      onStatus: () => undefined
    })
    const internals = manager as unknown as {
      socket: { readyState: number }
      startPromise: Promise<void>
    }
    internals.socket = { readyState: 1 }
    internals.startPromise = bootstrap

    let settled = false
    const start = manager.start().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseBootstrap()
    await start
    expect(settled).toBe(true)
  })

  it('removes ambient credentials while preserving ordinary development environment', () => {
    expect(sanitizedChildEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'openai-secret',
      KODY_SERVER_TOKEN: 'privileged-control-token',
      AWS_ACCESS_KEY_ID: 'aws-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/google.json',
      PGPASSWORD: 'postgres-secret',
      DATABASE_URL: 'postgres://user:pass@db.example.test/app',
      GITHUB_PAT: 'github-secret',
      CI_JOB_JWT: 'job-secret',
      HTTPS_PROXY: 'https://proxy-user:proxy-pass@proxy.example.test:8443',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      NO_PROXY: '127.0.0.1,localhost'
    })).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/test',
      LANG: 'en_US.UTF-8',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      NO_PROXY: '127.0.0.1,localhost'
    })
  })

  it('allows only official HTTPS Codex authentication origins', () => {
    expect(trustedCodexAuthUrl('https://auth.openai.com/oauth/authorize?state=opaque'))
      .toBe('https://auth.openai.com/oauth/authorize?state=opaque')
    expect(trustedCodexAuthUrl('https://chatgpt.com/auth/codex'))
      .toBe('https://chatgpt.com/auth/codex')

    for (const url of [
      'http://auth.openai.com/oauth/authorize',
      'https://openai.com.evil.test/oauth/authorize',
      'https://evilopenai.com/oauth/authorize',
      'https://user:password@auth.openai.com/oauth/authorize',
      'javascript:alert(1)',
      'not a URL'
    ]) {
      expect(() => trustedCodexAuthUrl(url)).toThrow(/invalid|untrusted/)
    }
  })
})
