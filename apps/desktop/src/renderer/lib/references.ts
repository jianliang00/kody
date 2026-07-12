import type {
  ContextReference,
  Project,
  ProjectAccess,
  Thread,
  ThreadReferenceMode
} from '@shared/protocol'

export const THREAD_REFERENCE_MODES: ThreadReferenceMode[] = [
  'summary',
  'full',
  'artifacts'
]

export interface MentionMatch {
  start: number
  end: number
  query: string
}

export interface ReferenceCandidate {
  key: string
  kind: 'thread' | 'project'
  name: string
  detail: string
  reference: ContextReference
}

export function referenceKey(reference: ContextReference): string {
  return reference.kind === 'thread'
    ? `thread:${reference.thread_id}`
    : `project:${reference.project_id}`
}

export function upsertReference(
  references: ContextReference[],
  reference: ContextReference
): ContextReference[] {
  const key = referenceKey(reference)
  const existingIndex = references.findIndex((item) => referenceKey(item) === key)
  if (existingIndex === -1) return [...references, reference]

  return references.map((item, index) => (index === existingIndex ? reference : item))
}

export function removeReference(
  references: ContextReference[],
  reference: ContextReference
): ContextReference[] {
  const key = referenceKey(reference)
  return references.filter((item) => referenceKey(item) !== key)
}

export function cycleReference(reference: ContextReference): ContextReference {
  if (reference.kind === 'project') {
    const access: ProjectAccess = reference.access === 'read_only' ? 'read_write' : 'read_only'
    return { ...reference, access }
  }

  const currentIndex = THREAD_REFERENCE_MODES.indexOf(reference.mode)
  const nextMode = THREAD_REFERENCE_MODES[(currentIndex + 1) % THREAD_REFERENCE_MODES.length]
  return { ...reference, mode: nextMode ?? 'summary', message_ids: undefined }
}

export function referenceModeLabel(reference: ContextReference): string {
  if (reference.kind === 'project') {
    return reference.access === 'read_write' ? 'Read & write' : 'Read only'
  }

  const labels: Record<ThreadReferenceMode, string> = {
    summary: 'Summary',
    full: 'Full context',
    messages: 'Selected messages',
    artifacts: 'Artifacts'
  }
  return labels[reference.mode]
}

export function findMention(value: string, cursor = value.length): MentionMatch | null {
  const beforeCursor = value.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCursor)
  if (!match) return null

  const boundary = match[1] ?? ''
  const query = match[2] ?? ''
  const start = cursor - query.length - 1
  return { start: Math.max(boundary.length === 0 ? 0 : start, 0), end: cursor, query }
}

export function removeMention(value: string, mention: MentionMatch | null): string {
  if (!mention) return value
  const before = value.slice(0, mention.start)
  const after = value.slice(mention.end)
  return `${before}${after}`.replace(/ {2,}/g, ' ')
}

export function createCandidates(
  threads: Thread[],
  projects: Project[],
  currentThreadId?: string
): ReferenceCandidate[] {
  const threadCandidates: ReferenceCandidate[] = threads
    .filter((thread) => thread.id !== currentThreadId)
    .map((thread) => ({
      key: `thread:${thread.id}`,
      kind: 'thread',
      name: thread.title,
      detail: thread.status === 'archived'
        ? `Archived · ${thread.summary || 'Durable conversation'}`
        : thread.summary || 'Durable conversation',
      reference: { kind: 'thread', thread_id: thread.id, mode: 'summary' }
    }))

  const projectCandidates: ReferenceCandidate[] = projects.map((project) => ({
    key: `project:${project.id}`,
    kind: 'project',
    name: project.name,
    detail: project.root,
    reference: { kind: 'project', project_id: project.id, access: 'read_only' }
  }))

  return [...threadCandidates, ...projectCandidates]
}

export function filterCandidates(
  candidates: ReferenceCandidate[],
  query: string,
  selected: ContextReference[]
): ReferenceCandidate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const selectedKeys = new Set(selected.map(referenceKey))

  return candidates.filter((candidate) => {
    if (selectedKeys.has(candidate.key)) return false
    if (!normalizedQuery) return true
    return `${candidate.name} ${candidate.detail}`.toLocaleLowerCase().includes(normalizedQuery)
  })
}

export function resolveReferenceName(
  reference: ContextReference,
  threads: Thread[],
  projects: Project[]
): string {
  if (reference.kind === 'thread') {
    return threads.find((thread) => thread.id === reference.thread_id)?.title ?? 'Unavailable thread'
  }
  return projects.find((project) => project.id === reference.project_id)?.name ?? 'Unavailable project'
}
