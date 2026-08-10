import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ModelDescriptor } from '@shared/protocol'

import { ModelMenu } from './ModelMenu'

afterEach(cleanup)

const models: ModelDescriptor[] = [
  {
    id: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    capabilities: { tool_calling: true, input_modalities: ['text', 'image'] },
    default_reasoning_effort: 'medium',
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh']
  },
  {
    id: 'gpt-5.6-terra',
    display_name: 'GPT-5.6-Terra',
    capabilities: { tool_calling: true, input_modalities: ['text'] },
    default_reasoning_effort: 'low',
    reasoning_efforts: ['low', 'high']
  }
]

describe('ModelMenu', () => {
  it('exposes nested radio menus for model and effort', async () => {
    const onModelChange = vi.fn()
    const onEffortChange = vi.fn()
    renderModelMenu({ onModelChange, onEffortChange })

    const trigger = screen.getByRole('button', { name: /Model options: GPT-5.6-Sol/ })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const rootMenu = await screen.findByRole('menu', { name: 'Model settings' })
    const modelSubmenuTrigger = within(rootMenu).getByRole('menuitem', { name: 'Model: GPT-5.6-Sol' })
    await waitFor(() => expect(document.activeElement).toBe(modelSubmenuTrigger))
    fireEvent.keyDown(modelSubmenuTrigger, { key: 'ArrowRight' })

    const modelMenu = await waitFor(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Models"]')
      expect(menu).not.toBeNull()
      return menu as HTMLElement
    })
    const terra = within(modelMenu).getByRole('menuitemradio', { name: 'GPT-5.6-Terra' })
    expect(within(modelMenu).getByRole('menuitemradio', { name: 'GPT-5.6-Sol' }).getAttribute('aria-checked'))
      .toBe('true')
    fireEvent.click(terra)
    expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-terra')

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Model settings' })).toBeNull())
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const reopenedMenu = await screen.findByRole('menu', { name: 'Model settings' })
    const effortSubmenuTrigger = within(reopenedMenu).getByRole('menuitem', { name: 'Effort: Medium' })
    fireEvent.keyDown(effortSubmenuTrigger, { key: 'ArrowRight' })

    const effortMenu = await waitFor(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Reasoning effort"]')
      expect(menu).not.toBeNull()
      return menu as HTMLElement
    })
    const high = within(effortMenu).getByRole('menuitemradio', { name: 'High' })
    expect(within(effortMenu).getByRole('menuitemradio', { name: 'Medium' }).getAttribute('aria-checked'))
      .toBe('true')
    fireEvent.click(high)
    expect(onEffortChange).toHaveBeenCalledWith('high')
  })

  it('uses a checkbox menu item for Speedy only when supported', async () => {
    const onSpeedyChange = vi.fn()
    const { rerender } = renderModelMenu({ speedy: false, onSpeedyChange })

    const trigger = screen.getByRole('button', { name: /Model options/ })
    expect(trigger.getAttribute('aria-description')).toBe('Fast mode off')
    expect(trigger.querySelector('.model-menu__trigger-leading')).toBeNull()
    expect(trigger.querySelector('.model-menu__trigger-fast-icon')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const speedy = await screen.findByRole('menuitemcheckbox', { name: 'Speedy: Off' })
    expect(speedy.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(speedy)
    expect(onSpeedyChange).toHaveBeenCalledWith(true)

    rerender(<ModelMenu {...baseProps()} speedy />)
    const enabledTrigger = screen.getByRole('button', { name: /Model options/ })
    expect(enabledTrigger.getAttribute('aria-description')).toBe('Fast mode on')
    expect(enabledTrigger.querySelector('.model-menu__trigger-fast-icon')?.classList.contains('lucide-zap'))
      .toBe(true)
    expect(enabledTrigger.querySelector('.model-menu__trigger-model-icon')).toBeNull()

    rerender(<ModelMenu {...baseProps()} supportsSpeedy={false} />)
    const unsupportedTrigger = screen.getByRole('button', { name: /Model options/ })
    expect(unsupportedTrigger.getAttribute('aria-description')).toBe('Fast mode unavailable')
    expect(unsupportedTrigger.getAttribute('data-speedy')).toBe('false')
    expect(unsupportedTrigger.querySelector('.model-menu__trigger-leading')).toBeNull()
    fireEvent.keyDown(unsupportedTrigger, { key: 'ArrowDown' })
    await screen.findByRole('menu', { name: 'Model settings' })
    expect(screen.queryByRole('menuitemcheckbox', { name: /Speedy/ })).toBeNull()
  })

  it('closes with Escape and restores focus to its trigger', async () => {
    renderModelMenu()

    const trigger = screen.getByRole('button', { name: /Model options/ })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const rootMenu = await screen.findByRole('menu', { name: 'Model settings' })
    fireEvent.keyDown(rootMenu, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Model settings' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('disables unavailable effort and loading or disabled triggers', async () => {
    const noEffortModel: ModelDescriptor = {
      id: 'plain',
      display_name: 'Plain model',
      capabilities: { tool_calling: false, input_modalities: ['text'] }
    }
    const { rerender } = render(
      <ModelMenu {...baseProps()} models={[noEffortModel]} model="plain" effort="" />
    )

    const trigger = screen.getByRole('button', { name: /Model options: Plain model/ })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const rootMenu = await screen.findByRole('menu', { name: 'Model settings' })
    expect(within(rootMenu).getByRole('menuitem', { name: 'Effort: Unavailable' }).getAttribute('data-disabled'))
      .not.toBeNull()

    fireEvent.keyDown(rootMenu, { key: 'Escape' })
    rerender(<ModelMenu {...baseProps()} loading />)
    expect((screen.getByRole('button', { name: 'Model options: Loading models…' }) as HTMLButtonElement).disabled)
      .toBe(true)

    rerender(<ModelMenu {...baseProps()} disabled />)
    expect((screen.getByRole('button', { name: /Model options: GPT-5.6-Sol/ }) as HTMLButtonElement).disabled)
      .toBe(true)
  })
})

function baseProps() {
  return {
    models,
    model: 'gpt-5.6-sol',
    effort: 'medium',
    speedy: true,
    supportsSpeedy: true,
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onSpeedyChange: vi.fn()
  }
}

function renderModelMenu(overrides: Partial<ReturnType<typeof baseProps>> = {}) {
  return render(<ModelMenu {...baseProps()} {...overrides} />)
}
