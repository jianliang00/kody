export const RIGHT_RAIL_SECTION_IDS = [
  'context',
  'workspace',
  'references',
  'processes',
  'changes',
  'timeline',
  'projects'
] as const

export type RightRailSectionId = (typeof RIGHT_RAIL_SECTION_IDS)[number]
export type RightRailSectionsState = Record<RightRailSectionId, boolean>

export const RIGHT_RAIL_SECTIONS_STORAGE_KEY = 'kody.rightRailSections.v1'
export const LEGACY_INSPECTOR_COLLAPSED_STORAGE_KEY = 'kody.inspectorCollapsed'

export const DEFAULT_RIGHT_RAIL_SECTIONS: Readonly<RightRailSectionsState> = Object.freeze({
  context: true,
  workspace: false,
  references: false,
  processes: false,
  changes: false,
  timeline: false,
  projects: true
})

type ReadableStorage = Pick<Storage, 'getItem'>

function defaultRightRailSections(): RightRailSectionsState {
  return { ...DEFAULT_RIGHT_RAIL_SECTIONS }
}

function migrateLegacyInspectorState(storage: ReadableStorage): RightRailSectionsState {
  const sections = defaultRightRailSections()

  try {
    if (storage.getItem(LEGACY_INSPECTOR_COLLAPSED_STORAGE_KEY) !== 'false') return sections
  } catch {
    return sections
  }

  sections.workspace = true
  sections.references = true
  sections.processes = true
  sections.changes = true
  sections.timeline = true
  return sections
}

export function readStoredRightRailSections(storage: ReadableStorage): RightRailSectionsState {
  let stored: string | null
  try {
    stored = storage.getItem(RIGHT_RAIL_SECTIONS_STORAGE_KEY)
  } catch {
    return defaultRightRailSections()
  }

  if (stored === null) return migrateLegacyInspectorState(storage)

  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return defaultRightRailSections()
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultRightRailSections()
  }

  const sections = defaultRightRailSections()
  const values = parsed as Record<string, unknown>
  for (const id of RIGHT_RAIL_SECTION_IDS) {
    if (typeof values[id] === 'boolean') sections[id] = values[id]
  }
  return sections
}

export function serializeRightRailSections(state: RightRailSectionsState): string {
  const serializable = {} as RightRailSectionsState
  for (const id of RIGHT_RAIL_SECTION_IDS) serializable[id] = state[id]
  return JSON.stringify(serializable)
}

export function updateRightRailSection(
  state: RightRailSectionsState,
  id: RightRailSectionId,
  expanded: boolean
): RightRailSectionsState {
  return { ...state, [id]: expanded }
}

export function toggleRightRailSection(
  state: RightRailSectionsState,
  id: RightRailSectionId
): RightRailSectionsState {
  return updateRightRailSection(state, id, !state[id])
}
