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
): RevalidationInstallState {
  const progress = state.progress
  if (!progress) {
    return state
  }
  const completedAssets = progress.completedAssets + 1
  const nextProgress = { ...progress, completedAssets }
  return shouldBroadcastRevalidationProgress(
    nowMs,
    state.lastBroadcastAtMs,
    completedAssets,
    progress.totalAssets,
  )
    ? { progress: nextProgress, lastBroadcastAtMs: nowMs }
    : { progress: nextProgress, lastBroadcastAtMs: state.lastBroadcastAtMs }
}
