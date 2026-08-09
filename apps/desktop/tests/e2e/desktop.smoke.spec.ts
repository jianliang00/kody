import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(testDirectory, '../..')
const workspaceRoot = resolve(desktopRoot, '../..')

interface PersistedState {
  version: number
  projects: Array<{ id: string; name: string; root: string }>
  threads: Array<{ id: string; title: string; workspace_id: string; workflow_state: string }>
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
    const workbenchRail = page.getByRole('complementary', { name: 'Workbench' })
    const assetRail = page.getByRole('complementary', { name: 'Threads' })
    await expect(workbenchRail.getByText('Local server connected', { exact: true })).toBeVisible({ timeout: 30_000 })
    const rightRail = page.locator('#right-rail')
    const conversationWorkspace = page.locator('.conversation-workspace')
    const openModelSettings = workbenchRail.getByRole('button', { name: 'Open model settings' })
    const connectionStatus = workbenchRail.locator('.workbench-connection')
    const updateCapsule = workbenchRail.getByRole('button', { name: 'Kody updates unavailable' })
    await expect(openModelSettings).toBeVisible()
    await expect(updateCapsule).toBeVisible()
    const [updateCapsuleBox, connectionStatusBox] = await Promise.all([
      updateCapsule.boundingBox(),
      connectionStatus.boundingBox()
    ])
    const updateCapsuleStyle = await updateCapsule.evaluate((element) => ({
      borderRadius: getComputedStyle(element).borderRadius,
      copyWhiteSpace: getComputedStyle(element.querySelector('.update-status__copy')!).whiteSpace,
      fontSize: getComputedStyle(element).fontSize,
      fontWeight: getComputedStyle(element).fontWeight
    }))
    const connectionStatusStyle = await connectionStatus.evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      fontWeight: getComputedStyle(element).fontWeight
    }))
    expect(updateCapsuleBox).not.toBeNull()
    expect(connectionStatusBox).not.toBeNull()
    expect(updateCapsuleBox?.x ?? 0).toBeGreaterThan((connectionStatusBox?.x ?? 0) + (connectionStatusBox?.width ?? 0))
    expect(Math.abs(
      ((updateCapsuleBox?.y ?? 0) + (updateCapsuleBox?.height ?? 0) / 2)
      - ((connectionStatusBox?.y ?? 0) + (connectionStatusBox?.height ?? 0) / 2)
    )).toBeLessThanOrEqual(1)
    expect(updateCapsuleBox?.height ?? Infinity).toBeLessThanOrEqual(30)
    expect(updateCapsuleStyle).toEqual({
      borderRadius: '999px',
      copyWhiteSpace: 'nowrap',
      fontSize: '13px',
      fontWeight: '400'
    })
    expect(connectionStatusStyle).toEqual({ fontSize: '11px', fontWeight: '400' })
    await expect(updateCapsule).toHaveText('Unavailable')
    await expect(updateCapsule.locator('.update-status__chevron')).toHaveCount(0)
    await expect(page.locator('.titlebar').getByRole('button', { name: 'Open model settings' })).toHaveCount(0)

    const assetResizeHandle = page.getByRole('separator', { name: 'Resize Thread list' })
    const rightResizeHandle = page.getByRole('separator', { name: 'Resize right sidebar' })
    await expect(assetResizeHandle).toBeVisible()
    await expect(rightResizeHandle).toBeVisible()
    await expect(assetResizeHandle).toHaveAttribute('aria-controls', 'asset-rail')
    await expect(rightResizeHandle).toHaveAttribute('aria-controls', 'right-rail')
    const [initialWorkbenchBox, initialAssetRailBox, initialTitlebarBox, initialConversationBox, initialLayoutRightRailBox] = await Promise.all([
      workbenchRail.boundingBox(),
      assetRail.boundingBox(),
      page.locator('.titlebar').boundingBox(),
      conversationWorkspace.boundingBox(),
      rightRail.boundingBox()
    ])
    expect(initialWorkbenchBox).not.toBeNull()
    expect(initialAssetRailBox).not.toBeNull()
    expect(initialTitlebarBox).not.toBeNull()
    expect(initialConversationBox).not.toBeNull()
    expect(initialLayoutRightRailBox).not.toBeNull()
    expect(Math.round(initialWorkbenchBox?.width ?? 0)).toBe(216)
    expect(initialWorkbenchBox?.x ?? Infinity).toBeLessThan(initialAssetRailBox?.x ?? 0)
    expect(initialAssetRailBox?.x ?? Infinity).toBeLessThan(initialConversationBox?.x ?? 0)
    expect(initialConversationBox?.x ?? Infinity).toBeLessThan(initialLayoutRightRailBox?.x ?? 0)
    expect((initialWorkbenchBox?.x ?? 0) + (initialWorkbenchBox?.width ?? 0)).toBeLessThanOrEqual((initialAssetRailBox?.x ?? 0) + 1)
    expect((initialAssetRailBox?.x ?? 0) + (initialAssetRailBox?.width ?? 0)).toBeLessThanOrEqual((initialConversationBox?.x ?? 0) + 1)
    expect((initialConversationBox?.x ?? 0) + (initialConversationBox?.width ?? 0)).toBeLessThanOrEqual((initialLayoutRightRailBox?.x ?? 0) + 1)
    expect(Math.abs((initialTitlebarBox?.x ?? 0) - (initialConversationBox?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs(
      (initialTitlebarBox?.x ?? 0) + (initialTitlebarBox?.width ?? 0)
      - ((initialLayoutRightRailBox?.x ?? 0) + (initialLayoutRightRailBox?.width ?? 0))
    )).toBeLessThanOrEqual(1)
    expect(Math.abs(
      (initialTitlebarBox?.y ?? 0) + (initialTitlebarBox?.height ?? 0)
      - (initialLayoutRightRailBox?.y ?? 0)
    )).toBeLessThanOrEqual(1)
    expect(Math.abs((initialConversationBox?.y ?? 0) - (initialLayoutRightRailBox?.y ?? 0))).toBeLessThanOrEqual(1)
    const initialAssetRailWidth = Math.round(initialAssetRailBox?.width ?? 0)
    const initialRightRailWidth = Math.round(initialLayoutRightRailBox?.width ?? 0)
    expect(initialAssetRailWidth).toBe(272)
    expect(initialRightRailWidth).toBe(320)

    const collapseWorkbench = workbenchRail.getByRole('button', { name: 'Collapse workbench sidebar' })
    await collapseWorkbench.click()
    await expect(workbenchRail).toBeHidden()
    await expect(assetRail).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('kody.workbenchCollapsed'))).toBe('true')
    const expandWorkbench = page.locator('.titlebar').getByRole('button', { name: 'Expand workbench sidebar' })
    await expect(expandWorkbench).toBeFocused()
    await expandWorkbench.click()
    await expect(workbenchRail).toBeVisible()
    await expect.poll(async () => Math.round((await workbenchRail.boundingBox())?.width ?? 0)).toBe(216)
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('kody.workbenchCollapsed'))).toBe('false')

    // Pointer drag behavior is covered by the focused component tests. Use the
    // separator's accessible keyboard contract here so the Electron integration
    // remains deterministic under GitHub Actions' virtual display server.
    await assetResizeHandle.focus()
    const assetResizeMaximum = Number(await assetResizeHandle.getAttribute('aria-valuemax'))
    const resizedAssetWidth = Math.min(320, assetResizeMaximum)
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('ArrowRight')
    }
    await expect.poll(async () => Math.round((await assetRail.boundingBox())?.width ?? 0)).toBe(resizedAssetWidth)
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('kody.assetRailWidth'))).toBe(String(resizedAssetWidth))
    await page.keyboard.press('ArrowLeft')
    const persistedAssetWidth = resizedAssetWidth - 8
    await expect.poll(async () => Math.round((await assetRail.boundingBox())?.width ?? 0)).toBe(persistedAssetWidth)

    await rightResizeHandle.focus()
    const rightResizeMaximum = Number(await rightResizeHandle.getAttribute('aria-valuemax'))
    const resizedRightWidth = Math.min(368, rightResizeMaximum)
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('ArrowLeft')
    }
    await expect.poll(async () => Math.round((await rightRail.boundingBox())?.width ?? 0)).toBe(resizedRightWidth)
    await page.keyboard.press('ArrowRight')
    const persistedRightWidth = resizedRightWidth - 8
    await expect.poll(async () => Math.round((await rightRail.boundingBox())?.width ?? 0)).toBe(persistedRightWidth)
    await expect.poll(() => page.evaluate(() => ({
      left: window.localStorage.getItem('kody.assetRailWidth'),
      right: window.localStorage.getItem('kody.rightRailWidth')
    }))).toEqual({ left: String(persistedAssetWidth), right: String(persistedRightWidth) })
    if (process.env.KODY_QA_RESIZE_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_RESIZE_SCREENSHOT, animations: 'disabled' })
    }

    await page.reload()
    await expect(workbenchRail.getByText('Local server connected', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => Math.round((await assetRail.boundingBox())?.width ?? 0)).toBe(persistedAssetWidth)
    await expect.poll(async () => Math.round((await rightRail.boundingBox())?.width ?? 0)).toBe(persistedRightWidth)
    if (process.env.KODY_QA_UPDATES_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_UPDATES_SCREENSHOT, animations: 'disabled' })
    }

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
    expect(selectSurface.borderRadius).toBe('8px')
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
    const closedFieldSurfaces = await providerSettings.evaluate((dialog) => {
      const input = dialog.querySelector<HTMLInputElement>('input[name="base-url"]')
      const select = dialog.querySelector<HTMLElement>('.kody-select__trigger--field')
      if (!input || !select) throw new Error('Missing provider field controls')
      const surface = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderTopColor,
          borderRadius: style.borderRadius,
          borderWidth: style.borderTopWidth,
          minHeight: style.minHeight,
          fontSize: style.fontSize
        }
      }
      return { input: surface(input), select: surface(select) }
    })
    expect(closedFieldSurfaces.select).toEqual(closedFieldSurfaces.input)
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
    if (process.env.KODY_QA_DARK_SETTINGS_SCREENSHOT) {
      await page.locator('html').evaluate((element) => { element.dataset.theme = 'dark' })
      await page.screenshot({ path: process.env.KODY_QA_DARK_SETTINGS_SCREENSHOT, animations: 'disabled' })
      await page.locator('html').evaluate((element) => { element.dataset.theme = 'light' })
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
      const [windowDragBox, primaryActionsBox] = await Promise.all([
        workbenchRail.locator('.workbench-rail__window-drag').boundingBox(),
        workbenchRail.locator('.workbench-rail__primary-actions').boundingBox()
      ])
      expect(windowDragBox).not.toBeNull()
      expect(primaryActionsBox).not.toBeNull()
      expect(primaryActionsBox?.y ?? 0).toBeGreaterThanOrEqual((windowDragBox?.y ?? 0) + (windowDragBox?.height ?? 0) - 1)
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
    expect(typography.composerHeight).toBeLessThanOrEqual(58)
    expect(typography.sendButtonWeight).toBe('500')
    await expect(page.getByRole('button', { name: 'Working directory', exact: true })).toBeVisible()
    const permissionMode = page.getByLabel('Permission mode')
    await expect(permissionMode).toHaveAttribute('data-value', 'ask')
    await selectKodyOption(page, 'Permission mode', 'Read only')
    await expect(permissionMode).toHaveAttribute('data-value', 'read_only')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('No Threads in New Progress', { exact: true })).toBeVisible()

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
    await expect(projectShelf.getByRole('button', { name: 'Projects', exact: true })).toBeVisible()
    await expect(projectShelf.locator('.right-rail-disclosure__badge .count-pill')).toHaveText('0')
    await expect(projectShelf.getByText('No Projects yet.', { exact: true })).toBeVisible()
    const initialShelfBox = await projectShelf.boundingBox()
    const initialRightRailBox = await rightRail.boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(initialShelfBox).not.toBeNull()
    expect(initialRightRailBox).not.toBeNull()
    expect(initialShelfBox?.x ?? 0).toBeGreaterThan(viewport.width / 2)
    expect(initialShelfBox?.x ?? 0).toBeGreaterThanOrEqual(initialRightRailBox?.x ?? 0)
    expect(initialShelfBox?.width ?? Infinity).toBeLessThanOrEqual(initialRightRailBox?.width ?? 0)

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
    const providerTrigger = page.getByRole('combobox', { name: 'Provider' })
    const modelTrigger = page.getByRole('combobox', { name: 'Model' })
    await expect(page.getByText('Uses the Codex agent loop and tools for this Turn.')).toHaveCount(0)
    const selectTextInsets = await page.evaluate(() => {
      const provider = document.querySelector<HTMLElement>('#composer-provider')
      const model = document.querySelector<HTMLElement>('#composer-model')
      if (!provider || !model) throw new Error('Missing composer model controls')
      const insets = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return {
          start: Number.parseFloat(style.paddingInlineStart),
          end: Number.parseFloat(style.paddingInlineEnd)
        }
      }
      return { provider: insets(provider), model: insets(model) }
    })
    expect(selectTextInsets.provider).toEqual(selectTextInsets.model)
    expect(selectTextInsets.provider.start).toBeGreaterThanOrEqual(10)
    expect(selectTextInsets.provider.end).toBeGreaterThanOrEqual(8)
    const addContext = page.getByRole('button', { name: 'Add context' })
    const permissionControl = page.locator('.permission-mode-control')
    await page.mouse.move(800, 300)
    await expect(providerTrigger).toHaveCSS('background-color', 'rgb(246, 246, 246)')
    const compactControlSurfaces = await page.evaluate(() => {
      const provider = document.querySelector<HTMLElement>('#composer-provider')
      const context = document.querySelector<HTMLElement>('.composer .context-button')
      const permission = document.querySelector<HTMLElement>('.permission-mode-control')
      if (!provider || !context || !permission) throw new Error('Missing composer controls')
      const surface = (element: HTMLElement) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderWidth: style.borderTopWidth,
          height: element.getBoundingClientRect().height
        }
      }
      return { provider: surface(provider), context: surface(context), permission: surface(permission) }
    })
    expect(compactControlSurfaces.permission).toEqual(compactControlSurfaces.provider)
    expect(compactControlSurfaces.context).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderRadius: '6px',
      borderWidth: '1px',
      height: 32
    })
    const hoverSurface = async (control: typeof providerTrigger) => {
      await control.hover()
      await expect(control).toHaveCSS('background-color', 'rgb(236, 236, 239)')
      await expect(control).toHaveCSS('border-top-color', 'rgba(60, 60, 67, 0.28)')
      return control.evaluate((element) => {
        const style = getComputedStyle(element)
        return { backgroundColor: style.backgroundColor, borderColor: style.borderTopColor }
      })
    }
    const providerHover = await hoverSurface(providerTrigger)
    const contextHover = await hoverSurface(addContext)
    const permissionHover = await hoverSurface(permissionControl)
    expect(providerHover).toEqual(contextHover)
    expect(permissionHover).toEqual(contextHover)

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
    expect(durable.snapshot.thread.workflow_state).toBe('new_progress')
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

    const workflowAction = page.locator('.titlebar').getByRole('button', { name: 'Mark as Processed' })
    await expect(workflowAction).toBeVisible()
    await workflowAction.click()
    await expect(page.locator('.titlebar').getByRole('button', { name: 'Restore to New Progress' })).toBeVisible()
    await expect(page.getByText('No Threads in New Progress', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(async (threadId) => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      return (await window.kody.rpc('thread/get', { thread_id: threadId })).thread.workflow_state
    }, durable.snapshot.thread.id)).toBe('handled')

    await workbenchRail.getByRole('button', { name: /Processed\s*1/ }).click()
    const processedThreadRow = page.getByRole('navigation', { name: 'Thread list' })
      .locator('.asset-row__open')
      .filter({ hasText: prompt })
    await expect(processedThreadRow).toBeVisible()
    await page.locator('.titlebar').getByRole('button', { name: 'Restore to New Progress' }).click()
    await expect(page.getByText('No Threads in Processed', { exact: true })).toBeVisible()
    await workbenchRail.getByRole('button', { name: /New Progress\s*1/ }).click()
    await expect(processedThreadRow).toBeVisible()
    await expect.poll(() => page.evaluate(async (threadId) => {
      if (!window.kody) throw new Error('preload bridge is unavailable')
      return (await window.kody.rpc('thread/get', { thread_id: threadId })).thread.workflow_state
    }, durable.snapshot.thread.id)).toBe('new_progress')

    const contextCard = page.locator('#thread-context-card')
    await expect(contextCard).toBeVisible()
    const contextToggle = contextCard.getByRole('button', { name: 'Context', exact: true })
    await expect(contextToggle).toBeVisible()
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'true')
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
        eyebrow: fontSize('.right-rail-disclosure__eyebrow'),
        heading: fontSize('.right-rail-disclosure__title'),
        metricLabel: fontSize('.thread-context-card__metric dt'),
        metricValue: fontSize('.thread-context-card__metric dd'),
        groupLabel: fontSize('.thread-context-card__group-label'),
        itemName: fontSize('.thread-context-card__group li strong'),
        itemDetail: fontSize('.thread-context-card__group li > span:last-child'),
        emptyState: fontSize('.thread-context-card__empty'),
        processEmpty: fontSize('.thread-context-card__process-empty'),
        metricLabelsFit: Object.fromEntries(
          [...card.querySelectorAll<HTMLElement>('.thread-context-card__metric dt')]
            .map((element) => [element.textContent?.trim() ?? '', element.scrollWidth <= element.clientWidth])
        )
      }
    })
    expect(contextTypography).toEqual({
      eyebrow: '14px',
      heading: '13px',
      metricLabel: '13px',
      metricValue: '13px',
      groupLabel: '13px',
      itemName: '13px',
      itemDetail: '12px',
      emptyState: '13px',
      processEmpty: '13px',
      metricLabelsFit: {
        Threads: true,
        Projects: true,
        'Managed procs': true
      }
    })
    if (process.env.KODY_QA_CONTEXT_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_CONTEXT_SCREENSHOT, animations: 'disabled' })
    }
    const inspector = page.getByLabel('Thread context and activity')
    await expect(inspector).toBeVisible()
    const workspaceToggle = inspector.getByRole('button', { name: 'Workspace', exact: true })
    const referencesToggle = inspector.getByRole('button', { name: 'Active references', exact: true })
    const changesToggle = inspector.getByRole('button', { name: 'Changed files', exact: true })
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(referencesToggle).toHaveAttribute('aria-expanded', 'false')

    await workspaceToggle.focus()
    await page.keyboard.press('Enter')
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(referencesToggle).toHaveAttribute('aria-expanded', 'false')
    const completeWorkspacePath = inspector.locator('.workspace-card .path-copy code')
    await expect(completeWorkspacePath).toBeVisible()
    await expect(completeWorkspacePath).toHaveText(durable.snapshot.workspace.root)

    await referencesToggle.focus()
    await page.keyboard.press('Space')
    await expect(referencesToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    await changesToggle.click()
    await expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => page.evaluate(() => JSON.parse(
      window.localStorage.getItem('kody.rightRailSections.v1') ?? '{}'
    ))).toMatchObject({ context: true, workspace: true, references: true, changes: true, projects: true })

    await page.reload()
    await expect(workbenchRail.getByText('Local server connected', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(referencesToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(changesToggle).toHaveAttribute('aria-expanded', 'true')

    const rightRailHeadingOffsets = await page.locator('#right-rail').evaluate((rail) => {
      const railLeft = rail.getBoundingClientRect().left
      const selectors = [
        '#thread-context-card .right-rail-disclosure__eyebrow',
        '#right-rail-workspace .right-rail-disclosure__eyebrow',
        '#right-rail-references .right-rail-disclosure__eyebrow',
        '#right-rail-projects .right-rail-disclosure__eyebrow'
      ]
      return selectors.map((selector) => {
        const element = rail.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing right rail alignment fixture: ${selector}`)
        return element.getBoundingClientRect().left - railLeft
      })
    })
    expect(Math.max(...rightRailHeadingOffsets) - Math.min(...rightRailHeadingOffsets)).toBeLessThanOrEqual(1.1)
    const changedFilesEmptyOffset = await inspector.locator('#right-rail-changes').evaluate((disclosure) => {
      const summary = disclosure.querySelector('.right-rail-disclosure__title')
      const empty = disclosure.querySelector('.inspector-empty')
      if (!(summary instanceof HTMLElement) || !(empty instanceof HTMLElement)) {
        throw new Error('Missing Changed files alignment fixture')
      }
      return Math.abs(summary.getBoundingClientRect().left - empty.getBoundingClientRect().left)
    })
    expect(changedFilesEmptyOffset).toBeLessThanOrEqual(1.1)
    if (process.env.KODY_QA_INSPECTOR_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_INSPECTOR_SCREENSHOT, animations: 'disabled' })
    }
    const applicationTypography = await page.evaluate(() => {
      const fontSize = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing typography fixture: ${selector}`)
        return getComputedStyle(element).fontSize
      }
      const fontWeight = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing typography fixture: ${selector}`)
        return getComputedStyle(element).fontWeight
      }
      return {
        body: [
          '.asset-row__topline strong',
          '.message--assistant .markdown',
          '.composer textarea',
          '.workspace-card .right-rail-disclosure__title',
          '.project-shelf__copy strong'
        ].map(fontSize),
        caption: [
          '.asset-row__project',
          '.message > header',
          '.workspace-card > .right-rail-disclosure__panel > p',
          '.project-shelf__copy span'
        ].map(fontSize),
        windowTitle: fontSize('.titlebar__identity h1'),
        workbenchAction: fontSize('.workbench-new-thread span'),
        sidebarWeights: {
          workbenchSection: fontWeight('.workbench-section > h2'),
          workbenchItem: fontWeight('.workbench-row > span:nth-child(2)'),
          threadHeading: fontWeight('.asset-rail__heading h2'),
          threadItem: fontWeight('.asset-row__topline strong'),
          inspectorDisclosure: fontWeight('.right-rail-disclosure__title'),
          inspectorSubheading: fontWeight('.thread-context-card__group-label'),
          projectItem: fontWeight('.project-shelf__copy strong')
        }
      }
    })
    expect(applicationTypography).toEqual({
      body: ['13px', '14px', '14px', '13px', '13px'],
      caption: ['12px', '13px', '12px', '12px'],
      windowTitle: '13px',
      workbenchAction: '13px',
      sidebarWeights: {
        workbenchSection: '500',
        workbenchItem: '400',
        threadHeading: '500',
        threadItem: '600',
        inspectorDisclosure: '500',
        inspectorSubheading: '500',
        projectItem: '500'
      }
    })
    if (process.env.KODY_QA_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_SCREENSHOT, animations: 'disabled' })
    }
    if (process.env.KODY_QA_DARK_SCREENSHOT) {
      await page.getByRole('button', { name: 'Use dark theme' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.screenshot({ path: process.env.KODY_QA_DARK_SCREENSHOT, animations: 'disabled' })
      await page.getByRole('button', { name: 'Use light theme' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    }
    await workspaceToggle.click()
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(workspaceToggle).toBeFocused()
    await expect(referencesToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(completeWorkspacePath).toBeHidden()
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'true')

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
        workspaceTop: workspace.getBoundingClientRect().top,
        scrollClientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        titlebarTop: titlebar.getBoundingClientRect().top,
        titlebarHeight: titlebar.getBoundingClientRect().height,
        composerBottom: composerDock.getBoundingClientRect().bottom,
        windowScrollY: scrollY,
        documentScrollTop: document.scrollingElement?.scrollTop ?? -1
      }
    })
    expect(longConversationBefore.shellHeight).toBe(viewport.height)
    expect(Math.round(longConversationBefore.workspaceHeight + longConversationBefore.titlebarHeight)).toBe(viewport.height)
    expect(Math.abs(longConversationBefore.workspaceTop - longConversationBefore.titlebarHeight)).toBeLessThanOrEqual(1)
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

    await projectShelf.scrollIntoViewIfNeeded()
    await expect(projectShelf.getByRole('button', { name: 'Projects', exact: true })).toBeVisible()
    await expect(projectShelf.locator('.right-rail-disclosure__badge .count-pill')).toHaveText('1')
    await expect(projectShelf.getByText(durable.projects[0]?.name ?? '', { exact: true })).toBeVisible()
    await expect(projectShelf.getByTitle(canonicalProjectRoot)).toBeVisible()
    await expect(projectShelf.getByText('Added', { exact: true })).toBeVisible()
    const populatedShelfBox = await projectShelf.boundingBox()
    expect(populatedShelfBox).not.toBeNull()
    expect(populatedShelfBox?.x ?? 0).toBeGreaterThan(viewport.width / 2)
    expect(populatedShelfBox?.width ?? Infinity).toBeLessThanOrEqual(initialRightRailBox?.width ?? 0)

    const threadNavigation = page.getByRole('navigation', { name: 'Thread list' })
    const durableThreadRow = threadNavigation.locator('.asset-row__open').filter({ hasText: prompt })
    await expect(durableThreadRow).toBeVisible()
    const persisted = JSON.parse(
      await readFile(join(actualUserDataRoot, 'engine', 'state.json'), 'utf8')
    ) as PersistedState
    expect(persisted.projects).toHaveLength(1)
    expect(persisted.version).toBe(5)
    expect(persisted.threads).toHaveLength(1)
    expect(persisted.workspaces).toHaveLength(1)
    expect(persisted.turns).toHaveLength(1)
    expect(persisted.turns[0]?.permission_mode).toBe('read_only')
    expect(persisted.messages).toHaveLength(2)
    expect(persisted.threads[0]?.title).toBe(prompt)
    expect(persisted.threads[0]?.workflow_state).toBe('new_progress')
    expect(persisted.threads[0]?.id).toBe(durable.snapshot.thread.id)
    expect(persisted.workspaces[0]?.thread_id).toBe(durable.snapshot.thread.id)

    // Opening and abandoning another draft must not leave an empty Thread or Workspace.
    await workbenchRail.getByRole('button', { name: 'New Thread', exact: true }).click()
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

    // Repeated focus commands must work even when every desktop sidebar state is already settled.
    await composer.focus()
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('kody:menu-command', 'focus-assets')
    })
    await expect(page.locator('#asset-filter')).toBeFocused()
    await composer.focus()
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('kody:menu-command', 'focus-assets')
    })
    await expect(page.locator('#asset-filter')).toBeFocused()

    // Menu commands that redirect focus must dismiss the narrow Projects modal first.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 700)
    })
    const projectLauncher = page.locator('.project-shelf-launcher')
    await expect(projectLauncher).toBeVisible()
    await projectLauncher.click()
    await expect(projectShelf).toHaveAttribute('aria-modal', 'true')
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('kody:menu-command', 'focus-assets')
    })
    await expect(projectShelf).toBeHidden()
    await expect(page.locator('#asset-filter')).toBeFocused()
    const navigationRails = page.locator('#navigation-rails')
    await expect(navigationRails).toBeVisible()
    await expect(navigationRails).toHaveAttribute('role', 'dialog')
    await expect(navigationRails).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await assetRail.getByRole('button', { name: 'Close navigation drawer' }).click()
    await expect(navigationRails).toBeHidden()
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)

    // Keep a compact responsive smoke for both independent drawers.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(700, 700)
    })
    await expect(page.getByRole('separator', { name: 'Resize Thread list' })).toHaveCount(0)
    await expect(page.getByRole('separator', { name: 'Resize right sidebar' })).toHaveCount(0)
    const openAssetDrawer = page.getByRole('button', { name: 'Open navigation drawer' })
    await expect(assetRail).toBeHidden()
    await expect(workbenchRail).toBeHidden()
    await openAssetDrawer.click()
    await expect(assetRail).toBeVisible()
    await expect(workbenchRail).toBeVisible()
    await expect(assetRail.getByRole('button', { name: 'Close navigation drawer' })).toBeVisible()
    await expect(navigationRails).toHaveAttribute('role', 'dialog')
    await expect(navigationRails).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    const assetDrawerLayers = await page.evaluate(() => ({
      drawer: getComputedStyle(document.querySelector('.navigation-rails')!).zIndex,
      scrim: getComputedStyle(document.querySelector('.drawer-scrim')!).zIndex
    }))
    expect(assetDrawerLayers).toEqual({ drawer: '41', scrim: '40' })
    await page.keyboard.press('Escape')
    await expect(assetRail).toBeHidden()
    await expect(openAssetDrawer).toBeFocused()

    await expect(projectLauncher).toBeVisible()
    await projectLauncher.click()
    await expect(projectShelf).toBeVisible()
    await expect(projectShelf).toHaveAttribute('role', 'dialog')
    await expect(projectShelf).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(projectShelf).toBeHidden()
    await expect(projectLauncher).toBeFocused()

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
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    const closeInspector = page.getByRole('button', { name: 'Hide right sidebar' })
    await expect(closeInspector).toHaveAttribute('aria-expanded', 'true')
    await expect(inspector.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible()
    const processDisclosure = inspector.getByRole('button', { name: 'Background processes', exact: true })
    await expect(processDisclosure).toBeVisible()
    await processDisclosure.click()
    await expect(processDisclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(inspector.getByText('No managed background processes.', { exact: true })).toBeVisible()
    const inspectorDrawerLayers = await page.evaluate(() => ({
      rail: getComputedStyle(document.querySelector('.right-rail')!).zIndex,
      drawer: getComputedStyle(document.querySelector('.inspector')!).zIndex,
      scrim: getComputedStyle(document.querySelector('.drawer-scrim')!).zIndex
    }))
    expect(inspectorDrawerLayers).toEqual({ rail: '31', drawer: '31', scrim: '30' })
    if (process.env.KODY_QA_COMPACT_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_COMPACT_SCREENSHOT, animations: 'disabled' })
    }
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
