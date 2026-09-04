export interface AppReleaseAsset {
  path: string
  mediaType: string
  size: number
  digest: string
}

export interface LegacyAppRelease {
  schemaVersion: 1
  appId: string
  releaseId: string
  appEntry: string
  coreAssets: readonly string[]
}

export interface VerifiedAppRelease {
  schemaVersion: 2
  appId: string
  releaseId: string
  appEntry: string
  assets: readonly AppReleaseAsset[]
}

export type AppRelease = LegacyAppRelease | VerifiedAppRelease

export interface AppReleaseDescriptor {
  localEdgeEnabled: boolean
  release?: VerifiedAppRelease
}

export interface LocalEdgeRevalidationProgress {
  releaseId: string
  completedAssets: number
  totalAssets: number
}

export interface LocalEdgeSnapshot {
  localEdgeEnabled: boolean
  mode: 'active' | 'disabled' | 'network-only'
  release?: AppRelease
  retainedReleases?: readonly AppRelease[]
  revalidation?: LocalEdgeRevalidationProgress
}

export type LocalEdgeRevalidationStatus =
  | 'current'
  | 'disabled'
  | 'disabled-current'
  | 'enabled'
  | 'installed'
  | 'repaired'
  | 'updated'

export interface LocalEdgeRevalidationResult {
  status: LocalEdgeRevalidationStatus
  localEdgeEnabled: boolean
  release?: AppRelease
}

export function releaseAssetPaths(release: AppRelease) {
  return release.schemaVersion === 1
    ? release.coreAssets
    : release.assets.map((asset) => asset.path)
}
