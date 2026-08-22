import type { FwaLoaderPaths } from './loader-paths.ts'

export {
  deriveFwaLoaderPaths,
  type FwaLoaderPaths,
} from './loader-paths.ts'

export const fwaGlobalReadyEventName = '__fwa:ready'
export const fwaLoaderVersion = '0.1.0-beta.0'

export type LocalEdgeClientPhase =
  | 'unsupported'
  | 'network-only'
  | 'starting'
  | 'registering'
  | 'ready'
  | 'error'

export interface LocalEdgeClientState {
  phase: LocalEdgeClientPhase
  controlled: boolean
  releaseId?: string
  availableReleaseId?: string
  revalidating: boolean
  updateAvailable: boolean
  message: string
}

export type LocalEdgeStateListener = (state: LocalEdgeClientState) => void

export type LocalEdgeRevalidationOutcome =
  | 'current'
  | 'updated'
  | 'failed'
  | 'disabled'

export interface FwaDebugState {
  enabled: boolean
}

export type FwaDebugStateListener = (state: FwaDebugState) => void

export interface FwaDebugApi {
  getState(): FwaDebugState
  subscribe(listener: FwaDebugStateListener): () => void
  setEnabled(enabled: boolean): void
}

export interface FwaLocalEdgeApi {
  readonly paths: Readonly<FwaLoaderPaths>
  readonly debug: FwaDebugApi
  getState(): LocalEdgeClientState
  subscribe(listener: LocalEdgeStateListener): () => void
  revalidate(): Promise<LocalEdgeRevalidationOutcome>
  applyUpdate(): boolean
  reset(): Promise<void>
  networkUrl(currentUrl?: string): string
  openNetwork(): void
}

export type FwaQueuedCommand =
  | readonly ['localEdge.getState', (state: LocalEdgeClientState) => void]
  | readonly ['localEdge.subscribe', LocalEdgeStateListener]
  | readonly ['localEdge.revalidate']
  | readonly ['localEdge.applyUpdate']
  | readonly ['localEdge.reset']
  | readonly ['localEdge.openNetwork']
  | readonly ['debug.getState', (state: FwaDebugState) => void]
  | readonly ['debug.subscribe', FwaDebugStateListener]
  | readonly ['debug.setEnabled', boolean]

export interface FwaGlobal {
  q: FwaQueuedCommand[]
  localEdge?: FwaLocalEdgeApi
  version?: string
}

declare global {
  interface Window {
    __fwa?: FwaGlobal
  }
}

export function getFwaLocalEdge() {
  return typeof window === 'undefined' ? undefined : window.__fwa?.localEdge
}
