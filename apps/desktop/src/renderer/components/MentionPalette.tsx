import { Folder, MessageCircle, Search, X } from 'lucide-react'
import type { RefObject } from 'react'
import type { ReferenceCandidate } from '../lib/references'

interface MentionPaletteProps {
  candidates: ReferenceCandidate[]
  query: string
  showSearch: boolean
  activeIndex: number
  searchInputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  onActiveIndexChange: (index: number) => void
  onSelect: (candidate: ReferenceCandidate) => void
  onClose: () => void
}

export function MentionPalette({
  candidates,
  query,
  showSearch,
  activeIndex,
  searchInputRef,
  onQueryChange,
  onActiveIndexChange,
  onSelect,
  onClose
}: MentionPaletteProps) {
  const move = (direction: 1 | -1): void => {
    if (candidates.length === 0) return
    onActiveIndexChange((activeIndex + direction + candidates.length) % candidates.length)
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter' && candidates[activeIndex]) {
      event.preventDefault()
      onSelect(candidates[activeIndex])
    }
  }

  return (
    <section
      className="mention-palette surface-popover"
      aria-label="Add context"
      onKeyDown={handleKeyDown}
    >
      <header className="mention-palette__header">
        <div>
          <p className="eyebrow">Context palette</p>
          <h3>Reference an asset</h3>
        </div>
        <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="Close context palette">
          <X aria-hidden="true" size={15} />
        </button>
      </header>

      {showSearch ? (
        <label className="mention-search">
          <span className="sr-only">Search Threads and Projects</span>
          <Search aria-hidden="true" size={15} />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search Threads and Projects"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="context-reference-options"
            aria-activedescendant={
              candidates[activeIndex]
                ? `context-option-${candidates[activeIndex].key.replace(':', '-')}`
                : undefined
            }
          />
        </label>
      ) : (
        <p className="mention-palette__query">
          Matching <strong>@{query}</strong>
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {candidates.length} context {candidates.length === 1 ? 'result' : 'results'}
      </p>
      <div
        className="mention-options"
        id="context-reference-options"
        role="listbox"
        aria-label="Context results"
      >
        {candidates.length === 0 ? (
          <p className="mention-options__empty">No unselected assets match this search.</p>
        ) : (
          candidates.map((candidate, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              id={`context-option-${candidate.key.replace(':', '-')}`}
              className="mention-option"
              key={candidate.key}
              tabIndex={index === activeIndex ? 0 : -1}
              onMouseEnter={() => onActiveIndexChange(index)}
              onFocus={() => onActiveIndexChange(index)}
              onClick={() => onSelect(candidate)}
            >
              <span className={`mention-option__glyph mention-option__glyph--${candidate.kind}`}>
                {candidate.kind === 'thread' ? (
                  <MessageCircle aria-hidden="true" size={15} />
                ) : (
                  <Folder aria-hidden="true" size={15} />
                )}
              </span>
              <span className="mention-option__copy">
                <strong>{candidate.name}</strong>
                <span>{candidate.detail}</span>
              </span>
              <span className={`asset-kind asset-kind--${candidate.kind}`}>
                {candidate.kind === 'thread' ? 'Thread' : 'Project'}
              </span>
            </button>
          ))
        )}
      </div>
      <footer className="mention-palette__footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>Enter</kbd> Add</span>
        <span><kbd>Esc</kbd> Close</span>
      </footer>
    </section>
  )
}
