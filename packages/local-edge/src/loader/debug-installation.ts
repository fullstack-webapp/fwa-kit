import type { LocalEdgeSnapshot } from '../release.ts'
import type { LocalEdgeClientState } from './loader-contract.ts'

export type DebugInstallationState =
  | 'checking'
  | 'installing'
  | 'updating'
  | 'installed'
  | 'bypassed'
  | 'not-installed'
  | 'incomplete'
  | 'unavailable'
  | 'unsupported'

export interface DebugInstallationDiagnostic {
  detail: string
  label: string
  state: DebugInstallationState
}

export interface DebugInstallationEvidence {
  activeRelease?: {
    assetCount: number
    releaseId: string
  }
  caches: readonly {
    complete?: boolean
    entryCount: number
    expectedAssetCount?: number
    missingAssetCount?: number
    releaseId?: string
  }[]
  hasErrors: boolean
  kernel?: {
    localEdgeEnabled: boolean
    mode: LocalEdgeSnapshot['mode']
  }
  serviceWorker: {
    installing?: string
    supported: boolean
    waiting?: string
  }
  localEdgePhase: LocalEdgeClientState['phase']
  revalidating: boolean
}

export function deriveDebugInstallation(
  evidence: DebugInstallationEvidence,
): DebugInstallationDiagnostic {
  if (!evidence.serviceWorker.supported) {
    return diagnostic(
      'unsupported',
      'Unsupported',
      'Service Worker is unavailable',
    )
  }

  if (evidence.activeRelease) {
    return installedReleaseDiagnostic(evidence, evidence.activeRelease)
  }

  if (
    evidence.localEdgePhase === 'network-only' &&
    evidence.kernel?.mode !== 'disabled'
  ) {
    return diagnostic(
      'bypassed',
      'Bypassed',
      'This page intentionally uses the network baseline',
    )
  }

  if (
    evidence.localEdgePhase === 'starting' ||
    evidence.localEdgePhase === 'registering' ||
    evidence.serviceWorker.installing !== undefined ||
    evidence.serviceWorker.waiting !== undefined
  ) {
    return diagnostic(
      'installing',
      'Installing',
      'Preparing the Local Edge runtime',
    )
  }

  if (evidence.kernel) {
    return diagnostic(
      'not-installed',
      'Not installed',
      evidence.kernel.localEdgeEnabled
        ? 'No committed release'
        : 'Disabled with no committed release',
    )
  }

  if (evidence.localEdgePhase === 'error' || evidence.hasErrors) {
    return diagnostic(
      'unavailable',
      'Unavailable',
      'Installation state could not be verified',
    )
  }

  return diagnostic(
    'checking',
    'Checking',
    'Reading release and cache state',
  )
}

export function provisionalDebugInstallation(
  localEdgeState: LocalEdgeClientState,
): DebugInstallationDiagnostic {
  if (localEdgeState.revalidating) {
    return diagnostic(
      'updating',
      'Updating',
      localEdgeState.releaseId
        ? 'Checking for and downloading a newer release'
        : 'Downloading the initial release',
    )
  }

  switch (localEdgeState.phase) {
    case 'unsupported':
      return diagnostic(
        'unsupported',
        'Unsupported',
        'Service Worker is unavailable',
      )
    case 'registering':
      return diagnostic(
        'installing',
        'Installing',
        'Preparing the Local Edge runtime',
      )
    case 'network-only':
      return diagnostic(
        'bypassed',
        'Bypassed',
        'This page intentionally uses the network baseline',
      )
    case 'error':
      return diagnostic(
        'unavailable',
        'Unavailable',
        'Installation state could not be verified',
      )
    default:
      return diagnostic(
        'checking',
        'Checking',
        'Reading release and cache state',
      )
  }
}

function installedReleaseDiagnostic(
  evidence: DebugInstallationEvidence,
  activeRelease: NonNullable<DebugInstallationEvidence['activeRelease']>,
) {
  const releaseCache = evidence.caches.find(
    (cache) => cache.releaseId === activeRelease.releaseId,
  )
  if (releaseCache?.complete) {
    const expectedAssetCount =
      releaseCache.expectedAssetCount ?? activeRelease.assetCount
    const availability =
      evidence.kernel?.mode === 'disabled'
        ? 'cached while disabled'
        : evidence.localEdgePhase === 'network-only'
          ? 'cached while this page bypasses Local Edge'
          : 'offline ready'
    return evidence.revalidating
      ? diagnostic(
          'updating',
          'Updating',
          `${releaseCache.entryCount}/${expectedAssetCount} current assets remain offline ready`,
        )
      : diagnostic(
          'installed',
          'Installed',
          `${releaseCache.entryCount}/${expectedAssetCount} assets · ${availability}`,
        )
  }

  if (releaseCache) {
    const expectedAssetCount =
      releaseCache.expectedAssetCount ?? activeRelease.assetCount
    return diagnostic(
      'incomplete',
      'Incomplete',
      `${releaseCache.entryCount}/${expectedAssetCount} assets · ${releaseCache.missingAssetCount ?? 'unknown'} missing`,
    )
  }

  return diagnostic(
    'incomplete',
    'Incomplete',
    'Committed release cache is missing',
  )
}

function diagnostic(
  state: DebugInstallationState,
  label: string,
  detail: string,
): DebugInstallationDiagnostic {
  return { detail, label, state }
}
