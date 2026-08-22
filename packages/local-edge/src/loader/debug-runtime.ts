import {
  localEdgeDebugQueryParameter,
  localEdgeDebugSeedFor,
} from '../config-contract.ts'
import { installFwaDebugPanel } from './debug-panel.ts'
import {
  fwaDebugPreferenceEnabledFor,
  setFwaDebugPreference,
} from './debug-preference.ts'
import type {
  FwaDebugApi,
  FwaDebugState,
  FwaDebugStateListener,
  FwaLocalEdgeApi,
} from './loader-contract.ts'

interface FwaDebugRuntime extends FwaDebugApi {
  start(): void
}

const initialState: FwaDebugState = { enabled: false }

export function createFwaDebugRuntime(
  localEdgeProvider: () => FwaLocalEdgeApi,
): FwaDebugRuntime {
  const listeners = new Set<FwaDebugStateListener>()
  let state = initialState
  let started = false
  let destroyPanel: (() => void) | undefined

  const publish = (enabled: boolean) => {
    state = { enabled }
    for (const listener of listeners) {
      publishToListener(listener, state)
    }
  }

  const applyEnabled = (enabled: boolean) => {
    if (enabled && !destroyPanel) {
      destroyPanel = installFwaDebugPanel(localEdgeProvider(), () => {
        setEnabled(false)
      })
    } else if (!enabled && destroyPanel) {
      destroyPanel()
      destroyPanel = undefined
    }

    if (state.enabled !== enabled) {
      publish(enabled)
    }
  }

  const setEnabled = (enabled: boolean) => {
    setFwaDebugPreference(enabled)
    removeDebugSeedFromCurrentUrl()
    applyEnabled(enabled)
  }

  const start = () => {
    if (started) return
    started = true

    const currentUrl = new URL(window.location.href)
    const enabled = fwaDebugPreferenceEnabledFor(currentUrl)
    if (localEdgeDebugSeedFor(currentUrl) === 'reset') {
      removeDebugSeedFromCurrentUrl()
    }
    applyEnabled(enabled)
  }

  return {
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener)
      publishToListener(listener, state)
      return () => listeners.delete(listener)
    },
    setEnabled,
    start,
  }
}

function removeDebugSeedFromCurrentUrl() {
  const currentUrl = new URL(window.location.href)
  if (!currentUrl.searchParams.has(localEdgeDebugQueryParameter)) return

  currentUrl.searchParams.delete(localEdgeDebugQueryParameter)
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
    )
  } catch {
    // The runtime state and durable preference remain authoritative.
  }
}

function publishToListener(
  listener: FwaDebugStateListener,
  state: FwaDebugState,
) {
  try {
    listener({ ...state })
  } catch {
    // One host listener must not break other debug consumers.
  }
}
