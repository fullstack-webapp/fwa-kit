import type { FwaLoaderPaths } from './loader-paths.ts'
import type { LocalEdgeRevalidationProgress } from '../release.ts'

export {
  deriveFwaLoaderPaths,
  type FwaLoaderPaths,
} from './loader-paths.ts'

export type { LocalEdgeRevalidationProgress }

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
  revalidationProgress?: LocalEdgeRevalidationProgress
  message: string
}

export type LocalEdgeStateListener = (state: LocalEdgeClientState) => void

export interface LocalEdgeUpdateCheckCommandConfig {
  enabled?: boolean
  intervalMinutes?: number
}

export type LocalEdgeRevalidationOutcome =
  | 'current'
  | 'updated'
  | 'failed'
  | 'disabled'

export interface FwaDebugState {
  enabled: boolean
}

export type FwaDebugStateListener = (state: FwaDebugState) => void

/**
 * Replaces the current document URL with `url` (path, search and hash) without
 * adding a history entry. Hosts whose router owns history register one so the
 * loader never writes history behind the router's back.
 */
export type FwaUrlWriter = (url: string) => void

export interface FwaDebugApi {
  getState(): FwaDebugState
  subscribe(listener: FwaDebugStateListener): () => void
  setEnabled(enabled: boolean): void
  /**
   * Register how the loader removes `__fwa_debug` after a diagnostics change.
   * `null` restores the default direct `history.replaceState`.
   */
  setUrlWriter(writer: FwaUrlWriter | null): void
}

export interface FwaLocalEdgeApi {
  readonly paths: Readonly<FwaLoaderPaths>
  readonly debug: FwaDebugApi
  getState(): LocalEdgeClientState
  subscribe(listener: LocalEdgeStateListener): () => void
  revalidate(): Promise<LocalEdgeRevalidationOutcome>
  setUpdateCheck(updateCheck: LocalEdgeUpdateCheckCommandConfig): void
  applyUpdate(): boolean
  reset(): Promise<void>
  networkUrl(currentUrl?: string): string
  openNetwork(): void
}

export type FwaQueuedCommand =
  | readonly ['localEdge.getState', (state: LocalEdgeClientState) => void]
  | readonly ['localEdge.subscribe', LocalEdgeStateListener]
  | readonly ['localEdge.revalidate']
  | readonly ['localEdge.setUpdateCheck', LocalEdgeUpdateCheckCommandConfig]
  | readonly ['localEdge.applyUpdate']
  | readonly ['localEdge.reset']
  | readonly ['localEdge.openNetwork']
  | readonly ['debug.getState', (state: FwaDebugState) => void]
  | readonly ['debug.subscribe', FwaDebugStateListener]
  | readonly ['debug.setEnabled', boolean]
  | readonly ['debug.setUrlWriter', FwaUrlWriter | null]

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
