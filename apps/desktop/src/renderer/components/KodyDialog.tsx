import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef, type ReactNode, type RefObject } from 'react'

import './kody-dialog.css'

interface KodyDialogProps {
  open: boolean
  title: string
  description: string
  children: ReactNode
  returnFocusRef?: RefObject<HTMLElement | null>
  fallbackFocusSelector?: string
  className?: string
  onOpenChange: (open: boolean) => void
}

export function KodyDialog({
  open,
  title,
  description,
  children,
  returnFocusRef,
  fallbackFocusSelector,
  className,
  onOpenChange
}: KodyDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const contentClassName = ['kody-dialog', className].filter(Boolean).join(' ')

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="kody-dialog__overlay" />
        <DialogPrimitive.Content
          className={contentClassName}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeButtonRef.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const returnTarget = returnFocusRef?.current
            if (returnTarget?.isConnected) {
              returnTarget.focus({ preventScroll: true })
              if (document.activeElement === returnTarget) return
            }
            if (!fallbackFocusSelector) return
            for (const fallback of document.querySelectorAll<HTMLElement>(fallbackFocusSelector)) {
              fallback.focus({ preventScroll: true })
              if (document.activeElement === fallback) return
            }
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <header className="kody-dialog__header">
            <div>
              <DialogPrimitive.Title className="kody-dialog__title">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="kody-dialog__description">
                {description}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button
                ref={closeButtonRef}
                className="icon-button kody-dialog__close"
                type="button"
                aria-label={`Close ${title}`}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </DialogPrimitive.Close>
          </header>
          <div className="kody-dialog__body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
