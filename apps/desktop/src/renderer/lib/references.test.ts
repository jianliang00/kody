import { describe, expect, it } from 'vitest'

import type { ContextReference, Project, Thread } from '@shared/protocol'
import {
  createCandidates,
  cycleReference,
  filterCandidates,
  findMention,
  referenceKey,
  referenceModeLabel,
  removeMention,
  removeReference,
  resolveReferenceName,
  upsertReference
} from './references'

const threadReference = (
  threadId: string,
  mode: 'summary' | 'full' | 'messages' | 'artifacts' = 'summary'
): ContextReference => ({ kind: 'thread', thread_id: threadId, mode })

const projectReference = (
  projectId: string,
  access: 'read_only' | 'read_write' = 'read_only'
): ContextReference => ({ kind: 'project', project_id: projectId, access })

const threads: Thread[] = [
  {
    id: 'thread-current',
    title: 'Current work',
    workspace_id: 'workspace-current',
    status: 'running',
    default_references: [],
    created_at: '2026-07-12T08:00:00Z',
    updated_at: '2026-07-12T08:00:00Z'
  },
  {
    id: 'thread-design',
    title: 'OAuth design',
    workspace_id: 'workspace-design',
    status: 'idle',
    default_references: [],
    summary: 'Token flow and security decisions',
    created_at: '2026-07-11T08:00:00Z',
    updated_at: '2026-07-11T08:00:00Z'
  },
  {
    id: 'thread-archive',
    title: 'Legacy notes',
    workspace_id: 'workspace-archive',
    status: 'archived',
    default_references: [],
    created_at: '2026-07-10T08:00:00Z',
    updated_at: '2026-07-10T08:00:00Z'
  }
]

const projects: Project[] = [
  {
    id: 'project-web',
    name: 'Web client',
    root: '/code/apps/web',
    kind: 'git',
    created_at: '2026-07-12T08:00:00Z'
  }
]

describe('reference collection helpers', () => {
  it('keys references by entity identity rather than mode or access', () => {
    expect(referenceKey(threadReference('thread-design', 'full'))).toBe('thread:thread-design')
    expect(referenceKey(projectReference('project-web', 'read_write'))).toBe('project:project-web')
  })

  it('upserts in place and removes all variants of the same entity', () => {
    const initial = [
      threadReference('thread-design'),
      projectReference('project-web'),
      threadReference('thread-archive')
    ]

    const updated = upsertReference(initial, threadReference('thread-design', 'artifacts'))
    expect(updated).toEqual([
      threadReference('thread-design', 'artifacts'),
      projectReference('project-web'),
      threadReference('thread-archive')
    ])
    expect(removeReference(updated, threadReference('thread-design', 'full'))).toEqual([
      projectReference('project-web'),
      threadReference('thread-archive')
    ])
  })

  it('appends references that are not already selected', () => {
    expect(upsertReference([threadReference('thread-design')], projectReference('project-web')))
      .toEqual([threadReference('thread-design'), projectReference('project-web')])
  })
})

describe('reference modes', () => {
  it('cycles the supported thread modes and clears selected message ids', () => {
    expect(cycleReference(threadReference('thread-design'))).toEqual(
      threadReference('thread-design', 'full')
    )
    expect(cycleReference(threadReference('thread-design', 'full'))).toEqual(
      threadReference('thread-design', 'artifacts')
    )
    expect(cycleReference(threadReference('thread-design', 'artifacts'))).toEqual(
      threadReference('thread-design', 'summary')
    )
    expect(cycleReference({
      kind: 'thread',
      thread_id: 'thread-design',
      mode: 'messages',
      message_ids: ['message-1']
    })).toEqual(threadReference('thread-design', 'summary'))
  })

  it('toggles project access and presents human-readable labels', () => {
    expect(cycleReference(projectReference('project-web'))).toEqual(
      projectReference('project-web', 'read_write')
    )
    expect(referenceModeLabel(projectReference('project-web', 'read_write'))).toBe('Read & write')
    expect(referenceModeLabel(threadReference('thread-design', 'artifacts'))).toBe('Artifacts')
  })
})

describe('composer mention parsing', () => {
  it('finds a mention at the cursor and returns its replacement range', () => {
    expect(findMention('Compare with @oau', 17)).toEqual({ start: 13, end: 17, query: 'oau' })
    expect(findMention('@')).toEqual({ start: 0, end: 1, query: '' })
  })

  it('does not treat email-like text or completed mentions as an active mention', () => {
    expect(findMention('mail dev@example.com')).toBeNull()
    expect(findMention('Use @design next')).toBeNull()
  })

  it('removes only the active mention while preserving text after the cursor', () => {
    const value = 'Compare @des before release'
    const mention = findMention(value, 12)
    expect(removeMention(value, mention)).toBe('Compare before release')
    expect(removeMention(value, null)).toBe(value)
  })
})

describe('mention candidates', () => {
  it('omits the current thread, keeps archived threads, and defaults projects to read-only', () => {
    const candidates = createCandidates(threads, projects, 'thread-current')

    expect(candidates.map((candidate) => candidate.key)).toEqual([
      'thread:thread-design',
      'thread:thread-archive',
      'project:project-web'
    ])
    expect(candidates[1]?.detail).toBe('Archived · Durable conversation')
    expect(candidates[2]?.reference).toEqual(projectReference('project-web'))
  })

  it('searches names and details case-insensitively and excludes selected entities', () => {
    const candidates = createCandidates(threads, projects, 'thread-current')

    expect(filterCandidates(candidates, 'SECURITY', []).map((candidate) => candidate.key))
      .toEqual(['thread:thread-design'])
    expect(filterCandidates(candidates, '/CODE/APPS', []).map((candidate) => candidate.key))
      .toEqual(['project:project-web'])
    expect(filterCandidates(candidates, '', [threadReference('thread-design', 'full')])
      .map((candidate) => candidate.key))
      .toEqual(['thread:thread-archive', 'project:project-web'])
  })

  it('resolves display names and gives stable labels for unavailable entities', () => {
    expect(resolveReferenceName(threadReference('thread-design'), threads, projects)).toBe('OAuth design')
    expect(resolveReferenceName(projectReference('project-web'), threads, projects)).toBe('Web client')
    expect(resolveReferenceName(threadReference('missing'), threads, projects)).toBe('Unavailable thread')
    expect(resolveReferenceName(projectReference('missing'), threads, projects)).toBe('Unavailable project')
  })
})
