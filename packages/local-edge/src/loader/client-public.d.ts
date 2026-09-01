export type LocalEdgeClientPhase =
  | 'unsupported'
  | 'network-only'
  | 'starting'
  | 'registering'
  | 'ready'
  | 'error'

export interface FwaLoaderPaths {
  scopePath: string
  workerPath: string
  descriptorPath: string
  controlPrefix: string
  loaderPath: string
  statePath: string
  revalidatePath: string
}

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

export interface FwaGlobal {
  q: FwaQueuedCommand[]
  localEdge?: FwaLocalEdgeApi
  version?: string
}

export declare const fwaGlobalReadyEventName: '__fwa:ready'
export declare function getFwaLocalEdge(): FwaLocalEdgeApi | undefined
