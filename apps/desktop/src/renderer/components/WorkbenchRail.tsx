import {
  Bookmark,
  CircleCheck,
  CircleDot,
  Folder,
  FolderGit2,
  FolderPlus,
  Inbox,
  ListTodo,
  PanelLeftClose,
  PanelRightOpen,
  Settings2,
  SquarePen
} from 'lucide-react'
import type { DesktopUpdateStatus } from '@shared/bridge'
import type { Project, ServerStatus, Thread } from '@shared/protocol'
import {
  projectThreadCount,
  workbenchViewCounts,
  type WorkbenchSelection
} from '../lib/workbench'
import { UpdateIndicator } from './UpdateIndicator'

interface WorkbenchRailProps {
  threads: Thread[]
  projects: Project[]
  selection: WorkbenchSelection
  status: ServerStatus
  updateStatus: DesktopUpdateStatus
  threadListCollapsed: boolean
  onSelectionChange: (selection: WorkbenchSelection) => void
  onNewThread: () => void
  onImportProject: () => Promise<void>
  onOpenSettings: () => void
  onUpdateAction: () => void
  onCollapse: () => void
  onExpandThreadList: () => void
}

const workbenchViews = [
  { id: 'new_progress', label: 'New Progress', icon: ListTodo },
  { id: 'deferred', label: 'Continue Later', icon: Bookmark },
  { id: 'running', label: 'In Progress', icon: CircleDot },
  { id: 'handled', label: 'Processed', icon: CircleCheck },
  { id: 'all', label: 'All Threads', icon: Inbox }
] as const

export function WorkbenchRail({
  threads,
  projects,
  selection,
  status,
  updateStatus,
  threadListCollapsed,
  onSelectionChange,
  onNewThread,
  onImportProject,
  onOpenSettings,
  onUpdateAction,
  onCollapse,
  onExpandThreadList
}: WorkbenchRailProps) {
  const counts = workbenchViewCounts(threads)

  return (
    <aside id="workbench-rail" className="workbench-rail" aria-label="Workbench">
      <div className="workbench-rail__window-drag">
        <button
          className="icon-button workbench-rail__collapse"
          type="button"
          onClick={onCollapse}
          aria-label="Collapse workbench sidebar"
          aria-controls="workbench-rail"
        >
          <PanelLeftClose aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="workbench-rail__primary-actions">
        <button className="workbench-new-thread" type="button" onClick={onNewThread}>
          <SquarePen aria-hidden="true" size={16} />
          <span>New Thread</span>
        </button>
        {threadListCollapsed ? (
          <button
            className="icon-button"
            id="expand-thread-list-workbench"
            type="button"
            onClick={onExpandThreadList}
            aria-label="Expand Thread list"
            aria-controls="asset-rail"
          >
            <PanelRightOpen aria-hidden="true" size={16} />
          </button>
        ) : null}
      </div>

      <nav className="workbench-navigation" aria-label="Workbench views">
        <section className="workbench-section" aria-labelledby="workbench-views-title">
          <h2 id="workbench-views-title">Workbench</h2>
          <ul className="workbench-list">
            {workbenchViews.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  className="workbench-row"
                  aria-current={selection === id ? 'page' : undefined}
                  onClick={() => onSelectionChange(id)}
                >
                  <Icon aria-hidden="true" size={15} />
                  <span>{label}</span>
                  <span className="workbench-row__count">{counts[id]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="workbench-section" aria-labelledby="workbench-projects-title">
          <header className="workbench-section__header">
            <h2 id="workbench-projects-title">Projects</h2>
            <button
              className="icon-button icon-button--small"
              type="button"
              onClick={() => void onImportProject()}
              aria-label="Import Project"
              title="Import Project"
            >
              <FolderPlus aria-hidden="true" size={14} />
            </button>
          </header>
          {projects.length === 0 ? (
            <p className="workbench-empty">No Projects yet</p>
          ) : (
            <ul className="workbench-list workbench-project-list">
              {projects.map((project) => {
                const projectSelection = `project:${project.id}` as WorkbenchSelection
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="workbench-row"
                      aria-current={selection === projectSelection ? 'page' : undefined}
                      onClick={() => onSelectionChange(projectSelection)}
                      title={project.root}
                    >
                      {project.kind === 'git'
                        ? <FolderGit2 aria-hidden="true" size={15} />
                        : <Folder aria-hidden="true" size={15} />}
                      <span>{project.name}</span>
                      <span className="workbench-row__count">
                        {projectThreadCount(threads, project.id)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </nav>

      <footer className="workbench-footer">
        <button
          className="workbench-settings"
          type="button"
          onClick={onOpenSettings}
          aria-label="Open model settings"
        >
          <Settings2 aria-hidden="true" size={15} />
          <span>Settings</span>
        </button>
        <div className="workbench-status-row">
          <div className="workbench-connection" role="status">
            <span className={`connection-dot connection-dot--${status.phase}`} aria-hidden="true" />
            <span>{status.phase === 'connected' ? 'Local server connected' : status.phase}</span>
          </div>
          <UpdateIndicator status={updateStatus} onAction={onUpdateAction} />
        </div>
      </footer>
    </aside>
  )
}
