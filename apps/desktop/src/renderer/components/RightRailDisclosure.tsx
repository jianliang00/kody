import { ChevronDown } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'

export interface RightRailDisclosureProps {
  id: string
  title: string
  eyebrow?: string
  badge?: ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function RightRailDisclosure({
  id,
  title,
  eyebrow,
  badge,
  expanded,
  onExpandedChange,
  actions,
  className,
  children
}: RightRailDisclosureProps) {
  const titleId = `${id}-title`
  const panelId = `${id}-panel`
  const sectionClassName = [
    'right-rail-disclosure',
    expanded ? 'right-rail-disclosure--expanded' : undefined,
    className
  ].filter(Boolean).join(' ')

  const toggle = (): void => onExpandedChange(!expanded)
  const handleToggleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }

  return (
    <div
      id={id}
      className={sectionClassName}
      data-expanded={expanded}
    >
      <header className="right-rail-disclosure__header">
        <h2 className="right-rail-disclosure__heading">
          <button
            className="right-rail-disclosure__toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-labelledby={titleId}
            onClick={toggle}
            onKeyDown={handleToggleKeyDown}
          >
            <span className="right-rail-disclosure__copy">
              {eyebrow ? <span className="right-rail-disclosure__eyebrow">{eyebrow}</span> : null}
              <span className="right-rail-disclosure__title" id={titleId}>{title}</span>
            </span>
            {badge !== undefined ? <span className="right-rail-disclosure__badge">{badge}</span> : null}
            <ChevronDown
              className="right-rail-disclosure__chevron"
              aria-hidden="true"
              size={14}
            />
          </button>
        </h2>
        {actions !== undefined ? <div className="right-rail-disclosure__actions">{actions}</div> : null}
      </header>
      <div
        id={panelId}
        className="right-rail-disclosure__panel"
        role="region"
        aria-labelledby={titleId}
        hidden={!expanded}
      >
        {children}
      </div>
    </div>
  )
}
