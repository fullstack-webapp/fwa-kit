import { localEdgeDebugSeedFor } from '../config-contract.ts'
import { clearFwaDebugPositionPreference } from './debug-position.ts'

export const fwaDebugPreferenceKey = '__fwa_debug'

interface DebugPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function fwaDebugPreferenceEnabledFor(
  url: URL,
  storageProvider: () => DebugPreferenceStorage = () => window.localStorage,
) {
  const seed = localEdgeDebugSeedFor(url)
  if (seed) {
    try {
      const storage = storageProvider()
      if (seed === 'enable') {
        storage.setItem(fwaDebugPreferenceKey, '1')
      } else if (seed === 'reset') {
        storage.setItem(fwaDebugPreferenceKey, '1')
        clearFwaDebugPositionPreference(() => storage)
      } else {
        storage.removeItem(fwaDebugPreferenceKey)
      }
    } catch {
      // The URL remains a one-document fallback when storage is unavailable.
    }
    return seed === 'enable' || seed === 'reset'
  }

  try {
    return storageProvider().getItem(fwaDebugPreferenceKey) === '1'
  } catch {
    return false
  }
}

export function clearFwaDebugPreference(
  storageProvider: () => DebugPreferenceStorage = () => window.localStorage,
) {
  setFwaDebugPreference(false, storageProvider)
}

export function setFwaDebugPreference(
  enabled: boolean,
  storageProvider: () => DebugPreferenceStorage = () => window.localStorage,
) {
  try {
    if (enabled) {
      storageProvider().setItem(fwaDebugPreferenceKey, '1')
    } else {
      storageProvider().removeItem(fwaDebugPreferenceKey)
    }
  } catch {
    // The current document can still change its diagnostics surface.
  }
}
