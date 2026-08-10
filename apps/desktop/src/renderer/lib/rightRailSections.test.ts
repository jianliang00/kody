import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RIGHT_RAIL_SECTIONS,
  LEGACY_INSPECTOR_COLLAPSED_STORAGE_KEY,
  readStoredRightRailSections,
  RIGHT_RAIL_SECTION_IDS,
  RIGHT_RAIL_SECTIONS_STORAGE_KEY,
  serializeRightRailSections,
  toggleRightRailSection,
  updateRightRailSection
} from './rightRailSections'

describe('right rail section state', () => {
  beforeEach(() => window.localStorage.clear())

  it('defines the supported sections and default expansion', () => {
    expect(RIGHT_RAIL_SECTION_IDS).toEqual([
      'context',
      'workspace',
      'changes',
      'timeline'
    ])
    expect(DEFAULT_RIGHT_RAIL_SECTIONS).toEqual({
      context: true,
      workspace: false,
      changes: false,
      timeline: false
    })
  })

  it('loads boolean values and fills missing or invalid fields from defaults', () => {
    window.localStorage.setItem(RIGHT_RAIL_SECTIONS_STORAGE_KEY, JSON.stringify({
      context: false,
      workspace: true,
      // Removed duplicate detail sections from older builds are ignored.
      references: 'true',
      processes: true,
      changes: null,
      // Removed section keys from older builds are ignored.
      projects: false,
      unknown: true
    }))

    expect(readStoredRightRailSections(window.localStorage)).toEqual({
      context: false,
      workspace: true,
      changes: false,
      timeline: false
    })
  })

  it.each(['{bad json', 'null', '[]', 'true'])('falls back for invalid JSON state: %s', (stored) => {
    window.localStorage.setItem(RIGHT_RAIL_SECTIONS_STORAGE_KEY, stored)

    expect(readStoredRightRailSections(window.localStorage)).toEqual(DEFAULT_RIGHT_RAIL_SECTIONS)
  })

  it('migrates an explicitly expanded legacy inspector only when the new key is absent', () => {
    window.localStorage.setItem(LEGACY_INSPECTOR_COLLAPSED_STORAGE_KEY, 'false')

    expect(readStoredRightRailSections(window.localStorage)).toEqual({
      context: true,
      workspace: true,
      changes: true,
      timeline: true
    })

    window.localStorage.setItem(RIGHT_RAIL_SECTIONS_STORAGE_KEY, '{bad json')
    expect(readStoredRightRailSections(window.localStorage)).toEqual(DEFAULT_RIGHT_RAIL_SECTIONS)
  })

  it('keeps defaults for other legacy values and storage access failures', () => {
    window.localStorage.setItem(LEGACY_INSPECTOR_COLLAPSED_STORAGE_KEY, 'true')
    expect(readStoredRightRailSections(window.localStorage)).toEqual(DEFAULT_RIGHT_RAIL_SECTIONS)

    expect(readStoredRightRailSections({
      getItem: () => {
        throw new Error('storage unavailable')
      }
    })).toEqual(DEFAULT_RIGHT_RAIL_SECTIONS)
  })

  it('serializes only known sections in stable order', () => {
    const state = {
      ...DEFAULT_RIGHT_RAIL_SECTIONS,
      context: false,
      changes: true,
      ignored: true
    }

    expect(serializeRightRailSections(state)).toBe(JSON.stringify({
      context: false,
      workspace: false,
      changes: true,
      timeline: false
    }))
  })

  it('updates and toggles sections without mutating the prior state', () => {
    const initial = { ...DEFAULT_RIGHT_RAIL_SECTIONS }
    const updated = updateRightRailSection(initial, 'workspace', true)
    const toggled = toggleRightRailSection(updated, 'context')

    expect(initial.workspace).toBe(false)
    expect(updated).toEqual({ ...initial, workspace: true })
    expect(toggled).toEqual({ ...updated, context: false })
  })
})
