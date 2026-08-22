import { describe, expect, it } from 'vitest'
import {
  clampFwaDebugAnchor,
  clampFwaDebugPosition,
  clearFwaDebugPositionPreference,
  fwaDebugAnchorForPosition,
  fwaDebugPositionForAnchor,
  fwaDebugPositionPreferenceKey,
  readFwaDebugPositionPreference,
  writeFwaDebugAnchor,
} from './debug-position.ts'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) {
    values.set(fwaDebugPositionPreferenceKey, initial)
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('FWA debug trigger position', () => {
  it('round-trips a bottom-right anchor', () => {
    const storage = memoryStorage()

    writeFwaDebugAnchor({ right: 120.4, bottom: 245.7 }, () => storage)

    expect(readFwaDebugPositionPreference(() => storage)).toEqual({
      kind: 'bottom-right',
      anchor: { right: 120, bottom: 246 },
    })
  })

  it('reads the previous top-left shape for migration', () => {
    expect(
      readFwaDebugPositionPreference(() =>
        memoryStorage('{"x":120,"y":246}'),
      ),
    ).toEqual({
      kind: 'legacy-top-left',
      position: { x: 120, y: 246 },
    })
  })

  it('ignores malformed or unavailable storage', () => {
    expect(
      readFwaDebugPositionPreference(() =>
        memoryStorage('{"right":"edge","bottom":12}'),
      ),
    ).toBeUndefined()
    expect(
      readFwaDebugPositionPreference(() => {
        throw new Error('storage unavailable')
      }),
    ).toBeUndefined()
  })

  it('clears the saved anchor for query recovery', () => {
    const storage = memoryStorage('{"right":120,"bottom":246}')

    clearFwaDebugPositionPreference(() => storage)

    expect(readFwaDebugPositionPreference(() => storage)).toBeUndefined()
  })

  it('keeps the trigger inside the current viewport', () => {
    const bounds = {
      width: 390,
      height: 844,
      itemWidth: 48,
      itemHeight: 48,
      inset: 12,
    }

    expect(clampFwaDebugPosition({ x: -20, y: 900 }, bounds)).toEqual({
      x: 12,
      y: 784,
    })
    expect(clampFwaDebugAnchor({ right: 900, bottom: -20 }, bounds)).toEqual({
      right: 330,
      bottom: 12,
    })
  })

  it('preserves a bottom-right anchor across viewport sizes', () => {
    const initialBounds = {
      width: 1280,
      height: 720,
      itemWidth: 48,
      itemHeight: 48,
      inset: 12,
    }
    const anchor = fwaDebugAnchorForPosition({ x: 80, y: 120 }, initialBounds)

    expect(anchor).toEqual({ right: 1152, bottom: 552 })
    expect(
      fwaDebugPositionForAnchor(anchor, {
        ...initialBounds,
        width: 1440,
        height: 900,
      }),
    ).toEqual({ x: 240, y: 300 })
    expect(
      fwaDebugPositionForAnchor(anchor, {
        ...initialBounds,
        width: 390,
        height: 480,
      }),
    ).toEqual({ x: 12, y: 12 })
  })
})
