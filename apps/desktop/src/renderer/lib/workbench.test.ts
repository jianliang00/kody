import { describe, expect, it } from 'vitest'

import type {
  ContextReference,
  Project,
  Thread,
  ThreadStatus,
  ThreadWorkflowState
} from '@shared/protocol'
import {
  filterWorkbenchThreads,
  projectThreadCount,
  readStoredWorkbenchSelection,
  validateWorkbenchSelection,
  WORKBENCH_SELECTION_STORAGE_KEY,
  workbenchSelectionLabel,
  workbenchViewCounts
} from './workbench'

const projectReference = (projectId: string): ContextReference => ({
  kind: 'project',
  project_id: projectId,
  access: 'read_only'
})

const thread = (
  id: string,
  status: ThreadStatus,
  updatedAt: string,
  defaultReferences: ContextReference[] = [],
  workflowState: ThreadWorkflowState = 'deferred'
): Thread => ({
  id,
  title: id,
  workspace_id: `workspace-${id}`,
  status,
  workflow_state: workflowState,
  default_references: defaultReferences,
  created_at: updatedAt,
  updated_at: updatedAt
})

const projects: Project[] = [
  {
    id: 'project-kody',
    name: 'Kody',
    root: '/code/kody',
    kind: 'git',
    created_at: '2026-08-01T00:00:00Z'
  },
  {
    id: 'project-docs',
    name: 'Documentation',
    root: '/code/docs',
    kind: 'directory',
    created_at: '2026-08-01T00:00:00Z'
  }
]

const threads: Thread[] = [
  thread('idle-older', 'idle', '2026-08-06T08:00:00Z', [projectReference('project-kody')]),
  thread('handled-newer', 'idle', '2026-08-09T08:00:00Z', [projectReference('project-kody')], 'handled'),
  thread('running-newest', 'running', '2026-08-10T08:00:00Z', [
    projectReference('project-docs')
  ]),
  thread('progress-newer', 'idle', '2026-08-08T08:00:00Z', [], 'new_progress'),
  thread('legacy-archived', 'archived', '2026-08-05T08:00:00Z')
]

describe('stored workbench selection', () => {
  function storageWith(value: string | null): Pick<Storage, 'getItem'> {
    return {
      getItem: (key) => key === WORKBENCH_SELECTION_STORAGE_KEY ? value : null
    }
  }

  it.each(['all', 'new_progress', 'deferred', 'running', 'handled'] as const)(
    'restores the built-in %s view',
    (selection) => {
      expect(readStoredWorkbenchSelection(storageWith(selection), projects)).toBe(selection)
    }
  )

  it('restores only project selections that still identify an available project', () => {
    expect(readStoredWorkbenchSelection(storageWith('project:project-kody'), projects))
      .toBe('project:project-kody')
    expect(readStoredWorkbenchSelection(storageWith('project:missing'), projects)).toBe('new_progress')
    expect(readStoredWorkbenchSelection(storageWith('project:'), projects)).toBe('new_progress')
  })

  it('keeps a syntactically valid project selection until Projects have loaded', () => {
    const selection = readStoredWorkbenchSelection(storageWith('project:project-kody'))

    expect(selection).toBe('project:project-kody')
    expect(validateWorkbenchSelection(selection, projects)).toBe('project:project-kody')
    expect(validateWorkbenchSelection('project:missing', projects)).toBe('new_progress')
  })

  it('migrates the previous Recent and Archived view identifiers', () => {
    expect(readStoredWorkbenchSelection(storageWith('recent'), projects)).toBe('new_progress')
    expect(readStoredWorkbenchSelection(storageWith('archived'), projects)).toBe('handled')
  })

  it.each([null, '', 'unknown', ' running ', 'project']) (
    'uses New Progress for absent or invalid state: %s',
    (stored) => {
      expect(readStoredWorkbenchSelection(storageWith(stored), projects)).toBe('new_progress')
    }
  )

  it('uses New Progress when storage cannot be read', () => {
    expect(readStoredWorkbenchSelection({
      getItem: () => {
        throw new Error('storage unavailable')
      }
    }, projects)).toBe('new_progress')
  })
})

describe('workbench thread filtering', () => {
  it('keeps the four workflow buckets mutually exclusive and sorted', () => {
    const sourceOrder = threads.map(({ id }) => id)

    expect(filterWorkbenchThreads(threads, 'new_progress').map(({ id }) => id))
      .toEqual(['progress-newer'])
    expect(filterWorkbenchThreads(threads, 'deferred').map(({ id }) => id))
      .toEqual(['idle-older'])
    expect(filterWorkbenchThreads(threads, 'running').map(({ id }) => id))
      .toEqual(['running-newest'])
    expect(filterWorkbenchThreads(threads, 'handled').map(({ id }) => id))
      .toEqual(['handled-newer', 'legacy-archived'])
    expect(filterWorkbenchThreads(threads, 'all').map(({ id }) => id)).toEqual([
      'running-newest',
      'handled-newer',
      'progress-newer',
      'idle-older',
      'legacy-archived'
    ])
    expect(threads.map(({ id }) => id)).toEqual(sourceOrder)
  })

  it('matches project references across workflow buckets', () => {
    expect(filterWorkbenchThreads(threads, 'project:project-kody').map(({ id }) => id)).toEqual([
      'handled-newer',
      'idle-older'
    ])
    expect(filterWorkbenchThreads(threads, 'project:missing')).toEqual([])
  })
})

describe('workbench labels and counts', () => {
  it('labels built-in and project selections', () => {
    expect(workbenchSelectionLabel('all', projects)).toBe('All Threads')
    expect(workbenchSelectionLabel('new_progress', projects)).toBe('New Progress')
    expect(workbenchSelectionLabel('deferred', projects)).toBe('Continue Later')
    expect(workbenchSelectionLabel('running', projects)).toBe('In Progress')
    expect(workbenchSelectionLabel('handled', projects)).toBe('Processed')
    expect(workbenchSelectionLabel('project:project-kody', projects)).toBe('Kody')
    expect(workbenchSelectionLabel('project:missing', projects)).toBe('Unavailable Project')
  })

  it('counts each built-in view in one pass', () => {
    expect(workbenchViewCounts(threads)).toEqual({
      all: 5,
      new_progress: 1,
      deferred: 1,
      running: 1,
      handled: 2
    })
  })

  it('counts each thread at most once for a project', () => {
    const duplicateReferences = [
      ...threads,
      thread('duplicate', 'idle', '2026-08-04T08:00:00Z', [
        projectReference('project-kody'),
        projectReference('project-kody')
      ])
    ]

    expect(projectThreadCount(duplicateReferences, 'project-kody')).toBe(3)
    expect(projectThreadCount(duplicateReferences, 'project-docs')).toBe(1)
    expect(projectThreadCount(duplicateReferences, 'missing')).toBe(0)
  })
})
