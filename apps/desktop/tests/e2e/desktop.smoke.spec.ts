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
      fontSize: '12px',
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
    const providerSettings = page.getByRole('dialog', { name: 'Settings' })
    await expect(providerSettings).toBeVisible()
    if (process.env.KODY_QA_GENERAL_SETTINGS_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_GENERAL_SETTINGS_SCREENSHOT, animations: 'disabled' })
    }
    const selectedProvider = providerSettings.getByRole('combobox', { name: 'Provider' })
    await selectedProvider.click()
    await page.getByRole('option', { name: /Echo/ }).click()
    await expect(selectedProvider).toHaveAttribute('data-value', 'echo')
    await expect.poll(() => page.evaluate(async () => (
      (await window.kody?.getProviderSettings())?.selectedProviderId
    ))).toBe('echo')
    await providerSettings.getByRole('button', { name: 'Add provider' }).click()
    const settingsTypography = await providerSettings.evaluate((dialog) => {
      const fontSize = (selector: string) => {
        const element = dialog.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing typography fixture: ${selector}`)
        return getComputedStyle(element).fontSize
      }
      return {
        dialogTitle: fontSize('.provider-settings__header h2'),
        sectionTitle: fontSize('.provider-profile-form__heading h3'),
        headerCopy: fontSize('.provider-settings__header > div > p:last-child'),
        navigationLabel: fontSize('.provider-profile-general'),
        navigationAction: fontSize('.provider-profile-add'),
        navigationEmpty: fontSize('.provider-profile-nav > p:not(.provider-profile-nav__heading)'),
        fieldLabel: fontSize('.provider-field > label')
      }
    })
    expect(settingsTypography).toEqual({
      dialogTitle: '17px',
      sectionTitle: '15px',
      headerCopy: '13px',
      navigationLabel: '14px',
      navigationAction: '14px',
      navigationEmpty: '12px',
      fieldLabel: '13px'
    })
    const settingsDialogSurface = await providerSettings.evaluate((dialog) => {
      const style = getComputedStyle(dialog)
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backdropFilter: style.backdropFilter,
        borderRadius: style.borderRadius,
        borderWidth: style.borderTopWidth
      }
    })
    expect(settingsDialogSurface).toMatchObject({
      backgroundImage: 'none',
      backdropFilter: 'none',
      borderRadius: '30px',
      borderWidth: '1px'
    })
    expect(settingsDialogSurface.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')

    const cancelProvider = providerSettings.getByRole('button', { name: 'Close', exact: true })
    const saveProvider = providerSettings.getByRole('button', { name: 'Save provider' })
    const [cancelBox, saveBox] = await Promise.all([cancelProvider.boundingBox(), saveProvider.boundingBox()])
    expect(cancelBox).not.toBeNull()
    expect(saveBox).not.toBeNull()
    expect(cancelBox!.x).toBeLessThan(saveBox!.x)
    const settingsActionSurface = async (control: typeof cancelProvider) => control.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderRadius: style.borderRadius,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width
      }
    })
    const [cancelSurface, saveSurface] = await Promise.all([
      settingsActionSurface(cancelProvider),
      settingsActionSurface(saveProvider)
    ])
    for (const surface of [cancelSurface, saveSurface]) {
      expect(surface.height).toBe(24)
      expect(surface.width).toBeGreaterThanOrEqual(80)
      expect(surface.borderRadius).toBe('6px')
      expect(surface.backgroundImage).toBe('none')
      expect(surface.fontSize).toBe('14px')
      expect(surface.fontWeight).toBe('400')
    }
    expect(saveSurface.backgroundColor).not.toBe(cancelSurface.backgroundColor)
    expect(saveSurface.color).toBe('rgb(0, 0, 0)')
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
    expect(selectSurface.itemFontSize).toBe('13px')
    expect(selectSurface.itemMinHeight).toBe('26px')
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
    await providerSettings.getByRole('button', { name: 'Close provider settings' }).focus()
    const readClosedFieldSurfaces = async () => providerSettings.evaluate((dialog) => {
      const input = dialog.querySelector<HTMLInputElement>('input[name="base-url"]')
      const select = dialog.querySelector<HTMLElement>('.kody-select__trigger--field')
      if (!input || !select) throw new Error('Missing provider field controls')
      const surface = (element: Element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          borderColor: style.borderTopColor,
          borderRadius: style.borderRadius,
          borderWidth: style.borderTopWidth,
          minHeight: style.minHeight,
          fontSize: style.fontSize,
          boxShadow: style.boxShadow,
          height: element.getBoundingClientRect().height
        }
      }
      return { input: surface(input), select: surface(select) }
    })
    await expect.poll(async () => {
      const surfaces = await readClosedFieldSurfaces()
      return JSON.stringify(surfaces.select) === JSON.stringify(surfaces.input)
    }).toBe(true)
    const closedFieldSurfaces = await readClosedFieldSurfaces()
    expect(closedFieldSurfaces.select).toEqual(closedFieldSurfaces.input)
    expect(closedFieldSurfaces.input).toMatchObject({
      backgroundImage: 'none',
      borderRadius: '8px',
      borderWidth: '1px',
      minHeight: '24px',
      fontSize: '14px',
      height: 24
    })
    expect(closedFieldSurfaces.input.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')

    const settingsFocusSurface = async (control: typeof providerKind) => control.evaluate((element) => {
      const style = getComputedStyle(element)
      return { borderColor: style.borderTopColor, boxShadow: style.boxShadow }
    })
    const baseUrlField = providerSettings.getByLabel(/Base URL/)
    await baseUrlField.focus()
    const focusedInputSurface = await settingsFocusSurface(baseUrlField)
    expect(focusedInputSurface.borderColor).not.toBe(closedFieldSurfaces.input.borderColor)
    expect(focusedInputSurface.boxShadow).not.toBe(closedFieldSurfaces.input.boxShadow)
    await expect.poll(async () => (await settingsFocusSurface(baseUrlField)).boxShadow)
      .toMatch(/0px 0px 0px 1px/)
    await providerKind.focus()
    const focusedSelectSurface = await settingsFocusSurface(providerKind)
    expect(focusedSelectSurface.borderColor).not.toBe(closedFieldSurfaces.select.borderColor)
    expect(focusedSelectSurface.boxShadow).not.toBe(closedFieldSurfaces.select.boxShadow)
    await expect.poll(async () => (await settingsFocusSurface(providerKind)).boxShadow)
      .toMatch(/0px 0px 0px 1px/)
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
    const settingsHeaderPosition = await providerSettings.evaluate((dialog) => {
      const header = dialog.querySelector<HTMLElement>('.provider-settings__header')
      if (!header) throw new Error('Missing provider settings header')
      return {
        dialogScrollTop: dialog.scrollTop,
        offset: Math.abs(header.getBoundingClientRect().top - dialog.getBoundingClientRect().top)
      }
    })
    expect(settingsHeaderPosition.dialogScrollTop).toBe(0)
    expect(settingsHeaderPosition.offset).toBeLessThanOrEqual(1)
    if (process.env.KODY_QA_SETTINGS_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_SETTINGS_SCREENSHOT, animations: 'disabled' })
    }
    await page.locator('html').evaluate((element) => { element.dataset.theme = 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(async () => baseUrlField.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe('rgb(35, 40, 41)')
    const darkSettingsSurface = await providerSettings.evaluate((dialog) => {
      const input = dialog.querySelector<HTMLInputElement>('input[name="base-url"]')
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Close')
      const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Save provider'))
      if (!input || !cancel || !save) throw new Error('Missing dark settings controls')
      const surface = (element: Element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color
        }
      }
      return {
        dialog: surface(dialog),
        detail: surface(dialog.querySelector('.provider-settings__content')!),
        input: surface(input),
        cancel: surface(cancel),
        save: surface(save),
        selection: getComputedStyle(input, '::selection').backgroundColor
      }
    })
    expect(darkSettingsSurface.dialog.backgroundColor).toBe('rgb(34, 40, 41)')
    expect(darkSettingsSurface.detail.backgroundColor).toBe('rgb(28, 28, 30)')
    expect(darkSettingsSurface.input.backgroundColor).toBe('rgb(35, 40, 41)')
    expect(darkSettingsSurface.cancel.backgroundColor).toBe('rgb(50, 56, 57)')
    expect(darkSettingsSurface.save.backgroundColor).not.toBe(darkSettingsSurface.cancel.backgroundColor)
    expect(darkSettingsSurface.save.color).toBe('rgb(0, 0, 0)')
    expect(darkSettingsSurface.selection).toBe('rgb(111, 84, 43)')
    for (const surface of [
      darkSettingsSurface.dialog,
      darkSettingsSurface.input,
      darkSettingsSurface.cancel,
      darkSettingsSurface.save
    ]) {
      expect(surface.backgroundImage).toBe('none')
    }
    await baseUrlField.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(baseUrlField).toBeFocused()
    await expect.poll(async () => (await settingsFocusSurface(baseUrlField)).boxShadow)
      .toMatch(/0px 0px 0px 1px/)
    if (process.env.KODY_QA_DARK_SETTINGS_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_DARK_SETTINGS_SCREENSHOT, animations: 'disabled' })
    }
    await page.locator('html').evaluate((element) => { element.dataset.theme = 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const lightBackgrounds = await page.evaluate(() => {
      const background = (selector: string) => {
        const element = document.querySelector(selector)
        if (!(element instanceof HTMLElement)) throw new Error(`Missing light surface fixture: ${selector}`)
        return getComputedStyle(element).backgroundColor
      }
      return {
        conversation: background('.conversation-workspace'),
        threadList: background('.asset-rail'),
        inspector: background('.right-rail'),
        settingsDetail: background('.provider-settings__content'),
        titlebar: background('.titlebar'),
        workbench: background('.workbench-rail')
      }
    })
    expect(lightBackgrounds).toMatchObject({
      conversation: 'rgb(255, 255, 255)',
      threadList: 'rgb(255, 255, 255)',
      inspector: 'rgb(255, 255, 255)',
      settingsDetail: 'rgb(255, 255, 255)'
    })
    expect(lightBackgrounds.titlebar).not.toBe('rgb(255, 255, 255)')
    expect(lightBackgrounds.workbench).not.toBe('rgb(255, 255, 255)')
    await page.getByRole('button', { name: 'Close provider settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
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
    if (process.env.KODY_QA_PERMISSION_MENU_SCREENSHOT) {
      await permissionMode.click()
      await expect(page.locator('.composer-permission-menu')).toBeVisible()
      await page.screenshot({
        path: process.env.KODY_QA_PERMISSION_MENU_SCREENSHOT,
        animations: 'disabled'
      })
      await page.keyboard.press('Escape')
      await expect(page.locator('.composer-permission-menu')).toHaveCount(0)
    }
    await expect(page.getByText('No Threads in New Progress', { exact: true })).toBeVisible()
    const emptyThreadState = page.getByRole('status').filter({ hasText: 'No Threads in New Progress' })
    const emptyThreadStateLayout = await emptyThreadState.evaluate((element) => {
      const navigation = element.closest('.asset-navigation')
      if (!(navigation instanceof HTMLElement)) throw new Error('Missing empty Thread navigation region')
      const style = getComputedStyle(element)
      const emptyBox = element.getBoundingClientRect()
      const navigationBox = navigation.getBoundingClientRect()
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        textAlign: style.textAlign,
        horizontalOffset: Math.abs(
          emptyBox.left + emptyBox.width / 2 - (navigationBox.left + navigationBox.width / 2)
        ),
        verticalOffset: Math.abs(
          emptyBox.top + emptyBox.height / 2 - (navigationBox.top + navigationBox.height / 2)
        )
      }
    })
    expect(emptyThreadStateLayout).toMatchObject({
      fontSize: '13px',
      fontWeight: '400',
      textAlign: 'center'
    })
    expect(Number.parseFloat(emptyThreadStateLayout.lineHeight)).toBeCloseTo(18.2, 1)
    expect(emptyThreadStateLayout.horizontalOffset).toBeLessThanOrEqual(1)
    expect(emptyThreadStateLayout.verticalOffset).toBeLessThanOrEqual(8)

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

    const workbenchProjects = workbenchRail.locator('section[aria-labelledby="workbench-projects-title"]')
    await expect(workbenchProjects.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    await expect(workbenchProjects.getByRole('button', { name: 'Import Project' })).toBeVisible()
    await expect(workbenchProjects.getByText('No Projects yet', { exact: true })).toBeVisible()
    await expect(workbenchProjects.locator('.workbench-project-list')).toHaveCount(0)
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))

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
    const workingDirectoryChipSurface = await workingDirectoryChip.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        height: element.getBoundingClientRect().height,
        borderRadius: style.borderRadius,
        borderWidth: style.borderTopWidth,
        fontSize: style.fontSize,
        boxShadow: style.boxShadow
      }
    })
    expect(workingDirectoryChipSurface).toEqual({
      height: 24,
      borderRadius: '6px',
      borderWidth: '1px',
      fontSize: '13px',
      boxShadow: 'none'
    })

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
    await expect(page.getByRole('combobox', { name: 'Provider' })).toHaveCount(0)
    const modelTrigger = page.locator('#composer-model-menu')
    await expect(modelTrigger).toHaveAttribute('data-model', 'echo')
    await expect(modelTrigger).toHaveAttribute('data-speedy', 'false')
    await expect(modelTrigger).toHaveAttribute('aria-description', /Fast mode (off|unavailable)/)
    await expect(modelTrigger.locator('.model-menu__trigger-leading')).toHaveCount(0)
    await expect(modelTrigger.locator('.model-menu__trigger-fast-icon')).toHaveCount(0)
    await expect(page.getByText('Uses the Codex agent loop and tools for this Turn.')).toHaveCount(0)
    await modelTrigger.focus()
    await page.keyboard.press('ArrowDown')
    const modelSettingsMenu = page.getByRole('menu', { name: 'Model settings' })
    await expect(modelSettingsMenu).toBeVisible()
    await expect(modelTrigger).toHaveAttribute('aria-haspopup', 'menu')
    const modelMenuSurface = await modelSettingsMenu.evaluate((element) => {
      const style = getComputedStyle(element)
      const firstItem = element.querySelector<HTMLElement>('[role="menuitem"]')
      const highlightedItem = element.querySelector<HTMLElement>('[data-highlighted]')
      const highlightedStyle = highlightedItem ? getComputedStyle(highlightedItem) : null
      return {
        width: element.getBoundingClientRect().width,
        backgroundImage: style.backgroundImage,
        borderStyle: style.borderTopStyle,
        borderWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        itemHeight: firstItem?.getBoundingClientRect().height ?? 0,
        highlightedBackground: highlightedStyle?.backgroundColor ?? '',
        highlightedColor: highlightedStyle?.color ?? ''
      }
    })
    const menuSelectionColors = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = 'var(--mac-menu-selection-fill)'
      probe.style.color = 'var(--mac-menu-selection-text)'
      document.body.append(probe)
      const style = getComputedStyle(probe)
      const background = style.backgroundColor
      const text = style.color
      probe.style.backgroundColor = 'var(--mac-primary-fill)'
      probe.style.color = 'var(--mac-primary-contrast)'
      const primaryStyle = getComputedStyle(probe)
      const colors = {
        background,
        text,
        primaryBackground: primaryStyle.backgroundColor,
        primaryText: primaryStyle.color
      }
      probe.remove()
      return colors
    })
    expect(menuSelectionColors.background).toBe(menuSelectionColors.primaryBackground)
    expect(menuSelectionColors.text).toBe(menuSelectionColors.primaryText)
    expect(modelMenuSurface.width).toBeGreaterThanOrEqual(200)
    expect(modelMenuSurface.width).toBeLessThanOrEqual(232)
    expect(modelMenuSurface.backgroundImage).toBe('none')
    expect(modelMenuSurface.borderStyle).toBe('none')
    expect(modelMenuSurface.borderWidth).toBe('0px')
    expect(modelMenuSurface.borderRadius).toBe('8px')
    expect(modelMenuSurface.boxShadow).not.toBe('none')
    expect(modelMenuSurface.itemHeight).toBeGreaterThanOrEqual(23.5)
    expect(modelMenuSurface.itemHeight).toBeLessThanOrEqual(24.5)
    expect(modelMenuSurface.highlightedBackground).toBe(menuSelectionColors.background)
    expect(modelMenuSurface.highlightedColor).toBe(menuSelectionColors.text)
    if (process.env.KODY_QA_MODEL_MENU_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_MODEL_MENU_SCREENSHOT, animations: 'disabled' })
    }
    const modelSubmenuTrigger = modelSettingsMenu.getByRole('menuitem', { name: /^Model:/ })
    await modelSubmenuTrigger.focus()
    await page.keyboard.press('ArrowRight')
    const modelsMenu = page.locator('[role="menu"][aria-label="Models"]')
    await expect(modelsMenu).toBeVisible()
    await modelsMenu.getByRole('menuitemradio').click()
    await expect(modelSettingsMenu).toHaveCount(0)
    await expect(modelTrigger).toBeFocused()
    const modelTextInsets = await modelTrigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        start: Number.parseFloat(style.paddingInlineStart),
        end: Number.parseFloat(style.paddingInlineEnd)
      }
    })
    expect(modelTextInsets.start).toBeGreaterThanOrEqual(6)
    expect(modelTextInsets.end).toBeGreaterThanOrEqual(3)
    const addContext = page.getByRole('button', { name: 'Add context' })
    const permissionControl = page.locator('.permission-mode-control')
    const sendButton = page.getByRole('button', { name: 'Send', exact: true })
    await page.mouse.move(800, 300)
    const readControlSurface = async (control: typeof modelTrigger) => control.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderTopColor,
        borderRadius: style.borderRadius,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        color: style.color,
        outlineWidth: style.outlineWidth,
        height: element.getBoundingClientRect().height
      }
    })
    await composer.focus()
    await expect.poll(async () => page.getByRole('form', { name: 'Message composer' }).evaluate((element) => (
      getComputedStyle(element).boxShadow
    ))).toMatch(/0px 0px 0px 1px/)
    await expect.poll(async () => {
      const [model, permission] = await Promise.all([
        readControlSurface(modelTrigger),
        readControlSurface(permissionControl)
      ])
      return model.backgroundColor === permission.backgroundColor
        && model.backgroundImage === permission.backgroundImage
        && model.borderColor === permission.borderColor
        && model.borderRadius === permission.borderRadius
        && model.borderWidth === permission.borderWidth
        && model.boxShadow === permission.boxShadow
    }).toBe(true)
    const [modelSurface, contextSurface, permissionSurface, sendSurface] = await Promise.all([
      readControlSurface(modelTrigger),
      readControlSurface(addContext),
      readControlSurface(permissionControl),
      readControlSurface(sendButton)
    ])
    const raisedSurface = ({ backgroundColor, backgroundImage, borderColor, borderRadius, borderWidth, boxShadow }: typeof modelSurface) => ({
      backgroundColor,
      backgroundImage,
      borderColor,
      borderRadius,
      borderWidth,
      boxShadow
    })
    expect(raisedSurface(permissionSurface)).toEqual(raisedSurface(modelSurface))
    for (const [name, surface] of Object.entries({ model: modelSurface, permission: permissionSurface, send: sendSurface })) {
      expect(surface.height, `${name} control height`).toBeCloseTo(24, 1)
      expect(surface.borderRadius, `${name} control radius`).toBe('6px')
    }
    expect(modelSurface.borderWidth).toBe('0px')
    expect(permissionSurface.borderWidth).toBe('0px')
    expect(sendSurface.borderWidth).toBe('1px')
    expect(contextSurface.height).toBeCloseTo(24, 1)
    expect(contextSurface.borderRadius).toBe('5px')
    expect(contextSurface.borderWidth).toBe('1px')
    expect(modelSurface.backgroundImage).toBe('none')
    expect(modelSurface.boxShadow).toBe('none')
    expect(permissionSurface.boxShadow).toBe('none')
    expect(contextSurface.backgroundColor).not.toBe(modelSurface.backgroundColor)
    expect(contextSurface.boxShadow).toBe('none')
    expect(sendSurface.backgroundColor).not.toBe(modelSurface.backgroundColor)
    expect(sendSurface.backgroundImage).toBe('none')
    expect(sendSurface.boxShadow).not.toBe('none')
    expect(sendSurface.color).toBe('rgb(0, 0, 0)')

    const modelIndicator = modelTrigger.locator('.model-menu__trigger-indicator')
    const permissionIndicator = permissionControl.locator('.kody-select__trigger-icon')
    const readIndicatorSurface = async (indicator: typeof modelIndicator) => indicator.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        boxShadow: style.boxShadow,
        color: style.color
      }
    })
    const [modelIndicatorSurface, permissionIndicatorSurface, primaryFill] = await Promise.all([
      readIndicatorSurface(modelIndicator),
      readIndicatorSurface(permissionIndicator),
      page.evaluate(() => {
        const probe = document.createElement('span')
        probe.style.backgroundColor = 'var(--mac-primary-fill)'
        document.body.append(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      })
    ])
    expect(permissionIndicatorSurface).toEqual(modelIndicatorSurface)
    expect(modelIndicatorSurface.borderWidth).toBe('0px')
    expect(modelIndicatorSurface.boxShadow).toBe('none')
    expect(modelIndicatorSurface.backgroundColor).not.toBe(primaryFill)

    await modelTrigger.click()
    await expect(modelSettingsMenu).toBeVisible()
    const openModelIndicatorSurface = await readIndicatorSurface(modelIndicator)
    expect(openModelIndicatorSurface.backgroundColor).not.toBe(modelIndicatorSurface.backgroundColor)
    expect(openModelIndicatorSurface.backgroundColor).not.toBe(primaryFill)
    await page.keyboard.press('Escape')
    await expect(modelSettingsMenu).toHaveCount(0)
    await page.mouse.move(800, 300)
    await expect.poll(async () => (await readIndicatorSurface(modelIndicator)).backgroundColor)
      .toBe(modelIndicatorSurface.backgroundColor)

    const hasVisibleFocus = (base: typeof modelSurface, focused: typeof modelSurface) => (
      focused.boxShadow !== base.boxShadow || Number.parseFloat(focused.outlineWidth) > 0
    )
    const expectKeyboardFocus = async (
      focusControl: typeof modelTrigger,
      surfaceControl: typeof modelTrigger,
      base: typeof modelSurface
    ) => {
      await focusControl.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      await expect(focusControl).toBeFocused()
      await expect.poll(async () => hasVisibleFocus(base, await readControlSurface(surfaceControl))).toBe(true)
      await expect.poll(async () => (await readControlSurface(surfaceControl)).boxShadow)
        .toMatch(/0px 0px 0px 1px/)
    }
    await expectKeyboardFocus(modelTrigger, modelTrigger, modelSurface)
    await expectKeyboardFocus(permissionMode, permissionControl, permissionSurface)
    await expectKeyboardFocus(addContext, addContext, contextSurface)
    await expectKeyboardFocus(sendButton, sendButton, sendSurface)

    const hoverSurface = async (control: typeof modelTrigger, base: typeof modelSurface) => {
      await control.hover()
      await expect.poll(async () => (await readControlSurface(control)).backgroundColor)
        .not.toBe(base.backgroundColor)
      return readControlSurface(control)
    }
    await composer.focus()
    const modelHover = await hoverSurface(modelTrigger, modelSurface)
    const contextHover = await hoverSurface(addContext, contextSurface)
    const permissionHover = await hoverSurface(permissionControl, permissionSurface)
    const sendHover = await hoverSurface(sendButton, sendSurface)
    const hoverChrome = ({ backgroundImage, borderRadius, borderWidth, boxShadow }: typeof modelSurface) => ({
      backgroundImage,
      borderRadius,
      borderWidth,
      boxShadow
    })
    expect(hoverChrome(permissionHover)).toEqual(hoverChrome(modelHover))
    expect(modelHover.backgroundColor).not.toBe(modelSurface.backgroundColor)
    expect(permissionHover.backgroundColor).not.toBe(permissionSurface.backgroundColor)
    expect(contextHover.backgroundColor).not.toBe(contextSurface.backgroundColor)
    expect(contextHover.borderColor).toBe(contextSurface.borderColor)
    expect(contextHover.boxShadow).toBe('none')
    expect(sendHover.backgroundColor).not.toBe(sendSurface.backgroundColor)

    await selectKodyOption(page, 'Permission mode', 'Full access')
    await expect(permissionMode).toHaveAttribute('data-value', 'full_access')
    await page.mouse.move(800, 300)
    await composer.focus()
    const permissionDangerColors = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.backgroundColor = 'var(--mac-permission-danger-fill)'
      probe.style.color = 'var(--mac-danger-foreground)'
      document.body.append(probe)
      const base = getComputedStyle(probe)
      const baseFill = base.backgroundColor
      const text = base.color
      probe.style.backgroundColor = 'var(--mac-permission-danger-fill-hover)'
      const hoverFill = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { baseFill, hoverFill, text }
    })
    await expect.poll(async () => (await readControlSurface(permissionControl)).backgroundColor)
      .toBe(permissionDangerColors.baseFill)
    const fullAccessSurface = await readControlSurface(permissionControl)
    const fullAccessIconColor = await permissionControl.locator('.kody-select__leading-icon').evaluate((element) => (
      getComputedStyle(element).color
    ))
    expect(fullAccessSurface.backgroundImage).toBe(permissionSurface.backgroundImage)
    expect(fullAccessSurface.backgroundColor).toBe(permissionDangerColors.baseFill)
    expect(fullAccessSurface.backgroundColor).toBe(permissionSurface.backgroundColor)
    expect(fullAccessSurface.borderWidth).toBe('0px')
    expect(fullAccessSurface.color).toBe(permissionDangerColors.text)
    expect(fullAccessSurface.color).not.toBe(permissionSurface.color)
    expect(fullAccessIconColor).not.toBe(permissionIndicatorSurface.color)
    if (process.env.KODY_QA_FULL_ACCESS_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_FULL_ACCESS_SCREENSHOT, animations: 'disabled' })
    }
    const fullAccessHover = await hoverSurface(permissionControl, fullAccessSurface)
    expect(fullAccessHover.borderWidth).toBe('0px')
    expect(fullAccessHover.borderRadius).toBe(permissionHover.borderRadius)
    expect(fullAccessHover.backgroundImage).toBe(permissionHover.backgroundImage)
    await expect.poll(async () => (await readControlSurface(permissionControl)).backgroundColor)
      .toBe(permissionDangerColors.hoverFill)
    expect(permissionDangerColors.hoverFill).not.toBe(permissionHover.backgroundColor)
    await expect.poll(async () => (await readControlSurface(permissionControl)).color)
      .toBe(permissionDangerColors.text)
    await selectKodyOption(page, 'Permission mode', 'Read only')
    await expect(permissionMode).toHaveAttribute('data-value', 'read_only')
    await expect.poll(async () => permissionControl.locator('.kody-select__leading-icon').evaluate((element) => (
      getComputedStyle(element).color
    ))).not.toBe(fullAccessIconColor)

    // Two synchronous clicks exercise both renderer guarding and server request idempotency.
    await sendButton.evaluate((button) => {
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

    const workflowLabels = [
      { locator: page.locator('.asset-row__badge--new_progress').first(), fontSize: '11px' },
      { locator: page.locator('.conversation-document-header__status--new_progress').first(), fontSize: '12px' }
    ]
    for (const [index, { locator: label, fontSize }] of workflowLabels.entries()) {
      await expect(label).toBeVisible()
      const surface = await label.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          height: element.getBoundingClientRect().height,
          borderRadius: style.borderRadius,
          borderWidth: style.borderTopWidth,
          fontSize: style.fontSize,
          backgroundColor: style.backgroundColor
        }
      })
      expect(surface.height, `workflow label ${index} height`).toBe(20)
      expect(surface.borderRadius, `workflow label ${index} radius`).toBe('999px')
      expect(surface.borderWidth, `workflow label ${index} border`).toBe('1px')
      expect(surface.fontSize, `workflow label ${index} font size`).toBe(fontSize)
      expect(surface.backgroundColor, `workflow label ${index} fill`).not.toBe('rgba(0, 0, 0, 0)')
    }

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
    await expect(contextCard.locator('.thread-context-card__metrics')).toHaveCount(0)
    const referencedProjects = contextCard.getByRole('region', { name: 'Referenced Projects', exact: true })
    await expect(referencedProjects).toContainText(durable.projects[0]?.name ?? '')
    await expect(referencedProjects).toContainText('Read & write')
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
        groupLabel: fontSize('.thread-context-card__group-label'),
        itemName: fontSize('.thread-context-card__group li strong'),
        itemDetail: fontSize('.thread-context-card__group li > span:last-child'),
        emptyState: fontSize('.thread-context-card__empty'),
        processEmpty: fontSize('.thread-context-card__process-empty')
      }
    })
    expect(contextTypography).toEqual({
      eyebrow: '14px',
      heading: '14px',
      groupLabel: '12px',
      itemName: '13px',
      itemDetail: '12px',
      emptyState: '12px',
      processEmpty: '12px'
    })
    if (process.env.KODY_QA_CONTEXT_SCREENSHOT) {
      await page.screenshot({ path: process.env.KODY_QA_CONTEXT_SCREENSHOT, animations: 'disabled' })
    }
    const inspector = page.locator('#thread-inspector')
    await expect(inspector).toBeVisible()
    const workspaceToggle = inspector.getByRole('button', { name: 'Workspace', exact: true })
    const changesToggle = inspector.getByRole('button', { name: 'Changed files', exact: true })
    const projectDetails = contextCard.getByRole('button', { name: /Referenced Projects/ })
    const runtimeDetails = contextCard.getByRole('button', { name: /Runtime/ })
    await expect(inspector.getByRole('button', { name: 'Active references', exact: true })).toHaveCount(0)
    await expect(inspector.getByRole('button', { name: 'Background processes', exact: true })).toHaveCount(0)
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false')

    await workspaceToggle.focus()
    await page.keyboard.press('Enter')
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    const completeWorkspacePath = inspector.locator('.workspace-card .path-copy code')
    await expect(completeWorkspacePath).toBeVisible()
    await expect(completeWorkspacePath).toHaveText(durable.snapshot.workspace.root)
    const workspacePathScroll = inspector.getByRole('region', { name: 'Workspace path' })
    const workspacePathLayout = await workspacePathScroll.evaluate((element) => {
      const code = element.querySelector('code')
      if (!(code instanceof HTMLElement)) throw new Error('Missing Workspace path content')
      const style = getComputedStyle(element)
      const codeStyle = getComputedStyle(code)
      return {
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        whiteSpace: codeStyle.whiteSpace,
        overflowWrap: codeStyle.overflowWrap,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        tabIndex: element.tabIndex
      }
    })
    expect(workspacePathLayout).toMatchObject({
      overflowX: 'auto',
      overflowY: 'hidden',
      whiteSpace: 'nowrap',
      overflowWrap: 'normal',
      tabIndex: 0
    })
    expect(workspacePathLayout.scrollWidth).toBeGreaterThan(workspacePathLayout.clientWidth)
    expect(await workspacePathScroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      return element.scrollLeft
    })).toBeGreaterThan(0)

    await projectDetails.focus()
    await page.keyboard.press('Enter')
    const projectDialog = page.getByRole('dialog', { name: 'Referenced Projects' })
    await expect(projectDialog).toBeVisible()
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await expect(projectDialog.getByRole('button', { name: 'Close Referenced Projects' })).toBeFocused()
    const referenceToken = projectDialog.locator('.reference-chip').first()
    await expect(referenceToken).toBeVisible()
    const referenceTokenSurface = await referenceToken.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        height: element.getBoundingClientRect().height,
        borderRadius: style.borderRadius,
        borderWidth: style.borderTopWidth,
        fontSize: style.fontSize
      }
    })
    expect(referenceTokenSurface.height).toBeCloseTo(24, 0)
    expect(referenceTokenSurface).toMatchObject({
      borderRadius: '6px',
      borderWidth: '1px',
      fontSize: '13px'
    })
    const referencePanelTypography = await projectDialog.locator('.reference-group__label strong').first().evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, fontWeight: style.fontWeight }
    })
    expect(referencePanelTypography).toEqual({ fontSize: '12px', fontWeight: '500' })
    await page.keyboard.press('Escape')
    await expect(projectDialog).toBeHidden()
    await expect(projectDetails).toBeFocused()

    await runtimeDetails.focus()
    await page.keyboard.press('Space')
    const runtimeDialog = page.getByRole('dialog', { name: 'Runtime' })
    await expect(runtimeDialog).toBeVisible()
    await expect(runtimeDialog.getByRole('heading', { name: 'Background processes' })).toBeVisible()
    await expect(runtimeDialog.getByText('No managed background processes.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(runtimeDialog).toBeHidden()
    await expect(runtimeDetails).toBeFocused()

    await changesToggle.click()
    await expect(changesToggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => page.evaluate(() => JSON.parse(
      window.localStorage.getItem('kody.rightRailSections.v1') ?? '{}'
    ))).toEqual({ context: true, workspace: true, changes: true, timeline: false })

    await page.reload()
    await expect(workbenchRail.getByText('Local server connected', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(contextToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(changesToggle).toHaveAttribute('aria-expanded', 'true')

    const rightRailHeadingOffsets = await page.locator('#right-rail').evaluate((rail) => {
      const railLeft = rail.getBoundingClientRect().left
      const selectors = [
        '#thread-context-card .right-rail-disclosure__title',
        '#right-rail-workspace .right-rail-disclosure__title',
        '#right-rail-changes .right-rail-disclosure__title'
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
          '.workbench-project-list .workbench-row > span:nth-child(2)'
        ].map(fontSize),
        caption: [
          '.asset-row__project',
          '.message > header',
          '.workspace-card > .right-rail-disclosure__panel > p',
          '.workbench-project-list .workbench-row__count'
        ].map(fontSize),
        windowTitle: fontSize('.titlebar__identity h1'),
        titlebarAction: fontSize('.titlebar__workflow-action'),
        workbenchAction: fontSize('.workbench-new-thread span'),
        composerModelControl: fontSize('.model-menu__trigger'),
        composerPermissionControl: fontSize('.permission-mode-control'),
        composerSendControl: fontSize('.turn-button'),
        inspectorSectionTitle: fontSize('.workspace-card .right-rail-disclosure__title'),
        sidebarWeights: {
          workbenchSection: fontWeight('.workbench-section > h2'),
          workbenchItem: fontWeight('.workbench-row > span:nth-child(2)'),
          threadHeading: fontWeight('.asset-rail__heading h2'),
          threadItem: fontWeight('.asset-row__topline strong'),
          inspectorDisclosure: fontWeight('.right-rail-disclosure__title'),
          inspectorSubheading: fontWeight('.thread-context-card__group-label'),
          inspectorItem: fontWeight('.thread-context-card__group li strong'),
          projectItem: fontWeight('.workbench-project-list .workbench-row > span:nth-child(2)')
        }
      }
    })
    expect(applicationTypography).toEqual({
      body: ['13px', '14px', '14px', '13px'],
      caption: ['12px', '13px', '12px', '12px'],
      windowTitle: '13px',
      titlebarAction: '13px',
      workbenchAction: '13px',
      composerModelControl: '13px',
      composerPermissionControl: '13px',
      composerSendControl: '13px',
      inspectorSectionTitle: '14px',
      sidebarWeights: {
        workbenchSection: '500',
        workbenchItem: '400',
        threadHeading: '500',
        threadItem: '600',
        inspectorDisclosure: '600',
        inspectorSubheading: '500',
        inspectorItem: '500',
        projectItem: '400'
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

    const projectName = durable.projects[0]?.name ?? ''
    const workbenchProjectList = workbenchProjects.locator('.workbench-project-list')
    const workbenchProject = workbenchProjectList.getByRole('button', { name: new RegExp(projectName) })
    await expect(workbenchProjects.getByText('No Projects yet', { exact: true })).toHaveCount(0)
    await expect(workbenchProjectList.getByRole('listitem')).toHaveCount(1)
    await expect(workbenchProject).toBeVisible()
    await expect(workbenchProject).toHaveAttribute('title', canonicalProjectRoot)
    await expect(workbenchProject.locator('.workbench-row__count')).toHaveText('1')

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

    // Menu commands that redirect focus must open the narrow navigation drawer.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(900, 700)
    })
    await expect.poll(async () => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(1_024)
    const openAssetDrawer = page.getByRole('button', { name: 'Open navigation drawer' })
    await expect(openAssetDrawer).toBeVisible()
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('kody:menu-command', 'focus-assets')
    })
    await expect(page.locator('#asset-filter')).toBeFocused()
    const navigationRails = page.locator('#navigation-rails')
    await expect(navigationRails).toBeVisible()
    await expect(navigationRails).toHaveAttribute('role', 'dialog')
    await expect(navigationRails).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await assetRail.getByRole('button', { name: 'Close navigation drawer' }).click()
    await expect(navigationRails).toBeHidden()
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0)

    // Keep a compact responsive smoke for the navigation and inspector drawers.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(700, 700)
    })
    await expect.poll(async () => page.evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(768)
    await expect(page.getByRole('separator', { name: 'Resize Thread list' })).toHaveCount(0)
    await expect(page.getByRole('separator', { name: 'Resize right sidebar' })).toHaveCount(0)
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
    await expect(contextCard).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Context', exact: true })).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Active references', exact: true })).toHaveCount(0)
    await expect(inspector.getByRole('button', { name: 'Background processes', exact: true })).toHaveCount(0)
    const compactRuntimeDetails = contextCard.getByRole('button', { name: /Runtime/ })
    await compactRuntimeDetails.click()
    const compactRuntimeDialog = page.getByRole('dialog', { name: 'Runtime' })
    await expect(compactRuntimeDialog).toBeVisible()
    await expect(compactRuntimeDialog.getByText('No managed background processes.', { exact: true })).toBeVisible()
    await expect(inspector).not.toHaveAttribute('aria-modal')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(compactRuntimeDialog).toBeHidden()
    await expect(compactRuntimeDetails).toBeFocused()
    await expect(inspector).toBeVisible()
    await expect(inspector).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
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
