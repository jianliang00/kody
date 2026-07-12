import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(testDirectory, '../..')
const workspaceRoot = resolve(desktopRoot, '../..')

function isolatedEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )

  // The smoke test is deterministic and must never consume a developer's model credentials.
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CODY_OPENAI_') || key.startsWith('OPENAI_')) delete environment[key]
  }
  delete environment.CODY_HOME
  delete environment.ELECTRON_RENDERER_URL
  environment.NODE_ENV = 'production'
  return environment
}

test('uses the real preload bridge and creates an isolated Thread Workspace', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cody-electron-e2e-'))
  const userDataRoot = join(temporaryRoot, 'profile')
  let application: ElectronApplication | undefined

  try {
    application = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${userDataRoot}`],
      cwd: workspaceRoot,
      env: isolatedEnvironment(),
      timeout: 30_000
    })

    const actualUserDataRoot = await application.evaluate(({ app }) => app.getPath('userData'))
    expect(actualUserDataRoot).toBe(await realpath(userDataRoot))

    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    expect(page.url()).toMatch(/^file:/)

    await expect(page.getByLabel('Local server connected')).toBeVisible({ timeout: 30_000 })

    const bridgeProbe = await page.evaluate(async () => {
      if (!window.cody) return null
      const status = await window.cody.getServerStatus()
      const initialized = await window.cody.rpc('initialize', {})
      return {
        platform: window.cody.platform,
        status,
        serverName: initialized.server_info.name
      }
    })
    expect(bridgeProbe).not.toBeNull()
    expect(bridgeProbe?.status.phase).toBe('connected')
    expect(bridgeProbe?.serverName).toBe('cody-app-server')
    expect(bridgeProbe?.platform).toBe(process.platform)

    await expect(
      page.getByRole('heading', { name: 'Start with a conversation or a code asset' })
    ).toBeVisible()
    await expect(page.getByText('No Threads yet', { exact: true })).toBeVisible()

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(700, 700)
    })
    const assetRail = page.getByLabel('Cody assets')
    const openAssetDrawer = page.getByRole('button', { name: 'Open asset drawer' })
    await expect(assetRail).toBeHidden()
    await openAssetDrawer.click()
    await expect(assetRail).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(assetRail).toBeHidden()
    await expect(openAssetDrawer).toBeFocused()

    const title = `Electron smoke ${Date.now()}`
    await page.locator('.start-card--thread').click()
    const dialog = page.getByRole('dialog', { name: 'New Thread' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Thread title').fill(title)
    await dialog.getByRole('button', { name: 'Create Thread', exact: true }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByLabel('Conversation')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What should Cody work on?' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Message composer' })).toBeVisible()
    await openAssetDrawer.click()
    await expect(
      page.getByRole('navigation', { name: 'Threads and Projects' }).getByRole('button', { name: new RegExp(title) })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(assetRail).toBeHidden()

    const inspector = page.getByLabel('Thread context and activity')
    const openInspector = page.getByRole('button', { name: 'Open context inspector' })
    await expect(inspector).toBeHidden()
    await openInspector.click()
    await expect(inspector).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(inspector).toBeHidden()
    await expect(openInspector).toBeFocused()
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1380, 880)
    })

    const durableSnapshot = await page.evaluate(async (threadTitle) => {
      if (!window.cody) throw new Error('preload bridge is unavailable')
      const { threads } = await window.cody.rpc('thread/list', {})
      const thread = threads.find((candidate) => candidate.title === threadTitle)
      if (!thread) throw new Error('created Thread was not returned by the app server')
      return window.cody.rpc('thread/get', { thread_id: thread.id })
    }, title)
    expect(durableSnapshot.workspace.root).toContain(join(actualUserDataRoot, 'engine', 'workspaces'))
    await expect(page.locator('.workspace-card code')).toHaveText(durableSnapshot.workspace.root)
    await access(join(durableSnapshot.workspace.root, 'artifacts'))
    await access(join(durableSnapshot.workspace.root, 'tmp'))

    const message = 'Hello from the isolated Electron smoke test.'
    await page.getByRole('combobox', { name: 'Message' }).fill(message)
    await page.getByLabel('Provider').selectOption('echo')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.message--user').filter({ hasText: message })).toBeVisible()
    await expect(
      page.locator('.message--assistant:not(.message--live)').filter({ hasText: message })
    ).toBeVisible({ timeout: 20_000 })

    const state = await readFile(join(actualUserDataRoot, 'engine', 'state.json'), 'utf8')
    expect(state).toContain(title)
    expect(state).toContain(durableSnapshot.thread.id)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
