export const fwaDebugPositionPreferenceKey = '__fwa_debug_position'
export const fwaDebugTriggerDefaultBottomOffset = 64
export const fwaDebugTriggerSize = 36
export const fwaDebugTriggerViewportInset = 14

export interface FwaDebugAnchor {
  bottom: number
  right: number
}

export interface FwaDebugPosition {
  x: number
  y: number
}

export type FwaDebugPositionPreference =
  | { kind: 'bottom-right'; anchor: FwaDebugAnchor }
  | { kind: 'legacy-top-left'; position: FwaDebugPosition }

interface DebugPositionStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

interface DebugPositionBounds {
  height: number
  inset: number
  itemHeight: number
  itemWidth: number
  width: number
}

export function readFwaDebugPositionPreference(
  storageProvider: () => DebugPositionStorage = () => window.localStorage,
): FwaDebugPositionPreference | undefined {
  try {
    const stored = storageProvider().getItem(fwaDebugPositionPreferenceKey)
    if (!stored) {
      return undefined
    }
    const value = JSON.parse(stored) as Record<string, unknown>
    if (isFiniteNumber(value.right) && isFiniteNumber(value.bottom)) {
      return {
        kind: 'bottom-right',
        anchor: { right: value.right, bottom: value.bottom },
      }
    }
    return isFiniteNumber(value.x) && isFiniteNumber(value.y)
      ? {
          kind: 'legacy-top-left',
          position: { x: value.x, y: value.y },
        }
      : undefined
  } catch {
    return undefined
  }
}

export function writeFwaDebugAnchor(
  anchor: FwaDebugAnchor,
  storageProvider: () => DebugPositionStorage = () => window.localStorage,
) {
  try {
    storageProvider().setItem(
      fwaDebugPositionPreferenceKey,
      JSON.stringify({
        right: Math.round(anchor.right),
        bottom: Math.round(anchor.bottom),
      }),
    )
  } catch {
    // A draggable trigger remains useful when storage is unavailable.
  }
}

export function clearFwaDebugPositionPreference(
  storageProvider: () => DebugPositionStorage = () => window.localStorage,
) {
  try {
    storageProvider().removeItem(fwaDebugPositionPreferenceKey)
  } catch {
    // Query reset still restores the current document when storage is unavailable.
  }
}

export function clampFwaDebugAnchor(
  anchor: FwaDebugAnchor,
  bounds: DebugPositionBounds,
): FwaDebugAnchor {
  return {
    right: clamp(
      anchor.right,
      bounds.inset,
      Math.max(bounds.inset, bounds.width - bounds.itemWidth - bounds.inset),
    ),
    bottom: clamp(
      anchor.bottom,
      bounds.inset,
      Math.max(
        bounds.inset,
        bounds.height - bounds.itemHeight - bounds.inset,
      ),
    ),
  }
}

export function fwaDebugAnchorForPosition(
  position: FwaDebugPosition,
  bounds: DebugPositionBounds,
): FwaDebugAnchor {
  const clamped = clampFwaDebugPosition(position, bounds)
  return {
    right: bounds.width - bounds.itemWidth - clamped.x,
    bottom: bounds.height - bounds.itemHeight - clamped.y,
  }
}

export function fwaDebugPositionForAnchor(
  anchor: FwaDebugAnchor,
  bounds: DebugPositionBounds,
): FwaDebugPosition {
  const clamped = clampFwaDebugAnchor(anchor, bounds)
  return {
    x: bounds.width - bounds.itemWidth - clamped.right,
    y: bounds.height - bounds.itemHeight - clamped.bottom,
  }
}

export function clampFwaDebugPosition(
  position: FwaDebugPosition,
  bounds: DebugPositionBounds,
): FwaDebugPosition {
  return {
    x: clamp(
      position.x,
      bounds.inset,
      Math.max(bounds.inset, bounds.width - bounds.itemWidth - bounds.inset),
    ),
    y: clamp(
      position.y,
      bounds.inset,
      Math.max(
        bounds.inset,
        bounds.height - bounds.itemHeight - bounds.inset,
      ),
    ),
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
