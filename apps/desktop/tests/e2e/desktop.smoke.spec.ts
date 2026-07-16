import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
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
  turns: Array<{ id: string; thread_id: string; status: string; permission_mode: string }>
}

async function selectKodyOption(page: Page, label: string | RegExp, option: string): Promise<void> {
  const trigger = page.getByRole('combobox', { name: label })
  await trigger.click()
  await expect(page.locator('.kody-select__content')).toBeVisible()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
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
    const consoleProblems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleProblems.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`))
    await page.waitForLoadState('domcontentloaded')
    expect(page.url()).toMatch(/^file:/)
    expect(await page.title()).toBe('Kody')
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await expect(page.getByLabel('Local server connected')).toBeVisible({ timeout: 30_000 })
    const assetRail = page.getByLabel('Kody assets')
    const applicationControls = assetRail.getByLabel('Application controls')
    const openModelSettings = applicationControls.getByRole('button', { name: 'Open model settings' })
    const updateCapsule = applicationControls.getByRole('button', { name: 'Kody updates unavailable' })
    await expect(openModelSettings).toBeVisible()
    await expect(updateCapsule).toBeVisible()
    const [updateCapsuleBox, applicationControlsBox] = await Promise.all([
      updateCapsule.boundingBox(),
      applicationControls.boundingBox()
    ])
    const updateCapsuleStyle = await updateCapsule.evaluate((element) => ({
      borderRadius: getComputedStyle(element).borderRadius,
      copyWhiteSpace: getComputedStyle(element.querySelector('.update-status__copy')!).whiteSpace
    }))
    expect(updateCapsuleBox).not.toBeNull()
    expect(applicationControlsBox).not.toBeNull()
    expect(updateCapsuleBox?.width ?? Infinity).toBeLessThan(applicationControlsBox?.width ?? 0)
    expect(updateCapsuleBox?.height ?? Infinity).toBeLessThanOrEqual(36)
    expect(updateCapsuleStyle).toEqual({ borderRadius: '999px', copyWhiteSpace: 'nowrap' })
    await expect(page.locator('.titlebar').getByRole('button', { name: 'Open model settings' })).toHaveCount(0)
    await openModelSettings.click()
    const providerSettings = page.getByRole('dialog', { name: 'Provider settings' })
    await expect(providerSettings).toBeVisible()
    const settingsTypography = await providerSettings.evaluate((dialog) => {
      const fontSize = (selector: string) => {
        const element = dialog.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing typography fixture: ${selector}`)
        return getComputedStyle(element).fontSize
      }
      return {
        headerCopy: fontSize('.provider-settings__header > div > p:last-child'),
        navigationAction: fontSize('.provider-profile-add'),
        navigationEmpty: fontSize('.provider-profile-nav > p'),
        fieldLabel: fontSize('.provider-field > label')
      }
    })
    expect(settingsTypography).toEqual({
      headerCopy: '14px',
      navigationAction: '14px',
      navigationEmpty: '13px',
      fieldLabel: '13px'
    })
    const providerKind = providerSettings.getByRole('combobox', { name: /Provider kind/ })
    await providerKind.click()
    const selectContent = page.locator('.kody-select__content')
    await expect(selectContent).toBeVisible()
    const selectSurface = await selectContent.evaluate((content) => {
      const item = content.querySelector('.kody-select__item')
      if (!(item instanceof HTMLElement)) throw new Error('Missing Kody select item')
      return {
        borderRadius: getComputedStyle(content).borderRadius,
        boxShadow: getComputedStyle(content).boxShadow,
        itemFontSize: getComputedStyle(item).fontSize,
        itemMinHeight: getComputedStyle(item).minHeight
      }
    })
    expect(selectSurface.borderRadius).toBe('10px')
    expect(selectSurface.boxShadow).not.toBe('none')
    expect(selectSurface.itemFontSize).toBe('14px')
    expect(selectSurface.itemMinHeight).toBe('36px')
    if (process.env.KODY_QA_SELECT_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_SELECT_SCREENSHOT, animations: 'disabled' })
    }
    await page.getByRole('option', { name: 'OpenAI-compatible', exact: true }).click()
    await expect(providerKind).toHaveAttribute('data-value', 'openai-compatible')
    await selectKodyOption(page, /Provider kind/, 'OpenAI API')
    await expect(providerKind).toHaveAttribute('data-value', 'openai')
    await providerKind.focus()
    await page.keyboard.press('ArrowDown')
    await expect(selectContent).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(selectContent).toHaveCount(0)
    await expect(providerSettings).toBeVisible()
    await expect(providerKind).toBeFocused()
    const settingsControlTops = async () => {
      const controls = {
        profileName: providerSettings.getByLabel(/Profile name/),
        providerKind: providerSettings.getByLabel('Provider kind'),
        defaultModel: providerSettings.getByLabel(/Default model/),
        customModels: providerSettings.getByLabel('Custom models')
      }
      const entries = await Promise.all(Object.entries(controls).map(async ([name, control]) => {
        const box = await control.boundingBox()
        expect(box, `${name} should have a layout box`).not.toBeNull()
        return [name, box!.y] as const
      }))
      return Object.fromEntries(entries) as Record<keyof typeof controls, number>
    }
    const expectSettingsRowsAligned = (tops: Awaited<ReturnType<typeof settingsControlTops>>) => {
      expect(Math.abs(tops.profileName - tops.providerKind)).toBeLessThanOrEqual(1)
      expect(Math.abs(tops.defaultModel - tops.customModels)).toBeLessThanOrEqual(1)
    }
    expectSettingsRowsAligned(await settingsControlTops())
    await providerSettings.getByRole('button', { name: 'Save provider' }).click()
    await expect(providerSettings.getByText('Enter a profile name.')).toBeVisible()
    expectSettingsRowsAligned(await settingsControlTops())
    if (process.env.KODY_QA_SETTINGS_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_SETTINGS_SCREENSHOT, animations: 'disabled' })
    }
    await page.getByRole('button', { name: 'Close provider settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Provider settings' })).toHaveCount(0)
    await expect(openModelSettings).toBeFocused()

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

    if (bridgeProbe?.platform === 'darwin') {
      const [windowDragBox, brandBox] = await Promise.all([
        assetRail.locator('.asset-rail__window-drag').boundingBox(),
        assetRail.locator('.asset-rail__brand').boundingBox()
      ])
      expect(windowDragBox).not.toBeNull()
      expect(brandBox).not.toBeNull()
      expect(brandBox?.y ?? 0).toBeGreaterThanOrEqual((windowDragBox?.y ?? 0) + (windowDragBox?.height ?? 0) - 1)
    }

    await expect(page.getByRole('heading', { level: 1, name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What should Kody work on?' })).toBeVisible()
    await expect(page.getByRole('form', { name: 'Message composer' })).toBeVisible()
    const composer = page.getByRole('combobox', { name: 'Message' })
    await expect(composer).toHaveAttribute('rows', '2')
    const typography = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      const sendButton = textarea.form?.querySelector<HTMLButtonElement>('.turn-button')
      return {
        bodyFontSize: getComputedStyle(document.body).fontSize,
        composerHeight: textarea.getBoundingClientRect().height,
        composerMinHeight: getComputedStyle(textarea).minHeight,
        sendButtonWeight: sendButton ? getComputedStyle(sendButton).fontWeight : ''
      }
    })
    expect(typography.bodyFontSize).toBe('14px')
    expect(typography.composerMinHeight).toBe('48px')
    expect(typography.composerHeight).toBeLessThanOrEqual(56)
    expect(typography.sendButtonWeight).toBe('500')
    await expect(page.getByRole('button', { name: 'Working directory', exact: true })).toBeVisible()
    const permissionMode = page.getByLabel('Permission mode')
    await expect(permissionMode).toHaveAttribute('data-value', 'ask')
    await selectKodyOption(page, 'Permission mode', 'Read only')
    await expect(permissionMode).toHaveAttribute('data-value', 'read_only')
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
    await composer.fill(prompt)
    await selectKodyOption(page, 'Provider', 'Echo')
    await expect(page.getByRole('combobox', { name: 'Provider' })).toHaveAttribute('data-value', 'echo')
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveAttribute('data-value', 'echo')

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
    expect(durable.snapshot.turns[0]?.permission_mode).toBe('read_only')
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
    const contextTypography = await contextCard.evaluate((card) => {
      const fontSize = (selector: string) => {
        const element = card.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing Context typography fixture: ${selector}`)
        return getComputedStyle(element).fontSize
      }
      return {
        eyebrow: fontSize('.eyebrow'),
        heading: fontSize('.thread-context-card__header h2'),
        metricLabel: fontSize('.thread-context-card__metric dt'),
        metricValue: fontSize('.thread-context-card__metric dd'),
        groupLabel: fontSize('.thread-context-card__group-label'),
        itemName: fontSize('.thread-context-card__group li strong'),
        itemDetail: fontSize('.thread-context-card__group li > span:last-child'),
        emptyState: fontSize('.thread-context-card__empty'),
        processEmpty: fontSize('.thread-context-card__process-empty'),
        workspacePath: fontSize('.thread-context-card__footer > span'),
        metricLabelsFit: Object.fromEntries(
          [...card.querySelectorAll<HTMLElement>('.thread-context-card__metric dt')]
            .map((element) => [element.textContent?.trim() ?? '', element.scrollWidth <= element.clientWidth])
        )
      }
    })
    expect(contextTypography).toEqual({
      eyebrow: '14px',
      heading: '14px',
      metricLabel: '14px',
      metricValue: '14px',
      groupLabel: '14px',
      itemName: '14px',
      itemDetail: '14px',
      emptyState: '14px',
      processEmpty: '14px',
      workspacePath: '14px',
      metricLabelsFit: {
        Threads: true,
        Projects: true,
        'Managed procs': true
      }
    })
    if (process.env.KODY_QA_CONTEXT_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_CONTEXT_SCREENSHOT, animations: 'disabled' })
    }
    const rightRail = page.locator('#right-rail')
    const expandContentActivity = contextCard.getByRole('button', { name: 'Expand Content & activity' })
    await expect(expandContentActivity).toBeVisible()
    await expect(page.locator('.titlebar').getByRole('button', { name: 'Expand Content & activity' })).toHaveCount(0)
    await expandContentActivity.click()
    const inspector = page.getByLabel('Thread context and activity')
    await expect(inspector).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Collapse Content & activity' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Context & activity', exact: true })).toBeVisible()
    const applicationTypography = await page.evaluate(() => {
      const fontSize = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing typography fixture: ${selector}`)
        return getComputedStyle(element).fontSize
      }
      return {
        body: [
          '.asset-row__body strong',
          '.titlebar__identity h1',
          '.message--assistant .markdown',
          '.composer textarea',
          '.workspace-card h3',
          '.project-shelf__copy strong'
        ].map(fontSize),
        caption: [
          '.asset-row__body span',
          '.message > header',
          '.workspace-card > p',
          '.project-shelf__copy span'
        ].map(fontSize),
        brandHeading: fontSize('.brand-lockup strong')
      }
    })
    expect(applicationTypography).toEqual({
      body: Array(6).fill('14px'),
      caption: Array(4).fill('13px'),
      brandHeading: '17px'
    })
    if (process.env.KODY_QA_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_SCREENSHOT, animations: 'disabled' })
    }
    await inspector.getByRole('button', { name: 'Collapse Content & activity' }).click()
    await expect(inspector).toBeHidden()
    await expect(expandContentActivity).toBeFocused()

    const hideRightSidebar = page.getByRole('button', { name: 'Hide right sidebar' })
    await expect(hideRightSidebar).toHaveAttribute('aria-controls', 'right-rail')
    await expect(hideRightSidebar).toHaveAttribute('aria-expanded', 'true')
    await hideRightSidebar.click()
    await expect(rightRail).toBeHidden()
    const showRightSidebar = page.getByRole('button', { name: 'Show right sidebar' })
    await expect(showRightSidebar).toHaveAttribute('aria-expanded', 'false')
    await showRightSidebar.click()
    await expect(rightRail).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide right sidebar' })).toBeFocused()

    const longConversationBefore = await page.evaluate(() => {
      const column = document.querySelector('.conversation-column')
      const spacer = document.querySelector('.conversation-end-spacer')
      const messages = [...document.querySelectorAll('.message')]
      if (!column || !spacer || messages.length === 0) throw new Error('Conversation fixture unavailable')
      for (let index = 0; index < 24; index += 1) {
        for (const message of messages) {
          const clone = message.cloneNode(true)
          if (!(clone instanceof HTMLElement)) throw new Error('Message clone is not an element')
          clone.classList.add('scroll-regression-clone')
          column.insertBefore(clone, spacer)
        }
      }
      const scroll = document.querySelector('.conversation-scroll')
      const shell = document.querySelector('.app-shell')
      const workspace = document.querySelector('.conversation-workspace')
      const titlebar = document.querySelector('.titlebar')
      const composerDock = document.querySelector('.composer-dock')
      if (!(scroll instanceof HTMLElement) || !shell || !workspace || !titlebar || !composerDock) {
        throw new Error('Conversation layout unavailable')
      }
      scroll.scrollTop = 0
      return {
        shellHeight: shell.getBoundingClientRect().height,
        workspaceHeight: workspace.getBoundingClientRect().height,
        scrollClientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        titlebarTop: titlebar.getBoundingClientRect().top,
        composerBottom: composerDock.getBoundingClientRect().bottom,
        windowScrollY: scrollY,
        documentScrollTop: document.scrollingElement?.scrollTop ?? -1
      }
    })
    expect(longConversationBefore.shellHeight).toBe(viewport.height)
    expect(longConversationBefore.workspaceHeight).toBe(viewport.height)
    expect(longConversationBefore.scrollHeight).toBeGreaterThan(longConversationBefore.scrollClientHeight)
    expect(longConversationBefore.titlebarTop).toBe(0)
    expect(longConversationBefore.composerBottom).toBe(viewport.height)
    expect(longConversationBefore.windowScrollY).toBe(0)
    expect(longConversationBefore.documentScrollTop).toBe(0)

    const conversationScroll = page.getByLabel('Conversation')
    await conversationScroll.hover()
    await page.mouse.wheel(0, 900)
    await expect.poll(() => conversationScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const longConversationAfter = await page.evaluate(() => ({
      shellTop: document.querySelector('.app-shell')?.getBoundingClientRect().top,
      titlebarTop: document.querySelector('.titlebar')?.getBoundingClientRect().top,
      composerBottom: document.querySelector('.composer-dock')?.getBoundingClientRect().bottom,
      windowScrollY: scrollY,
      documentScrollTop: document.scrollingElement?.scrollTop ?? -1
    }))
    expect(longConversationAfter).toEqual({
      shellTop: 0,
      titlebarTop: 0,
      composerBottom: viewport.height,
      windowScrollY: 0,
      documentScrollTop: 0
    })
    await page.evaluate(() => {
      document.querySelectorAll('.scroll-regression-clone').forEach((element) => element.remove())
    })

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
    expect(persisted.turns[0]?.permission_mode).toBe('read_only')
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

    const multilinePrompt = [
      'First output line',
      'Second output line',
      '',
      '- first list item',
      '- second list item',
      '',
      '```text',
      'alpha',
      'beta',
      '```'
    ].join('\n')
    const completedAssistantMessages = page.locator('.message--assistant:not(.message--live)')
    const assistantCount = await completedAssistantMessages.count()
    await composer.fill(multilinePrompt)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(completedAssistantMessages).toHaveCount(assistantCount + 1, { timeout: 20_000 })
    const multilineAssistant = completedAssistantMessages.last()
    const firstOutputParagraph = multilineAssistant.locator('.markdown p').first()
    await expect(firstOutputParagraph).toContainText('First output line')
    await expect(firstOutputParagraph).toContainText('Second output line')
    await expect(firstOutputParagraph.locator('br')).toHaveCount(1)
    await expect(multilineAssistant.locator('.markdown li')).toHaveCount(2)
    await expect(multilineAssistant.locator('.markdown pre code')).toContainText('alpha\nbeta')
    if (process.env.KODY_QA_LINEBREAK_SCREENSHOT) {
      await multilineAssistant.scrollIntoViewIfNeeded()
      await page.screenshot({ path: process.env.KODY_QA_LINEBREAK_SCREENSHOT, animations: 'disabled' })
    }

    // Keep a compact responsive smoke for both independent drawers.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(700, 700)
    })
    const openAssetDrawer = page.getByRole('button', { name: 'Open asset drawer' })
    await expect(assetRail).toBeHidden()
    await openAssetDrawer.click()
    await expect(assetRail).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(assetRail).toBeHidden()
    await expect(openAssetDrawer).toBeFocused()

    const openInspector = page.getByRole('button', { name: 'Show right sidebar' })
    await expect(contextCard).toBeHidden()
    await expect(inspector).toBeHidden()
    await expect(openInspector).toHaveAttribute('aria-controls', 'right-rail')
    await expect(openInspector).toHaveAttribute('aria-expanded', 'false')
    await openInspector.focus()
    await page.keyboard.press('Enter')
    await expect(inspector).toBeVisible()
    await expect(inspector).toHaveAttribute('role', 'dialog')
    await expect(inspector).toHaveAttribute('aria-modal', 'true')
    const closeInspector = page.getByRole('button', { name: 'Hide right sidebar' })
    await expect(closeInspector).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Background processes', exact: true })).toBeVisible()
    await expect(inspector.getByText('No managed background processes.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(inspector).toBeHidden()
    const reopenInspector = page.getByRole('button', { name: 'Show right sidebar' })
    await expect(reopenInspector).toHaveAttribute('aria-expanded', 'false')
    await expect(reopenInspector).toBeFocused()
    expect(consoleProblems).toEqual([])
  } finally {
    await application?.close().catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
