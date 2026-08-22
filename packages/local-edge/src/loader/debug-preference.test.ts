import { describe, expect, it } from 'vitest'
import {
  clearFwaDebugPreference,
  fwaDebugPreferenceEnabledFor,
  fwaDebugPreferenceKey,
  setFwaDebugPreference,
} from './debug-preference.ts'
import { fwaDebugPositionPreferenceKey } from './debug-position.ts'

function memoryStorage(initial?: string, initialPosition?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) {
    values.set(fwaDebugPreferenceKey, initial)
  }
  if (initialPosition !== undefined) {
    values.set(fwaDebugPositionPreferenceKey, initialPosition)
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('FWA debug preference', () => {
  it('uses the query once to seed persistent diagnostics', () => {
    const storage = memoryStorage()
    const provider = () => storage

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/?__fwa_debug=1'),
        provider,
      ),
    ).toBe(true)
    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/inventory'),
        provider,
      ),
    ).toBe(true)
  })

  it('uses zero to clear the persistent preference', () => {
    const storage = memoryStorage('1')
    const provider = () => storage

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/?__fwa_debug=0'),
        provider,
      ),
    ).toBe(false)
    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/inventory'),
        provider,
      ),
    ).toBe(false)
  })

  it('uses reset to restore diagnostics and clear the saved position', () => {
    const storage = memoryStorage(undefined, '{"right":120,"bottom":246}')
    const provider = () => storage

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/?__fwa_debug=reset'),
        provider,
      ),
    ).toBe(true)
    expect(storage.getItem(fwaDebugPreferenceKey)).toBe('1')
    expect(storage.getItem(fwaDebugPositionPreferenceKey)).toBeNull()
  })

  it('keeps the current URL useful when localStorage is unavailable', () => {
    const unavailable = () => {
      throw new Error('storage unavailable')
    }

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/?__fwa_debug=1'),
        unavailable,
      ),
    ).toBe(true)
    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/'),
        unavailable,
      ),
    ).toBe(false)
  })

  it('does not let a malformed query overwrite stored state', () => {
    const storage = memoryStorage('1')

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL(
          'https://app.example/?__fwa_debug=0&__fwa_debug=1',
        ),
        () => storage,
      ),
    ).toBe(true)
  })

  it('clears the preference from an open diagnostics panel', () => {
    const storage = memoryStorage('1')

    clearFwaDebugPreference(() => storage)

    expect(
      fwaDebugPreferenceEnabledFor(
        new URL('https://app.example/inventory'),
        () => storage,
      ),
    ).toBe(false)
  })

  it('persists direct runtime enable and disable commands', () => {
    const storage = memoryStorage()
    const provider = () => storage

    setFwaDebugPreference(true, provider)
    expect(storage.getItem(fwaDebugPreferenceKey)).toBe('1')

    setFwaDebugPreference(false, provider)
    expect(storage.getItem(fwaDebugPreferenceKey)).toBeNull()
  })
})
