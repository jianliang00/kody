import {
  Bookmark,
  Check,
  CircleCheck,
  ListTodo,
  MoreHorizontal
} from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { Thread, ThreadWorkflowState } from '@shared/protocol'

interface ThreadWorkflowMenuProps {
  thread: Thread
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onWorkflowChange: (workflowState: ThreadWorkflowState) => void
}

const workflowActions = [
  { state: 'new_progress', label: 'Mark as New Progress', icon: ListTodo },
  { state: 'deferred', label: 'Continue Later', icon: Bookmark },
  { state: 'handled', label: 'Mark as Processed', icon: CircleCheck }
] as const

export function ThreadWorkflowMenu({
  thread,
  open,
  pending,
  onOpenChange,
  onWorkflowChange
}: ThreadWorkflowMenuProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({})
  const unavailable = pending || thread.status === 'running'

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuWidth = 194
    const estimatedMenuHeight = 112
    const gap = 4
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8))
    const top = rect.bottom + gap + estimatedMenuHeight <= window.innerHeight
      ? rect.bottom + gap
      : Math.max(8, rect.top - estimatedMenuHeight - gap)
    setPosition({ left, top, width: menuWidth })
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')?.focus()
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeWhenOutside = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      onOpenChange(false)
    }
    const closeForViewportChange = (): void => onOpenChange(false)
    document.addEventListener('pointerdown', closeWhenOutside)
    window.addEventListener('resize', closeForViewportChange)
    window.addEventListener('scroll', closeForViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside)
      window.removeEventListener('resize', closeForViewportChange)
      window.removeEventListener('scroll', closeForViewportChange, true)
    }
  }, [onOpenChange, open])

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled)'
    ) ?? [])]
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + items.length) % items.length
          : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="asset-row__menu-trigger"
        type="button"
        aria-label={`More actions for ${thread.title}`}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-expanded={open}
        disabled={unavailable}
        onClick={() => onOpenChange(!open)}
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="thread-workflow-menu surface-popover"
          role="menu"
          aria-label={`Manage ${thread.title}`}
          style={position}
          onKeyDown={handleMenuKeyDown}
        >
          {workflowActions.map(({ state, label, icon: Icon }) => {
            const selected = thread.workflow_state === state
            return (
              <button
                key={state}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                disabled={unavailable || selected}
                onClick={() => {
                  onOpenChange(false)
                  onWorkflowChange(state)
                }}
              >
                <Icon aria-hidden="true" size={14} />
                <span>{label}</span>
                {selected ? <Check aria-hidden="true" size={13} /> : <span aria-hidden="true" />}
              </button>
            )
          })}
        </div>,
        document.body
      ) : null}
    </>
  )
}
