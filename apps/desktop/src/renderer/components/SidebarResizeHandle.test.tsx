import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { SidebarResizeHandle } from './SidebarResizeHandle'

afterEach(cleanup)

function Harness({ side = 'left' }: { side?: 'left' | 'right' }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(272)
  return (
    <div ref={containerRef} data-testid="shell">
      <SidebarResizeHandle
        side={side}
        label={`Resize ${side} sidebar`}
        controls={`${side}-sidebar`}
        value={value}
        min={224}
        max={400}
        defaultValue={272}
        containerRef={containerRef}
        onChange={setValue}
      />
    </div>
  )
}

function StaticHarness({ onChange }: { onChange: (value: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={containerRef}>
      <SidebarResizeHandle
        side="left"
        label="Resize static sidebar"
        controls="static-sidebar"
        value={272}
        min={224}
        max={400}
        defaultValue={272}
        containerRef={containerRef}
        onChange={onChange}
      />
    </div>
  )
}

describe('SidebarResizeHandle', () => {
  it('supports arrow, boundary, and reset keyboard interactions', () => {
    render(<Harness />)
    const handle = screen.getByRole('separator', { name: 'Resize left sidebar' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe('224')
    fireEvent.doubleClick(handle)
    expect(handle.getAttribute('aria-valuenow')).toBe('272')
  })

  it('previews pointer movement without rerendering the parent on every step', () => {
    render(<Harness />)
    const handle = screen.getByRole('separator', { name: 'Resize left sidebar' })
    const shell = screen.getByTestId('shell')

    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 140 })
    expect(shell.style.getPropertyValue('--asset-rail-width')).toBe('312px')
    expect(handle.getAttribute('aria-valuenow')).toBe('312')
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 140 })
    expect(handle.getAttribute('aria-valuenow')).toBe('312')
  })

  it('reverses horizontal movement for the right sidebar', () => {
    render(<Harness side="right" />)
    const handle = screen.getByRole('separator', { name: 'Resize right sidebar' })
    const shell = screen.getByTestId('shell')

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 300 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 260 })
    expect(shell.style.getPropertyValue('--right-rail-width')).toBe('312px')
  })

  it('does not commit a pointer interaction that never moved', () => {
    const changes: number[] = []
    render(<StaticHarness onChange={(value) => changes.push(value)} />)
    const handle = screen.getByRole('separator', { name: 'Resize static sidebar' })

    fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientX: 200 })
    fireEvent.pointerUp(handle, { pointerId: 11, clientX: 200 })
    expect(changes).toEqual([])
  })
})
