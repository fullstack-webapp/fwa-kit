import type { LocalEdgeRevalidationProgress } from '../release.ts'

export const revalidationProgressBroadcastIntervalMs = 250

export function shouldBroadcastRevalidationProgress(
  nowMs: number,
  lastBroadcastAtMs: number | undefined,
  completedAssets: number,
  totalAssets: number,
) {
  if (totalAssets <= 0) {
    return false
  }
  if (completedAssets === totalAssets) {
    return true
  }
  return (
    lastBroadcastAtMs === undefined ||
    nowMs - lastBroadcastAtMs >= revalidationProgressBroadcastIntervalMs
  )
}

export interface RevalidationInstallState {
  progress: LocalEdgeRevalidationProgress | undefined
  lastBroadcastAtMs: number | undefined
}

export function beginRevalidationInstall(
  releaseId: string,
  totalAssets: number,
): RevalidationInstallState {
  return {
    progress: { releaseId, completedAssets: 0, totalAssets },
    lastBroadcastAtMs: undefined,
  }
}

export function recordCompletedAsset(
  state: RevalidationInstallState,
  nowMs: number,
): { state: RevalidationInstallState; shouldBroadcast: boolean } {
  const progress = state.progress
  if (!progress) {
    return { state, shouldBroadcast: false }
  }
  const completedAssets = progress.completedAssets + 1
  const nextProgress = { ...progress, completedAssets }
  const shouldBroadcast = shouldBroadcastRevalidationProgress(
    nowMs,
    state.lastBroadcastAtMs,
    completedAssets,
    progress.totalAssets,
  )
  return {
    state: {
      progress: nextProgress,
      lastBroadcastAtMs: shouldBroadcast ? nowMs : state.lastBroadcastAtMs,
    },
    shouldBroadcast,
  }
}
