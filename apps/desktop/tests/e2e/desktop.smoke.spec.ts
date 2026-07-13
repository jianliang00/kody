import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(testDirectory, '../..')
const workspaceRoot = resolve(desktopRoot, '../..')

interface PersistedState {
  projects: Array<{ id: string; name: string; root: string }>
  threads: Array<{ id: string; title: string; workspace_id: string }>
  workspaces: Array<{ id: string; thread_id: string; root: string }>
  messages: Array<{ id: string; thread_id: string; role: string }>
  turns: Array<{ id: string; thread_id: string; status: string }>
}

function isolatedEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )

  // The smoke test is deterministic and must never consume a developer's model credentials.
  for (const key of Object.keys(environment)) {
    if (key.startsWith('KODY_OPENAI_') || key.startsWith('OPENAI_')) delete environment[key]
  }
  delete environment.KODY_HOME
  delete environment.ELECTRON_RENDERER_URL
  environment.NODE_ENV = 'production'
  return environment
}

test('creates the first Thread through one idempotent draft request', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'kody-electron-e2e-'))
  const userDataRoot = join(temporaryRoot, 'profile')
  const selectedProjectRoot = join(temporaryRoot, 'selected-project')
  await mkdir(selectedProjectRoot)
  await writeFile(join(selectedProjectRoot, 'README.md'), '# Isolated E2E project\n')
  const canonicalProjectRoot = await realpath(selectedProjectRoot)
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
      if (!window.kody) return null
      const status = await window.kody.getServerStatus()
      const initialized = await window.kody.rpc('initialize', {})
      return {
        platform: window.kody.platform,
        status,
        serverName: initialized.server_info.name,
        capabilities: initialized.capabilities,
        hasProcessEvents: typeof window.kody.onProcessEvent === 'function'
      }
    })
    expect(bridgeProbe).not.toBeNull()
    expect(bridgeProbe?.status.phase).toBe('connected')
    expect(bridgeProbe?.serverName).toBe('kody-app-server')
    expect(bridgeProbe?.platform).toBe(process.platform)
    expect(bridgeProbe?.capabilities.thread_create_and_start).toBe(true)
    expect(bridgeProbe?.capabilities.managed_processes).toBe(true)
    expect(bridgeProbe?.capabilities.process_output).toBe(true)
    expect(bridgeProbe?.hasProcessEvents).toBe(true)

    await expect(page.getByRole('heading', { level: 1, name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What should Kody work on?' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Message composer' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Working directory', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('No Threads yet', { exact: true })).toBeVisible()

    const emptyBackend = await page.evaluate(async () => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      const [{ threads }, { projects }] = await Promise.all([
        window.kody.rpc('thread/list', {}),
        window.kody.rpc('project/list', {})
      ])
      return { threads, projects }
    })
    expect(emptyBackend.threads).toHaveLength(0)
    expect(emptyBackend.projects).toHaveLength(0)
    expect(await readdir(join(actualUserDataRoot, 'engine', 'workspaces'))).toHaveLength(0)

    const projectShelf = page.locator('#project-shelf')
    await expect(projectShelf).toBeVisible()
    await expect(projectShelf.getByRole('heading', { name: 'Projects 0' })).toBeVisible()
    await expect(projectShelf.getByText('No Projects yet.', { exact: true })).toBeVisible()
    const initialShelfBox = await projectShelf.boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(initialShelfBox).not.toBeNull()
    expect(initialShelfBox?.x ?? 0).toBeGreaterThan(viewport.width / 2)
    expect(initialShelfBox?.y ?? 0).toBeGreaterThan(viewport.height / 2)
    expect(Math.abs((initialShelfBox?.y ?? 0) + (initialShelfBox?.height ?? 0) - viewport.height)).toBeLessThan(3)
    expect(Math.abs((initialShelfBox?.x ?? 0) + (initialShelfBox?.width ?? 0) - viewport.width)).toBeLessThan(3)

    // Stub only the native picker. The renderer still traverses the real preload and IPC boundary.
    await application.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [directory] })
      })
    }, selectedProjectRoot)
    await page.getByRole('button', { name: 'Working directory', exact: true }).click()
    const workingDirectoryChip = page.locator('.working-directory-chip')
    await expect(workingDirectoryChip).toBeVisible()
    await expect(workingDirectoryChip).toContainText(selectedProjectRoot)
    await expect(workingDirectoryChip.getByRole('button', { name: 'Clear working directory' })).toBeVisible()

    const stagedOnly = await page.evaluate(async () => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      const [{ threads }, { projects }] = await Promise.all([
        window.kody.rpc('thread/list', {}),
        window.kody.rpc('project/list', {})
      ])
      return { threadCount: threads.length, projectCount: projects.length }
    })
    expect(stagedOnly).toEqual({ threadCount: 0, projectCount: 0 })
    expect(await readdir(join(actualUserDataRoot, 'engine', 'workspaces'))).toHaveLength(0)

    const prompt = 'Explain the provider neutral agent loop'
    const composer = page.getByRole('combobox', { name: 'Message' })
    await composer.fill(prompt)
    await page.getByLabel('Provider').selectOption('echo')

    // Two synchronous clicks exercise both renderer guarding and server request idempotency.
    await page.getByRole('button', { name: 'Send', exact: true }).evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })

    await expect(page.locator('.message--user').filter({ hasText: prompt })).toBeVisible()
    await expect(
      page.locator('.message--assistant:not(.message--live)').filter({ hasText: prompt })
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible({ timeout: 20_000 })

    const durable = await page.evaluate(async () => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      const [{ threads }, { projects }] = await Promise.all([
        window.kody.rpc('thread/list', {}),
        window.kody.rpc('project/list', {})
      ])
      const [thread] = threads
      if (threads.length !== 1 || !thread) throw new Error(`expected one Thread, received ${threads.length}`)
      const snapshot = await window.kody.rpc('thread/get', { thread_id: thread.id })
      const processResult = await window.kody.rpc('process/list', { thread_id: thread.id })
      return { threads, projects, snapshot, processResult }
    })
    expect(durable.threads).toHaveLength(1)
    expect(durable.projects).toHaveLength(1)
    expect(durable.snapshot.turns).toHaveLength(1)
    expect(durable.snapshot.turns[0]?.status).toBe('completed')
    expect(durable.snapshot.messages).toHaveLength(2)
    expect(durable.snapshot.processes).toEqual([])
    expect(durable.processResult.processes).toEqual([])
    expect(durable.snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(durable.snapshot.thread.title).toBe(prompt)
    expect(durable.snapshot.workspace.thread_id).toBe(durable.snapshot.thread.id)
    expect(durable.snapshot.workspace.root).toContain(join(actualUserDataRoot, 'engine', 'workspaces'))
    expect(durable.projects[0]?.root).toBe(canonicalProjectRoot)
    expect(durable.snapshot.thread.default_references).toEqual([
      { kind: 'project', project_id: durable.projects[0]?.id, access: 'read_write' }
    ])
    await access(join(durable.snapshot.workspace.root, 'artifacts'))
    await access(join(durable.snapshot.workspace.root, 'tmp'))
    expect(await readdir(join(actualUserDataRoot, 'engine', 'workspaces'))).toEqual([
      durable.snapshot.thread.id
    ])

    const contextCard = page.locator('#thread-context-card')
    await expect(contextCard).toBeVisible()
    await expect(contextCard.getByRole('heading', { name: 'Context', exact: true })).toBeVisible()
    await expect(contextCard.getByText('Threads', { exact: true })).toBeVisible()
    await expect(contextCard.getByText('Projects', { exact: true })).toBeVisible()
    await expect(contextCard.getByText('Managed procs', { exact: true })).toBeVisible()
    await expect(contextCard.getByLabel('Referenced Projects')).toContainText(durable.projects[0]?.name ?? '')
    await expect(contextCard.getByLabel('Referenced Projects')).toContainText('Read & write')
    await expect(contextCard.getByText('No active managed processes', { exact: true })).toBeVisible()
    const contextCardBox = await contextCard.boundingBox()
    expect(contextCardBox).not.toBeNull()
    expect(contextCardBox?.x ?? 0).toBeGreaterThan(viewport.width / 2)
    expect(contextCardBox?.y ?? viewport.height).toBeLessThan(viewport.height / 2)

    await expect(projectShelf.getByRole('heading', { name: 'Projects 1' })).toBeVisible()
    await expect(projectShelf.getByText(durable.projects[0]?.name ?? '', { exact: true })).toBeVisible()
    await expect(projectShelf.getByTitle(canonicalProjectRoot)).toBeVisible()
    await expect(projectShelf.getByText('Added', { exact: true })).toBeVisible()
    const populatedShelfBox = await projectShelf.boundingBox()
    expect(populatedShelfBox).not.toBeNull()
    expect(populatedShelfBox?.x ?? 0).toBeGreaterThan(viewport.width / 2)
    expect(populatedShelfBox?.y ?? 0).toBeGreaterThan(viewport.height / 2)
    expect(Math.abs((populatedShelfBox?.y ?? 0) + (populatedShelfBox?.height ?? 0) - viewport.height)).toBeLessThan(3)
    expect((contextCardBox?.y ?? 0) + (contextCardBox?.height ?? 0)).toBeLessThan(populatedShelfBox?.y ?? 0)

    const threadNavigation = page.getByRole('navigation', { name: 'Threads' })
    const durableThreadRow = threadNavigation.getByRole('button', { name: new RegExp(prompt) })
    await expect(durableThreadRow).toBeVisible()
    const persisted = JSON.parse(
      await readFile(join(actualUserDataRoot, 'engine', 'state.json'), 'utf8')
    ) as PersistedState
    expect(persisted.projects).toHaveLength(1)
    expect(persisted.threads).toHaveLength(1)
    expect(persisted.workspaces).toHaveLength(1)
    expect(persisted.turns).toHaveLength(1)
    expect(persisted.messages).toHaveLength(2)
    expect(persisted.threads[0]?.title).toBe(prompt)
    expect(persisted.threads[0]?.id).toBe(durable.snapshot.thread.id)
    expect(persisted.workspaces[0]?.thread_id).toBe(durable.snapshot.thread.id)

    // Opening and abandoning another draft must not leave an empty Thread or Workspace.
    await page.getByRole('button', { name: 'New Thread', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'New conversation' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Message' }).fill('This draft must not be persisted')
    await durableThreadRow.click()
    await expect(page.getByRole('heading', { level: 1, name: prompt })).toBeVisible()
    const afterAbandonedDraft = await page.evaluate(async (threadId) => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      const { threads } = await window.kody.rpc('thread/list', {})
      const snapshot = await window.kody.rpc('thread/get', { thread_id: threadId })
      return { threadCount: threads.length, turnCount: snapshot.turns.length, messageCount: snapshot.messages.length }
    }, durable.snapshot.thread.id)
    expect(afterAbandonedDraft).toEqual({ threadCount: 1, turnCount: 1, messageCount: 2 })
    expect(await readdir(join(actualUserDataRoot, 'engine', 'workspaces'))).toEqual([
      durable.snapshot.thread.id
    ])

    // Keep a compact responsive smoke for both independent drawers.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(700, 700)
    })
    const assetRail = page.getByLabel('Kody assets')
    const openAssetDrawer = page.getByRole('button', { name: 'Open asset drawer' })
    await expect(assetRail).toBeHidden()
    await openAssetDrawer.click()
    await expect(assetRail).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(assetRail).toBeHidden()
    await expect(openAssetDrawer).toBeFocused()

    const inspector = page.getByLabel('Thread context and activity')
    const openInspector = page.getByRole('button', { name: 'Open context inspector' })
    await expect(contextCard).toBeHidden()
    await expect(inspector).toBeHidden()
    await expect(openInspector).toHaveAttribute('aria-controls', 'thread-inspector')
    await expect(openInspector).toHaveAttribute('aria-expanded', 'false')
    await openInspector.focus()
    await page.keyboard.press('Enter')
    await expect(inspector).toBeVisible()
    await expect(inspector).toHaveAttribute('role', 'dialog')
    await expect(inspector).toHaveAttribute('aria-modal', 'true')
    await expect(openInspector).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Background processes', exact: true })).toBeVisible()
    await expect(inspector.getByText('No managed background processes.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(inspector).toBeHidden()
    await expect(openInspector).toHaveAttribute('aria-expanded', 'false')
    await expect(openInspector).toBeFocused()
  } finally {
    await application?.close().catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
