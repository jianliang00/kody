import { describe, expect, it } from 'vitest'

import {
  ASSET_RAIL_LIMITS,
  fitSidebarWidths,
  readStoredSidebarWidth,
  RIGHT_RAIL_LIMITS
} from './sidebarSizing'

describe('sidebar sizing', () => {
  it('loads and clamps persisted widths', () => {
    const storage = window.localStorage
    storage.setItem('left', '999')
    storage.setItem('right', 'not-a-number')

    expect(readStoredSidebarWidth(storage, 'left', ASSET_RAIL_LIMITS)).toBe(400)
    expect(readStoredSidebarWidth(storage, 'right', RIGHT_RAIL_LIMITS)).toBe(320)
  })

  it('preserves the minimum conversation width when both sidebars are wide', () => {
    const fitted = fitSidebarWidths(1_153, 400, 480, true, true)

    expect(fitted.left).toBeGreaterThanOrEqual(ASSET_RAIL_LIMITS.minWidth)
    expect(fitted.right).toBeGreaterThanOrEqual(RIGHT_RAIL_LIMITS.minWidth)
    expect(fitted.left + fitted.right).toBeLessThanOrEqual(1_153 - 448)
  })

  it('does not reserve space for a sidebar rendered as a drawer', () => {
    expect(fitSidebarWidths(1_000, 400, 480, true, false)).toEqual({ left: 400, right: 480 })
  })
})
