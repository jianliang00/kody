import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

import { clampSidebarWidth } from '../lib/sidebarSizing'

interface SidebarResizeHandleProps {
  side: 'left' | 'right'
  label: string
  controls: string
  value: number
  min: number
  max: number
  defaultValue: number
  containerRef: RefObject<HTMLDivElement | null>
  onChange: (value: number) => void
}

interface DragState {
  pointerId: number
  startClientX: number
  startValue: number
  currentValue: number
  moved: boolean
}

const KEYBOARD_STEP = 8
const LARGE_KEYBOARD_STEP = 16

export function SidebarResizeHandle({
  side,
  label,
  controls,
  value,
  min,
  max,
  defaultValue,
  containerRef,
  onChange
}: SidebarResizeHandleProps) {
  const dragRef = useRef<DragState | undefined>(undefined)
  const cssProperty = side === 'left' ? '--asset-rail-width' : '--right-rail-width'

  const preview = (nextValue: number, handle: HTMLElement): void => {
    const rounded = clampSidebarWidth(nextValue, min, max)
    containerRef.current?.style.setProperty(cssProperty, `${rounded}px`)
    handle.setAttribute('aria-valuenow', String(rounded))
    handle.setAttribute('aria-valuetext', `${rounded} pixels`)
    if (dragRef.current) {
      dragRef.current.currentValue = rounded
      dragRef.current.moved ||= rounded !== dragRef.current.startValue
    }
  }

  const finishDrag = (handle: HTMLElement, pointerId: number): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== pointerId) return
    dragRef.current = undefined
    handle.removeAttribute('data-resizing')
    document.documentElement.removeAttribute('data-sidebar-resizing')
    if (drag.moved) onChange(drag.currentValue)
  }

  useEffect(() => () => {
    document.documentElement.removeAttribute('data-sidebar-resizing')
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startValue: value,
      currentValue: value,
      moved: false
    }
    handle.setAttribute('data-resizing', 'true')
    document.documentElement.dataset.sidebarResizing = side
    handle.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = event.clientX - drag.startClientX
    preview(drag.startValue + (side === 'left' ? delta : -delta), event.currentTarget)
  }

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget
    finishDrag(handle, event.pointerId)
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? LARGE_KEYBOARD_STEP : KEYBOARD_STEP
    let nextValue: number | undefined
    if (event.key === 'Home') nextValue = min
    else if (event.key === 'End') nextValue = max
    else if (event.key === 'ArrowLeft') nextValue = value + (side === 'left' ? -step : step)
    else if (event.key === 'ArrowRight') nextValue = value + (side === 'left' ? step : -step)
    if (nextValue === undefined) return
    event.preventDefault()
    onChange(clampSidebarWidth(nextValue, min, max))
  }

  return (
    <div
      className={`sidebar-resize-handle sidebar-resize-handle--${side}`}
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onDoubleClick={() => onChange(clampSidebarWidth(defaultValue, min, max))}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget, event.pointerId)}
    />
  )
}
