import { Check, Eye, Folder, FolderGit2, FolderPlus, Layers3, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Project } from '@shared/protocol'
import { RightRailDisclosure } from './RightRailDisclosure'

interface ProjectShelfProps {
  projects: Project[]
  selectedProjectIds: Set<string>
  open: boolean
  expanded: boolean
  unavailable?: boolean
  onOpenChange: (open: boolean) => void
  onExpandedChange: (expanded: boolean) => void
  onImportProject: () => Promise<void>
  onAddProject: (project: Project) => void
}

export function ProjectShelf({
  projects,
  selectedProjectIds,
  open,
  expanded,
  unavailable = false,
  onOpenChange,
  onExpandedChange,
  onImportProject,
  onAddProject
}: ProjectShelfProps) {
  const launcherRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : launcherRef.current ?? undefined
    const panel = panelRef.current
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
    const visibleFocusables = (): HTMLElement[] => (
      panel
        ? [...panel.querySelectorAll<HTMLElement>(focusableSelector)]
          .filter((element) => !element.closest('[hidden]'))
        : []
    )
    visibleFocusables()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = visibleFocusables()
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (!panel.contains(document.activeElement)) {
        event.preventDefault()
        if (event.shiftKey) last.focus()
        else first.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onOpenChange, open])

  return (
    <div className={`project-shelf-shell${open ? ' project-shelf-shell--open' : ''}`}>
      <button
        ref={launcherRef}
        className="project-shelf-launcher"
        type="button"
        onClick={() => onOpenChange(true)}
        aria-expanded={open}
        aria-controls="project-shelf"
        aria-haspopup="dialog"
      >
        <Layers3 aria-hidden="true" size={16} />
        <span>Projects</span>
        <span className="count-pill">{projects.length}</span>
      </button>

      <div
        ref={panelRef}
        id="project-shelf"
        className="project-shelf"
        role={open ? 'dialog' : undefined}
        aria-modal={open || undefined}
        aria-labelledby={open ? 'right-rail-projects-title' : undefined}
      >
        <RightRailDisclosure
          id="right-rail-projects"
          className="project-shelf__disclosure"
          eyebrow="Reusable code assets"
          title="Projects"
          badge={<span className="count-pill">{projects.length}</span>}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          actions={(
            <>
              <button
                className="icon-button icon-button--small"
                type="button"
                disabled={unavailable}
                onClick={() => void onImportProject()}
                aria-label="Add Project"
                title="Add Project"
              >
                <FolderPlus aria-hidden="true" size={15} />
              </button>
              <button
                className="icon-button icon-button--small project-shelf__close"
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close Projects"
              >
                <X aria-hidden="true" size={15} />
              </button>
            </>
          )}
        >
          {projects.length === 0 ? (
            <div className="project-shelf__empty">
              <Folder aria-hidden="true" size={18} />
              <p>No Projects yet.</p>
              <button type="button" disabled={unavailable} onClick={() => void onImportProject()}>
                <FolderPlus aria-hidden="true" size={14} /> Add Project
              </button>
            </div>
          ) : (
            <ul className="project-shelf__list">
              {projects.map((project) => {
                const selected = selectedProjectIds.has(project.id)
                return (
                  <li key={project.id}>
                    <button
                      className="project-shelf__row"
                      type="button"
                      disabled={selected}
                      onClick={() => onAddProject(project)}
                      aria-label={selected
                        ? `${project.name} is already in pending context`
                        : `Add ${project.name} as read-only context`}
                    >
                      <span className="project-shelf__icon">
                        {project.kind === 'git'
                          ? <FolderGit2 aria-hidden="true" size={14} />
                          : <Folder aria-hidden="true" size={14} />}
                      </span>
                      <span className="project-shelf__copy">
                        <strong>{project.name}</strong>
                        <span title={project.root}>{project.git?.branch || project.root}</span>
                      </span>
                      <span className="project-shelf__access">
                        {selected
                          ? <><Check aria-hidden="true" size={12} /> Added</>
                          : <><Eye aria-hidden="true" size={12} /> Read only</>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </RightRailDisclosure>
      </div>
    </div>
  )
}
