import { useEffect, useState } from 'react'
import {
  fwaGlobalReadyEventName,
  getFwaLocalEdge,
  type LocalEdgeClientState,
} from '@fullstack-webapp/local-edge/client'

export interface LocalEdgeDebugState {
  available: boolean
  enabled: boolean
}

const unavailableDebugState: LocalEdgeDebugState = {
  available: false,
  enabled: false,
}

function initialLocalEdgeState(): LocalEdgeClientState {
  return (
    getFwaLocalEdge()?.getState() ??
    (import.meta.env.DEV
      ? {
          phase: 'network-only',
          controlled: false,
          revalidating: false,
          updateAvailable: false,
          message:
            '开发模式不加载 Local Edge loader；production build 才启用本地启动。',
        }
      : {
          phase: 'starting',
          controlled: false,
          revalidating: false,
          updateAvailable: false,
          message: '正在读取 Local Edge 状态…',
        })
  )
}

function readDebugState(): LocalEdgeDebugState {
  const state = getFwaLocalEdge()?.debug.getState()
  return state
    ? { available: true, enabled: state.enabled }
    : unavailableDebugState
}

export function useLocalEdgeClient() {
  const [localEdgeState, setLocalEdgeState] = useState(initialLocalEdgeState)
  const [debugState, setDebugState] = useState(readDebugState)

  useEffect(() => {
    let unsubscribeLocalEdge: (() => void) | undefined
    let unsubscribeDebug: (() => void) | undefined

    const connect = () => {
      unsubscribeLocalEdge?.()
      unsubscribeDebug?.()

      const localEdge = getFwaLocalEdge()
      if (!localEdge) {
        setDebugState(unavailableDebugState)
        return
      }

      unsubscribeLocalEdge = localEdge.subscribe(setLocalEdgeState)
      unsubscribeDebug = localEdge.debug.subscribe((state) => {
        setDebugState({ available: true, enabled: state.enabled })
      })
    }

    connect()
    window.addEventListener(fwaGlobalReadyEventName, connect)
    return () => {
      window.removeEventListener(fwaGlobalReadyEventName, connect)
      unsubscribeLocalEdge?.()
      unsubscribeDebug?.()
    }
  }, [])

  return {
    applyUpdate: () => getFwaLocalEdge()?.applyUpdate() ?? false,
    debugState,
    reset: async () => {
      const localEdge = getFwaLocalEdge()
      if (!localEdge) {
        throw new Error('Local Edge loader is unavailable')
      }
      await localEdge.reset()
    },
    setDebugEnabled: (enabled: boolean) => {
      const debug = getFwaLocalEdge()?.debug
      if (!debug) return false
      debug.setEnabled(enabled)
      return true
    },
    localEdgeState,
  }
}

export function formatReleaseId(releaseId?: string): string {
  return releaseId ? releaseId.slice(0, 8) : '—'
}
