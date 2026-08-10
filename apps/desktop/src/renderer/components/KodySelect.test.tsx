import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { KodySelect } from './KodySelect'

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
})

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta', disabled: true }
]

describe('KodySelect', () => {
  it('exposes a stable class contract for every density variant', () => {
    const variants = ['field', 'toolbar', 'compact', 'chip'] as const

    render(
      <>
        {variants.map((variant) => (
          <KodySelect
            key={variant}
            ariaLabel={`${variant} select`}
            className={`fixture-${variant}`}
            value="alpha"
            options={options}
            variant={variant}
            onValueChange={vi.fn()}
          />
        ))}
      </>
    )

    for (const variant of variants) {
      const trigger = screen.getByRole('combobox', { name: `${variant} select` })
      expect(trigger.classList.contains('kody-select__trigger')).toBe(true)
      expect(trigger.classList.contains(`kody-select__trigger--${variant}`)).toBe(true)
      expect(trigger.classList.contains(`fixture-${variant}`)).toBe(true)
    }
  })

  it('exposes disabled options without allowing them to change the value', () => {
    const onValueChange = vi.fn()
    render(
      <KodySelect
        ariaLabel="Example select"
        value="alpha"
        options={options}
        onValueChange={onValueChange}
      />
    )

    const trigger = screen.getByRole('combobox', { name: 'Example select' })
    fireEvent.click(trigger)

    const disabledOption = screen.getByRole('option', { name: 'Beta' })
    expect(disabledOption.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(disabledOption)

    expect(onValueChange).not.toHaveBeenCalled()
    expect(trigger.getAttribute('data-value')).toBe('alpha')
  })

  it('keeps a leading icon and composer menu styling on the native select parts', async () => {
    render(
      <KodySelect
        ariaLabel="Permission mode"
        className="permission-mode-control"
        contentClassName="composer-permission-menu"
        leadingIcon={<span data-testid="shield-icon" />}
        title="Choose how tools can run"
        value="alpha"
        options={options}
        variant="compact"
        onValueChange={vi.fn()}
      />
    )

    const trigger = screen.getByRole('combobox', { name: 'Permission mode' })
    expect(trigger.getAttribute('title')).toBe('Choose how tools can run')
    expect(trigger.querySelector('.kody-select__leading-icon')).not.toBeNull()
    expect(screen.getByTestId('shield-icon')).not.toBeNull()

    fireEvent.click(trigger)
    const option = await screen.findByRole('option', { name: 'Alpha' })
    const content = option.closest('.kody-select__content')
    expect(content?.classList.contains('composer-permission-menu')).toBe(true)
    expect(content?.getAttribute('data-variant')).toBe('compact')
  })

  it('opens from the keyboard and restores trigger focus after Escape', async () => {
    render(
      <KodySelect
        ariaLabel="Keyboard select"
        value="alpha"
        options={options}
        onValueChange={vi.fn()}
      />
    )

    const trigger = screen.getByRole('combobox', { name: 'Keyboard select' })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const selectedOption = await screen.findByRole('option', { name: 'Alpha' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(selectedOption, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})
