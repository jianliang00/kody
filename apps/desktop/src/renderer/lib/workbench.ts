import type { Project, Thread } from '@shared/protocol'

export type WorkbenchSelection =
  | 'all'
  | 'new_progress'
  | 'deferred'
  | 'running'
  | 'handled'
  | `project:${string}`

export interface WorkbenchViewCounts {
  all: number
  new_progress: number
  deferred: number
  running: number
  handled: number
}

export const WORKBENCH_SELECTION_STORAGE_KEY = 'kody.workbenchSelection.v1'

const DEFAULT_WORKBENCH_SELECTION: WorkbenchSelection = 'new_progress'
const BUILT_IN_SELECTIONS: ReadonlySet<string> = new Set([
  'all',
  'new_progress',
  'deferred',
  'running',
  'handled'
])

type ReadableStorage = Pick<Storage, 'getItem'>

function projectIdFromSelection(selection: WorkbenchSelection): string | null {
  return selection.startsWith('project:') ? selection.slice('project:'.length) : null
}

function isWorkbenchSelection(value: string, projects?: Project[]): value is WorkbenchSelection {
  if (BUILT_IN_SELECTIONS.has(value)) return true
  if (!value.startsWith('project:')) return false

  const projectId = value.slice('project:'.length)
  return projectId.length > 0 && (
    projects === undefined || projects.some((project) => project.id === projectId)
  )
}

function referencesProject(thread: Thread, projectId: string): boolean {
  return thread.default_references.some(
    (reference) => reference.kind === 'project' && reference.project_id === projectId
  )
}

function updatedAtDescending(left: Thread, right: Thread): number {
  const leftTime = Date.parse(left.updated_at)
  const rightTime = Date.parse(right.updated_at)

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime
  return right.updated_at.localeCompare(left.updated_at)
}

export type ThreadWorkflowBucket = 'new_progress' | 'deferred' | 'running' | 'handled'

const THREAD_WORKFLOW_LABELS: Record<ThreadWorkflowBucket, string> = {
  new_progress: 'New Progress',
  deferred: 'Continue Later',
  running: 'In Progress',
  handled: 'Processed'
}

export function threadWorkflowBucket(thread: Thread): ThreadWorkflowBucket {
  if (thread.status === 'running') return 'running'
  if (thread.status === 'archived') return 'handled'
  return thread.workflow_state
}

export function threadWorkflowBucketLabel(bucket: ThreadWorkflowBucket): string {
  return THREAD_WORKFLOW_LABELS[bucket]
}

export function readStoredWorkbenchSelection(
  storage: ReadableStorage,
  projects?: Project[]
): WorkbenchSelection {
  let stored: string | null
  try {
    stored = storage.getItem(WORKBENCH_SELECTION_STORAGE_KEY)
  } catch {
    return DEFAULT_WORKBENCH_SELECTION
  }

  const migrated = stored === 'recent'
    ? 'new_progress'
    : stored === 'archived'
      ? 'handled'
      : stored

  return migrated !== null && isWorkbenchSelection(migrated, projects)
    ? migrated
    : DEFAULT_WORKBENCH_SELECTION
}

export function validateWorkbenchSelection(
  selection: WorkbenchSelection,
  projects: Project[]
): WorkbenchSelection {
  return isWorkbenchSelection(selection, projects)
    ? selection
    : DEFAULT_WORKBENCH_SELECTION
}

export function filterWorkbenchThreads(
  threads: Thread[],
  selection: WorkbenchSelection
): Thread[] {
  const projectId = projectIdFromSelection(selection)
  const filtered = projectId !== null
    ? threads.filter((thread) => referencesProject(thread, projectId))
    : threads.filter((thread) => {
        if (selection !== 'all') return threadWorkflowBucket(thread) === selection
        return true
      })

  return filtered.sort(updatedAtDescending)
}

export function workbenchSelectionLabel(
  selection: WorkbenchSelection,
  projects: Project[]
): string {
  if (selection === 'all') return 'All Threads'
  if (selection === 'new_progress' || selection === 'deferred' || selection === 'running' || selection === 'handled') {
    return threadWorkflowBucketLabel(selection)
  }

  const projectId = projectIdFromSelection(selection)
  return projects.find((project) => project.id === projectId)?.name ?? 'Unavailable Project'
}

export function workbenchViewCounts(threads: Thread[]): WorkbenchViewCounts {
  return threads.reduce<WorkbenchViewCounts>((counts, thread) => {
    counts.all += 1
    counts[threadWorkflowBucket(thread)] += 1
    return counts
  }, { all: 0, new_progress: 0, deferred: 0, running: 0, handled: 0 })
}

export function projectThreadCount(threads: Thread[], projectId: string): number {
  return threads.reduce(
    (count, thread) => count + Number(referencesProject(thread, projectId)),
    0
  )
}
