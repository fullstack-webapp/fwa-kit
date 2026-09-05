import type {
  LocalEdgeRevalidationProgress,
  LocalEdgeRevalidationResult,
  LocalEdgeSnapshot,
} from './release.ts'

export interface KernelObservationIdentity {
  kernelInstanceId: string
  observationRevision: number
}

export interface KernelRevalidationProgress
  extends KernelObservationIdentity,
    LocalEdgeRevalidationProgress {
  attemptId: number
}

export interface OrderedLocalEdgeSnapshot
  extends Omit<LocalEdgeSnapshot, 'revalidation'>,
    KernelObservationIdentity {
  revalidation?: KernelRevalidationProgress
}

export interface OrderedLocalEdgeRevalidationResult
  extends LocalEdgeRevalidationResult,
    KernelObservationIdentity {
  attemptId?: number
}

export interface KernelRevalidationMessage
  extends KernelObservationIdentity {
  type: string
  attemptId: number
  releaseId: string
  completedAssets?: number
  totalAssets?: number
}

export interface RevalidationAttemptBinding {
  attemptId: number
  releaseId: string
  totalAssets?: number
}

export type RevalidationObservationCursor =
  | { phase: 'unknown' }
  | {
      phase: 'running' | 'settled'
      kernelInstanceId: string
      observationRevision: number
      attempt?: RevalidationAttemptBinding
      progress?: LocalEdgeRevalidationProgress
    }

export type RevalidationObservation =
  | {
      kind: 'progress'
      identity: KernelObservationIdentity
      attempt: RevalidationAttemptBinding & { totalAssets: number }
      completedAssets: number
    }
  | {
      kind: 'terminal'
      identity: KernelObservationIdentity
      attempt: RevalidationAttemptBinding
    }
  | {
      kind: 'snapshot'
      identity: KernelObservationIdentity
      progress?: KernelRevalidationProgress
    }

export interface RevalidationObservationDecision {
  cursor: RevalidationObservationCursor
  accepted: boolean
  applySnapshot: boolean
  protocolConflict: boolean
}

export function reduceRevalidationObservation(
  cursor: RevalidationObservationCursor,
  observation: RevalidationObservation,
): RevalidationObservationDecision {
  if (
    cursor.phase !== 'unknown' &&
    observation.identity.kernelInstanceId !== cursor.kernelInstanceId
  ) {
    if (observation.kind !== 'snapshot') {
      return rejected(cursor, false)
    }
    return accepted(cursorFromObservation(observation), true)
  }

  if (cursor.phase === 'unknown') {
    return accepted(
      cursorFromObservation(observation),
      observation.kind === 'snapshot',
    )
  }

  const revisionDelta =
    observation.identity.observationRevision - cursor.observationRevision
  if (revisionDelta < 0) {
    return rejected(cursor, false)
  }
  if (revisionDelta > 0) {
    if (!isForwardObservationCompatible(cursor, observation)) {
      return rejected(cursor, true)
    }
    return accepted(
      cursorFromObservation(observation),
      observation.kind === 'snapshot',
    )
  }

  return reduceEqualRevision(cursor, observation)
}

function reduceEqualRevision(
  cursor: Exclude<RevalidationObservationCursor, { phase: 'unknown' }>,
  observation: RevalidationObservation,
): RevalidationObservationDecision {
  if (observation.kind === 'snapshot') {
    if (observation.progress) {
      const attempt = bindingFromProgress(observation.progress)
      if (
        cursor.phase !== 'running' ||
        !bindingsAgree(cursor.attempt, attempt) ||
        !progressAgrees(cursor.progress, observation.progress)
      ) {
        return rejected(cursor, true)
      }
      return accepted(cursor, true)
    }

    if (cursor.phase === 'running') {
      return rejected(cursor, true)
    }
    // A terminal event/response is a partial view of the same settled kernel
    // state. The equal-revision snapshot is authoritative enrichment and may
    // publish the active release projection.
    return accepted(cursor, true)
  }

  if (observation.kind === 'progress') {
    const attempt = observation.attempt
    if (
      cursor.phase !== 'running' ||
      !bindingsAgree(cursor.attempt, attempt) ||
      cursor.progress?.completedAssets !== observation.completedAssets
    ) {
      return rejected(cursor, true)
    }
    return accepted(cursor, false)
  }

  if (cursor.phase !== 'settled') {
    return rejected(cursor, true)
  }
  if (cursor.attempt && !bindingsAgree(cursor.attempt, observation.attempt)) {
    return rejected(cursor, true)
  }
  return accepted(
    cursor.attempt
      ? cursor
      : { ...cursor, attempt: observation.attempt },
    false,
  )
}

function isForwardObservationCompatible(
  cursor: Exclude<RevalidationObservationCursor, { phase: 'unknown' }>,
  observation: RevalidationObservation,
) {
  const nextAttempt =
    observation.kind === 'progress'
      ? observation.attempt
      : observation.kind === 'terminal'
        ? observation.attempt
        : observation.progress
          ? bindingFromProgress(observation.progress)
          : undefined
  if (!nextAttempt || !cursor.attempt) {
    return true
  }
  if (nextAttempt.attemptId < cursor.attempt.attemptId) {
    return false
  }
  if (nextAttempt.attemptId > cursor.attempt.attemptId) {
    return true
  }
  if (!bindingsAgree(cursor.attempt, nextAttempt)) {
    return false
  }
  if (observation.kind === 'terminal') {
    return true
  }
  if (observation.kind === 'snapshot' && !observation.progress) {
    return true
  }
  if (cursor.phase === 'settled') {
    return false
  }
  const nextCompleted =
    observation.kind === 'progress'
      ? observation.completedAssets
      : observation.progress?.completedAssets
  return (
    nextCompleted !== undefined &&
    (cursor.progress === undefined ||
      nextCompleted >= cursor.progress.completedAssets)
  )
}

function cursorFromObservation(
  observation: RevalidationObservation,
): Exclude<RevalidationObservationCursor, { phase: 'unknown' }> {
  const identity = observation.identity
  if (observation.kind === 'progress') {
    return {
      phase: 'running',
      ...identity,
      attempt: observation.attempt,
      progress: {
        releaseId: observation.attempt.releaseId,
        completedAssets: observation.completedAssets,
        totalAssets: observation.attempt.totalAssets,
      },
    }
  }
  if (observation.kind === 'terminal') {
    return {
      phase: 'settled',
      ...identity,
      attempt: observation.attempt,
    }
  }
  if (observation.progress) {
    return {
      phase: 'running',
      ...identity,
      attempt: bindingFromProgress(observation.progress),
      progress: publicProgress(observation.progress),
    }
  }
  return { phase: 'settled', ...identity }
}

function bindingsAgree(
  left: RevalidationAttemptBinding | undefined,
  right: RevalidationAttemptBinding,
) {
  return (
    left !== undefined &&
    left.attemptId === right.attemptId &&
    left.releaseId === right.releaseId &&
    (left.totalAssets === undefined ||
      right.totalAssets === undefined ||
      left.totalAssets === right.totalAssets)
  )
}

function progressAgrees(
  left: LocalEdgeRevalidationProgress | undefined,
  right: KernelRevalidationProgress,
) {
  return (
    left !== undefined &&
    left.releaseId === right.releaseId &&
    left.completedAssets === right.completedAssets &&
    left.totalAssets === right.totalAssets
  )
}

function bindingFromProgress(
  progress: KernelRevalidationProgress,
): RevalidationAttemptBinding & { totalAssets: number } {
  return {
    attemptId: progress.attemptId,
    releaseId: progress.releaseId,
    totalAssets: progress.totalAssets,
  }
}

function publicProgress(
  progress: KernelRevalidationProgress,
): LocalEdgeRevalidationProgress {
  return {
    releaseId: progress.releaseId,
    completedAssets: progress.completedAssets,
    totalAssets: progress.totalAssets,
  }
}

function accepted(
  cursor: RevalidationObservationCursor,
  applySnapshot: boolean,
): RevalidationObservationDecision {
  return {
    cursor,
    accepted: true,
    applySnapshot,
    protocolConflict: false,
  }
}

function rejected(
  cursor: RevalidationObservationCursor,
  protocolConflict: boolean,
): RevalidationObservationDecision {
  return {
    cursor,
    accepted: false,
    applySnapshot: false,
    protocolConflict,
  }
}

export function isKernelObservationIdentity(
  value: unknown,
): value is KernelObservationIdentity {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.kernelInstanceId === 'string' &&
    value.kernelInstanceId.length > 0 &&
    value.kernelInstanceId.length <= 128 &&
    isObservationNumber(value.observationRevision)
  )
}

export function isKernelRevalidationProgress(
  value: unknown,
): value is KernelRevalidationProgress {
  if (!isRecord(value) || !isKernelObservationIdentity(value)) {
    return false
  }
  return (
    isObservationNumber(value.attemptId) &&
    value.attemptId > 0 &&
    value.attemptId <= value.observationRevision &&
    typeof value.releaseId === 'string' &&
    value.releaseId.length > 0 &&
    isObservationNumber(value.totalAssets) &&
    value.totalAssets > 0 &&
    isObservationNumber(value.completedAssets) &&
    value.completedAssets <= value.totalAssets
  )
}

export function isOrderedLocalEdgeSnapshot(
  value: unknown,
): value is OrderedLocalEdgeSnapshot {
  if (
    !isRecord(value) ||
    !isKernelObservationIdentity(value) ||
    !isSnapshotBase(value)
  ) {
    return false
  }
  return (
    value.revalidation === undefined ||
    (isKernelRevalidationProgress(value.revalidation) &&
      value.revalidation.kernelInstanceId === value.kernelInstanceId &&
      value.revalidation.observationRevision === value.observationRevision)
  )
}

export function isOrderedRevalidationResult(
  value: unknown,
): value is OrderedLocalEdgeRevalidationResult {
  if (
    !isRecord(value) ||
    !isKernelObservationIdentity(value) ||
    !isRevalidationResultBase(value)
  ) {
    return false
  }
  const needsAttempt =
    value.status === 'installed' ||
    value.status === 'repaired' ||
    value.status === 'updated'
  return needsAttempt
    ? isObservationNumber(value.attemptId) &&
        value.attemptId > 0 &&
        value.attemptId <= value.observationRevision
    : value.attemptId === undefined ||
        (isObservationNumber(value.attemptId) && value.attemptId > 0)
}

function isSnapshotBase(value: Record<string, unknown>) {
  if (
    typeof value.localEdgeEnabled !== 'boolean' ||
    (value.mode !== 'active' &&
      value.mode !== 'disabled' &&
      value.mode !== 'network-only')
  ) {
    return false
  }
  if (value.mode === 'active') {
    return value.localEdgeEnabled && isReleaseLike(value.release)
  }
  if (value.mode === 'disabled') {
    return !value.localEdgeEnabled
  }
  return value.release === undefined
}

function isRevalidationResultBase(value: Record<string, unknown>) {
  return (
    typeof value.localEdgeEnabled === 'boolean' &&
    (value.status === 'current' ||
      value.status === 'disabled' ||
      value.status === 'disabled-current' ||
      value.status === 'enabled' ||
      value.status === 'installed' ||
      value.status === 'repaired' ||
      value.status === 'updated') &&
    (value.release === undefined || isReleaseLike(value.release))
  )
}

function isReleaseLike(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.releaseId === 'string' &&
    value.releaseId.length > 0
  )
}

function isObservationNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
