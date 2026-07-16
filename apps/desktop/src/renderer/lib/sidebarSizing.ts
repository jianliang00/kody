export interface SidebarLimits {
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

export interface FittedSidebarWidths {
  left: number
  right: number
}

export const ASSET_RAIL_LIMITS: SidebarLimits = {
  defaultWidth: 272,
  minWidth: 224,
  maxWidth: 400
}

export const RIGHT_RAIL_LIMITS: SidebarLimits = {
  defaultWidth: 320,
  minWidth: 288,
  maxWidth: 480
}

export const MINIMUM_CONVERSATION_WIDTH = 448

export function clampSidebarWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.round(Math.min(Math.max(value, minWidth), Math.max(minWidth, maxWidth)))
}

export function readStoredSidebarWidth(
  storage: Storage,
  key: string,
  limits: SidebarLimits
): number {
  try {
    const stored = Number(storage.getItem(key))
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored, limits.minWidth, limits.maxWidth)
      : limits.defaultWidth
  } catch {
    return limits.defaultWidth
  }
}

export function fitSidebarWidths(
  viewportWidth: number,
  desiredLeft: number,
  desiredRight: number,
  leftVisible: boolean,
  rightVisible: boolean
): FittedSidebarWidths {
  let left = clampSidebarWidth(
    desiredLeft,
    ASSET_RAIL_LIMITS.minWidth,
    ASSET_RAIL_LIMITS.maxWidth
  )
  let right = clampSidebarWidth(
    desiredRight,
    RIGHT_RAIL_LIMITS.minWidth,
    RIGHT_RAIL_LIMITS.maxWidth
  )
  const available = Math.max(0, viewportWidth - MINIMUM_CONVERSATION_WIDTH)
  let overflow = (leftVisible ? left : 0) + (rightVisible ? right : 0) - available

  if (overflow <= 0) return { left, right }

  const leftFlex = leftVisible ? left - ASSET_RAIL_LIMITS.minWidth : 0
  const rightFlex = rightVisible ? right - RIGHT_RAIL_LIMITS.minWidth : 0
  const totalFlex = leftFlex + rightFlex

  if (totalFlex > 0) {
    const leftReduction = Math.min(leftFlex, Math.round(overflow * (leftFlex / totalFlex)))
    left -= leftReduction
    overflow -= leftReduction

    const rightReduction = Math.min(rightFlex, overflow)
    right -= rightReduction
    overflow -= rightReduction

    if (overflow > 0) left -= Math.min(left - ASSET_RAIL_LIMITS.minWidth, overflow)
  }

  return {
    left: clampSidebarWidth(left, ASSET_RAIL_LIMITS.minWidth, ASSET_RAIL_LIMITS.maxWidth),
    right: clampSidebarWidth(right, RIGHT_RAIL_LIMITS.minWidth, RIGHT_RAIL_LIMITS.maxWidth)
  }
}
