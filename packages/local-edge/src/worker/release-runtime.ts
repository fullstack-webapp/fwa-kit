import { localEdgeConfig } from '../config.ts'
import {
  fwaRevalidationCommittedMessageType,
  fwaRevalidationFailedMessageType,
  fwaRevalidationProgressMessageType,
} from '../config-contract.ts'
import {
  releaseAssetPaths,
  type AppRelease,
  type LocalEdgeRevalidationResult,
  type VerifiedAppRelease,
} from '../release.ts'
import type {
  KernelRevalidationProgress,
  OrderedLocalEdgeRevalidationResult,
  OrderedLocalEdgeSnapshot,
} from '../revalidation-observation.ts'
import {
  allocateReleaseObservation,
  applyLocalEdgeModeIfLatest,
  claimCandidateJournalIfLatest,
  clearCandidateJournalIfOwned,
  clearLegacyCandidateCleanup,
  deleteReleaseMetadata,
  markCandidateJournalCleaningIfOwned,
  pruneClientReleasePins,
  readClientReleasePins,
  readKernelSnapshotMetadata,
  readLegacyCandidateCleanup,
  readLocalEdgeEnabled,
  readOrCreateMetadataEpoch,
  readReleaseState,
  updateClientReleasePin,
  writeCandidateJournalIfOwned,
  writeReleaseStateForCandidate,
  writeRetainedReleasesIfActive,
  type CandidateJournal,
  type ReleaseState,
} from './release-metadata.ts'
import {
  fetchVerifiedAsset,
  fetchVerifiedReleaseDescriptor,
} from './release-verifier.ts'
import { runBoundedTasks } from './bounded-tasks.ts'
import {
  beginRevalidationInstall,
  recordCompletedAsset,
  type RevalidationInstallState,
} from './progress.ts'
import {
  advanceKernelObservation,
  currentKernelObservationIdentity,
  readStableKernelObservation,
  runKernelLifecycleMutation,
} from './observation-runtime.ts'

const worker = self as unknown as ServiceWorkerGlobalScope
const releaseCachePrefix = `fwa-local-edge:${localEdgeConfig.appId}:release:`
const candidateInstallConcurrency = 8
interface ObservedRevalidationInstall {
  attemptId: number
  state: RevalidationInstallState
}

let revalidationInFlight: Promise<OrderedLocalEdgeRevalidationResult> | undefined
let revalidationAbortController: AbortController | undefined
let revalidationInstall: ObservedRevalidationInstall | undefined
let pendingProgressSends: Promise<unknown>[] = []
let resetInFlight: Promise<void> | undefined
let resetObservationReady: Promise<void> | undefined
let resetStarted = false
let metadataEpoch: string | undefined
let metadataRecoveryComplete = false
const candidateCacheLockName = `fwa-local-edge:${localEdgeConfig.appId}:candidate-cache`

function withCandidateCacheLock<Result>(operation: () => Promise<Result>) {
  if (!navigator.locks) {
    throw new Error('Local Edge candidate updates require the Web Locks API')
  }
  return navigator.locks.request(candidateCacheLockName, operation)
}

export async function activateReleaseRuntime() {
  await ensureMetadataAuthority(true)
  await cleanupOrphanedReleaseCaches()
}

export async function revalidateReleaseForClient(clientId: string) {
  if (resetStarted) {
    throw new Error('release runtime is resetting')
  }
  await ensureMetadataAuthority()
  const result = await runReleaseRevalidation()
  if (
    result.localEdgeEnabled &&
    result.release &&
    result.status !== 'updated'
  ) {
    await pinClientReleaseIfAbsent(clientId, result.release.releaseId)
  }
  return result
}

export async function getLocalEdgeSnapshot(): Promise<OrderedLocalEdgeSnapshot> {
  if (resetStarted) {
    return resetNetworkOnlySnapshot()
  }

  try {
    await ensureMetadataAuthority()
  } catch (error) {
    if (resetStarted) {
      return resetNetworkOnlySnapshot()
    }
    throw error
  }
  if (resetStarted) {
    return resetNetworkOnlySnapshot()
  }
  let stableObservation: Awaited<
    ReturnType<typeof readStableKernelObservation<
      Awaited<ReturnType<typeof readKernelSnapshotMetadata>>
    >>
  >
  try {
    stableObservation = await readStableKernelObservation(
      () => readKernelSnapshotMetadata(requiredMetadataEpoch()),
      () => revalidationInstall,
    )
  } catch (error) {
    if (resetStarted) {
      return resetNetworkOnlySnapshot()
    }
    throw error
  }
  const { durableState, memoryState, identity } = stableObservation
  if (resetStarted) {
    return resetNetworkOnlySnapshot()
  }
  const observedInstall = memoryState as
    | ObservedRevalidationInstall
    | undefined
  const releaseState = durableState.releaseState
  const installProgress = observedInstall?.state.progress
  const revalidation = observedInstall && installProgress
    ? ({
        ...identity,
        attemptId: observedInstall.attemptId,
        ...installProgress,
      } satisfies KernelRevalidationProgress)
    : undefined
  if (!durableState.localEdgeEnabled) {
    return {
      ...identity,
      localEdgeEnabled: false,
      mode: 'disabled',
      release: releaseState.active,
      retainedReleases: releaseState.retained,
      ...(revalidation ? { revalidation } : undefined),
    }
  }
  return releaseState.active
    ? {
        ...identity,
        localEdgeEnabled: true,
        mode: 'active',
        release: releaseState.active,
        retainedReleases: releaseState.retained,
        ...(revalidation ? { revalidation } : undefined),
      }
    : {
        ...identity,
        localEdgeEnabled: true,
        mode: 'network-only',
        ...(revalidation ? { revalidation } : undefined),
      }
}

export async function isLocalEdgeRuntimeEnabled() {
  await ensureMetadataAuthority()
  return readLocalEdgeEnabled(requiredMetadataEpoch())
}

export function resetReleaseRuntime() {
  if (!resetInFlight) {
    resetStarted = true
    revalidationAbortController?.abort()
    resetObservationReady = runKernelLifecycleMutation(async () => {
      revalidationInstall = undefined
      advanceKernelObservation()
    })
    resetInFlight = resetObservationReady.then(() => finishReset())
  }
  return resetInFlight
}

async function resetNetworkOnlySnapshot(): Promise<OrderedLocalEdgeSnapshot> {
  // Wait until reset's observation transition has advanced the revision. This
  // avoids publishing contradictory active/network-only snapshots at one
  // identity while still keeping metadata deletion outside the lifecycle gate.
  await resetObservationReady
  return {
    ...currentKernelObservationIdentity(),
    localEdgeEnabled: false,
    mode: 'network-only',
  }
}

export function hasResetStarted() {
  return resetStarted
}

export async function selectRequestRelease(event: FetchEvent) {
  await ensureMetadataAuthority()
  const { active, retained } = await readReleaseState(requiredMetadataEpoch())
  if (!active || isNavigation(event.request)) {
    return active
  }

  const requestPath = new URL(event.request.url).pathname
  const pinnedReleaseId = await readClientReleasePin(event.clientId)
  const pinnedRelease = [active, ...retained].find(
    (release) => release?.releaseId === pinnedReleaseId,
  )
  if (pinnedRelease && releaseAssetPaths(pinnedRelease).includes(requestPath)) {
    return pinnedRelease
  }

  if (releaseAssetPaths(active).includes(requestPath)) {
    return active
  }
  const retainedRelease = retained.find((release) =>
    releaseAssetPaths(release).includes(requestPath),
  )
  if (retainedRelease) {
    return retainedRelease
  }

  return active
}

export async function pinRequestClient(event: FetchEvent, releaseId: string) {
  await ensureMetadataAuthority()
  await pinClientRelease(
    event.resultingClientId || event.clientId,
    releaseId,
  )
}

export async function readReleaseAsset(
  release: AppRelease,
  assetPath: string,
) {
  const cacheName = releaseCacheName(release.releaseId)
  if (!(await caches.has(cacheName))) {
    return undefined
  }

  const releaseCache = await caches.open(cacheName)
  return releaseCache.match(assetPath)
}

export async function isReleaseComplete(release: AppRelease) {
  const cacheName = releaseCacheName(release.releaseId)
  if (!(await caches.has(cacheName))) {
    return false
  }

  const releaseCache = await caches.open(cacheName)
  const matches = await Promise.all(
    releaseAssetPaths(release).map((assetPath) =>
      releaseCache.match(assetPath),
    ),
  )
  return matches.every(Boolean)
}

function runReleaseRevalidation() {
  if (!revalidationInFlight) {
    revalidationAbortController = new AbortController()
    revalidationInFlight = revalidateRelease(
      revalidationAbortController.signal,
    ).finally(() => {
      revalidationInFlight = undefined
      revalidationAbortController = undefined
    })
  }

  return revalidationInFlight
}

async function revalidateRelease(
  signal: AbortSignal,
): Promise<OrderedLocalEdgeRevalidationResult> {
  let release!: VerifiedAppRelease
  let candidateCacheName = ''
  let commitBaseState!: ReleaseState
  let attemptId = 0
  let candidateOwner!: Omit<CandidateJournal, 'phase'>
  let candidateCache!: Cache
  let immediateResult: OrderedLocalEdgeRevalidationResult | undefined

  try {
    const releaseObservation = await withCandidateCacheLock(() =>
      allocateReleaseObservation(requiredMetadataEpoch()),
    )
    const descriptor = await fetchVerifiedReleaseDescriptor(signal)

    await withCandidateCacheLock(async () => {
      const wasLocalEdgeEnabled = await readLocalEdgeEnabled(
        requiredMetadataEpoch(),
      )
      if (!descriptor.localEdgeEnabled) {
        await runKernelLifecycleMutation(async () => {
          const transition = await applyLocalEdgeModeIfLatest(
            releaseObservation,
            false,
          )
          const releaseState = await readReleaseState(requiredMetadataEpoch())
          if (!transition.applied) {
            immediateResult = orderedResult({
              status: wasLocalEdgeEnabled ? 'current' : 'disabled-current',
              localEdgeEnabled: wasLocalEdgeEnabled,
              release: releaseState.active,
            })
            return
          }
          await cleanupSupersededCandidateCache(
            transition.previousCandidate,
            releaseState,
          )
          advanceKernelObservation()
          immediateResult = orderedResult({
            status: wasLocalEdgeEnabled ? 'disabled' : 'disabled-current',
            localEdgeEnabled: false,
            release: releaseState.active,
          })
        })
        return
      }

      if (!descriptor.release) {
        throw new Error('enabled release descriptor is missing its release')
      }
      release = descriptor.release
      candidateCacheName = releaseCacheName(release.releaseId)
      const releaseState = await readReleaseState(requiredMetadataEpoch())
      const activeRelease = releaseState.active
      if (
        activeRelease?.releaseId === release.releaseId &&
        (await isReleaseComplete(activeRelease))
      ) {
        await runKernelLifecycleMutation(async () => {
          const transition = await applyLocalEdgeModeIfLatest(
            releaseObservation,
            true,
          )
          if (!transition.applied) {
            const currentEnabled = await readLocalEdgeEnabled(
              requiredMetadataEpoch(),
            )
            immediateResult = orderedResult({
              status: currentEnabled ? 'current' : 'disabled-current',
              localEdgeEnabled: currentEnabled,
              release: (
                await readReleaseState(requiredMetadataEpoch())
              ).active,
            })
            return
          }
          const currentReleaseState =
            await cleanupUnusedRetainedReleasesLocked(releaseState)
          await cleanupSupersededCandidateCache(
            transition.previousCandidate,
            currentReleaseState,
          )
          advanceKernelObservation()
          immediateResult = orderedResult({
            status: wasLocalEdgeEnabled ? 'current' : 'enabled',
            localEdgeEnabled: true,
            release: activeRelease,
          })
        })
        return
      }

      await runKernelLifecycleMutation(async () => {
        const identity = advanceKernelObservation()
        attemptId = identity.observationRevision
        candidateOwner = {
          metadataEpoch: requiredMetadataEpoch(),
          kernelInstanceId: identity.kernelInstanceId,
          attemptId,
          releaseId: release.releaseId,
          releaseObservationSeq: releaseObservation.observationSeq,
        }
        const claim = await claimCandidateJournalIfLatest(
          { ...candidateOwner, phase: 'cleaning' },
          releaseObservation,
        )
        if (!claim.claimed) {
          attemptId = 0
          const currentEnabled = await readLocalEdgeEnabled(
            requiredMetadataEpoch(),
          )
          immediateResult = orderedResult({
            status: currentEnabled ? 'current' : 'disabled-current',
            localEdgeEnabled: currentEnabled,
            release: (await readReleaseState(requiredMetadataEpoch())).active,
          })
          return
        }
        commitBaseState = await cleanupUnusedRetainedReleasesLocked()
        revalidationInstall = {
          attemptId,
          state: beginRevalidationInstall(
            release.releaseId,
            release.assets.length,
          ),
        }

        await cleanupSupersededCandidateCache(
          claim.previous?.releaseId === release.releaseId
            ? undefined
            : claim.previous,
          commitBaseState,
        )
        if (!(await writeCandidateJournalIfOwned(candidateOwner, 'installing'))) {
          throw new Error('Local Edge candidate ownership was superseded')
        }
        candidateCache = await caches.open(candidateCacheName)
      })
    })

    if (immediateResult) {
      return immediateResult
    }

    await runBoundedTasks(
      release.assets,
      candidateInstallConcurrency,
      async (asset) => {
        await candidateCache.put(
          asset.path,
          await fetchVerifiedAsset(asset, signal),
        )
        recordCandidateInstallProgress()
      },
    )

    let terminalIdentity = currentKernelObservationIdentity()
    await withCandidateCacheLock(async () => {
      commitBaseState = await readReleaseState(requiredMetadataEpoch())
      // Reopen by name for final verification: a Cache object detached by a
      // concurrent delete must never authorize an unreachable committed release.
      const finalCandidateCache = await caches.open(candidateCacheName)
      for (const asset of release.assets) {
        if (!(await finalCandidateCache.match(asset.path))) {
          throw new Error(`${asset.path} missing after candidate install`)
        }
      }

      await runKernelLifecycleMutation(async () => {
        await writeReleaseStateForCandidate(candidateOwner, {
          active: release,
          retained:
            commitBaseState.active?.releaseId === release.releaseId
              ? commitBaseState.retained
              : dedupeReleases([
                  ...(commitBaseState.active ? [commitBaseState.active] : []),
                  ...commitBaseState.retained,
                ]).filter(
                  (retainedRelease) =>
                    retainedRelease.releaseId !== release.releaseId,
                ),
        })
        revalidationInstall = undefined
        terminalIdentity = advanceKernelObservation()
      })
    })
    await drainProgressSends()
    try {
      await broadcastRevalidationCommitted(
        terminalIdentity,
        attemptId,
        release.releaseId,
      )
    } catch {
      // Best-effort notification only: the release is already committed, so a
      // failed broadcast must never roll the install back.
    }
    return {
      ...terminalIdentity,
      attemptId,
      status: !commitBaseState.active
        ? 'installed'
        : commitBaseState.active.releaseId === release.releaseId
          ? 'repaired'
          : 'updated',
      localEdgeEnabled: true,
      release,
    }
  } catch (error) {
    if (attemptId === 0) {
      throw error
    }
    let terminalIdentity = currentKernelObservationIdentity()
    await runKernelLifecycleMutation(async () => {
      revalidationInstall = undefined
      terminalIdentity = advanceKernelObservation()
    })
    await drainProgressSends()
    try {
      await broadcastRevalidationFailed(
        terminalIdentity,
        attemptId,
        release.releaseId,
      )
    } catch {
      // Failure notification is best-effort; owned candidate cleanup must
      // still run when a client disappears or rejects postMessage.
    }
    try {
      await withCandidateCacheLock(async () => {
        if (await markCandidateJournalCleaningIfOwned(candidateOwner)) {
          const latestReleaseState = await readReleaseState(
            requiredMetadataEpoch(),
          )
          const candidateIsReferenced =
            latestReleaseState.active?.releaseId === candidateOwner.releaseId ||
            latestReleaseState.retained.some(
              (retainedRelease) =>
                retainedRelease.releaseId === candidateOwner.releaseId,
            )
          if (!candidateIsReferenced) {
            await caches.delete(candidateCacheName)
          }
          await clearCandidateJournalIfOwned(candidateOwner)
        }
      })
    } catch {
      // Reset or metadata replacement can revoke authority before cleanup. The
      // lock plus final authority check prevents a stale attempt from creating
      // a new reachable cache; reset owns namespace cleanup.
    }
    throw error
  }
}

function orderedResult(
  result: LocalEdgeRevalidationResult,
): OrderedLocalEdgeRevalidationResult {
  return { ...currentKernelObservationIdentity(), ...result }
}

async function ensureMetadataAuthority(allowCreate = false) {
  const observedEpoch = await readOrCreateMetadataEpoch(allowCreate)
  if (metadataEpoch === undefined) {
    metadataEpoch = observedEpoch
  } else if (metadataEpoch !== observedEpoch) {
    throw new Error('release runtime lost metadata authority')
  }
  if (!metadataRecoveryComplete && navigator.locks) {
    await cleanupLegacyCandidateAfterMigration()
    metadataRecoveryComplete = true
  }
  return metadataEpoch
}

async function cleanupLegacyCandidateAfterMigration() {
  const metadataEpoch = requiredMetadataEpoch()
  if (!(await readLegacyCandidateCleanup(metadataEpoch))) {
    return
  }

  await withCandidateCacheLock(async () => {
    const releaseId = await readLegacyCandidateCleanup(metadataEpoch)
    if (!releaseId) {
      return
    }
    const releaseState = await readReleaseState(metadataEpoch)
    const isReferenced =
      releaseState.active?.releaseId === releaseId ||
      releaseState.retained.some((release) => release.releaseId === releaseId)
    if (!isReferenced) {
      await caches.delete(releaseCacheName(releaseId))
    }
    await clearLegacyCandidateCleanup(metadataEpoch, releaseId)
  })
}

function requiredMetadataEpoch() {
  if (!metadataEpoch) {
    throw new Error('release runtime metadata authority is unavailable')
  }
  return metadataEpoch
}

async function finishReset() {
  try {
    await revalidationInFlight
  } catch {
    // Reset owns the final cleanup after an interrupted revalidation.
  }
  revalidationInstall = undefined

  let metadataDeletion!: Promise<void>
  await withCandidateCacheLock(async () => {
    const cacheNames = await caches.keys()
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith(releaseCachePrefix))
        .map((cacheName) => caches.delete(cacheName)),
    )
    // Calling this queues the versionchange request synchronously. Release the
    // cache lock before waiting for other globals to close their IDB handles.
    metadataDeletion = deleteReleaseMetadata()
  })
  await metadataDeletion
}

async function pinClientRelease(clientId: string, releaseId: string) {
  if (!clientId) {
    return
  }

  await withCandidateCacheLock(() =>
    updateClientReleasePin(
      requiredMetadataEpoch(),
      clientId,
      releaseId,
    ),
  )
}

async function pinClientReleaseIfAbsent(
  clientId: string,
  releaseId: string,
) {
  if (!clientId) {
    return
  }

  await withCandidateCacheLock(() =>
    updateClientReleasePin(
      requiredMetadataEpoch(),
      clientId,
      releaseId,
      { onlyIfAbsent: true },
    ),
  )
}

async function readClientReleasePin(clientId: string) {
  if (!clientId) {
    return undefined
  }
  return (await readClientReleasePins(requiredMetadataEpoch())).get(clientId)
}

async function cleanupSupersededCandidateCache(
  candidate: CandidateJournal | undefined,
  releaseState: ReleaseState,
) {
  if (!candidate) {
    return
  }
  const isReferenced =
    releaseState.active?.releaseId === candidate.releaseId ||
    releaseState.retained.some(
      (release) => release.releaseId === candidate.releaseId,
    )
  if (!isReferenced) {
    await caches.delete(releaseCacheName(candidate.releaseId))
  }
}

async function cleanupUnusedRetainedReleasesLocked(
  releaseState?: ReleaseState,
): Promise<ReleaseState> {
  const currentState =
    releaseState ?? (await readReleaseState(requiredMetadataEpoch()))
  const liveClients = await worker.clients.matchAll({
    type: 'window',
    includeUncontrolled: false,
  })
  const liveClientIds = new Set(liveClients.map((client) => client.id))
  const pins = await pruneClientReleasePins(
    requiredMetadataEpoch(),
    liveClientIds,
  )

  if (currentState.retained.length === 0) {
    return currentState
  }

  const hasUnpinnedClient = liveClients.some((client) => !pins.has(client.id))
  if (hasUnpinnedClient) {
    return currentState
  }

  const pinnedReleaseIds = new Set(pins.values())
  const retained = currentState.retained.filter((release) =>
    pinnedReleaseIds.has(release.releaseId),
  )
  if (retained.length === currentState.retained.length) {
    return currentState
  }

  const retainedReleaseIds = new Set(
    retained.map((release) => release.releaseId),
  )
  const removedReleases = currentState.retained.filter(
    (release) => !retainedReleaseIds.has(release.releaseId),
  )
  const nextState = { active: currentState.active, retained }
  const applied = await writeRetainedReleasesIfActive(
    requiredMetadataEpoch(),
    currentState.active?.releaseId,
    retained,
  )
  if (!applied) {
    return readReleaseState(requiredMetadataEpoch())
  }
  await Promise.all(
    removedReleases.map((release) =>
      caches.delete(releaseCacheName(release.releaseId)),
    ),
  )
  return nextState
}

async function cleanupOrphanedReleaseCaches() {
  await withCandidateCacheLock(async () => {
    const releaseState = await readReleaseState(requiredMetadataEpoch())
    const retainedCacheNames = new Set(
      [releaseState.active, ...releaseState.retained]
        .filter((release): release is AppRelease => Boolean(release))
        .map((release) => releaseCacheName(release.releaseId)),
    )
    const cacheNames = await caches.keys()
    await Promise.all(
      cacheNames
        .filter(
          (cacheName) =>
            cacheName.startsWith(releaseCachePrefix) &&
            !retainedCacheNames.has(cacheName),
        )
        .map((cacheName) => caches.delete(cacheName)),
    )
  })
}

function releaseCacheName(releaseId: string) {
  return `${releaseCachePrefix}${releaseId}`
}

function isNavigation(request: Request) {
  return request.method === 'GET' && request.mode === 'navigate'
}

function dedupeReleases(releases: readonly AppRelease[]) {
  const releaseIds = new Set<string>()
  return releases.filter((release) => {
    if (releaseIds.has(release.releaseId)) {
      return false
    }
    releaseIds.add(release.releaseId)
    return true
  })
}

function recordCandidateInstallProgress() {
  const install = revalidationInstall
  if (!install) {
    return
  }
  const { state: updated, shouldBroadcast } = recordCompletedAsset(
    install.state,
    Date.now(),
  )
  revalidationInstall = { ...install, state: updated }
  const identity = advanceKernelObservation()
  const progress = updated.progress
  if (!shouldBroadcast || !progress) {
    return
  }
  pendingProgressSends.push(
    broadcastToWindowClients({
      type: fwaRevalidationProgressMessageType,
      ...identity,
      attemptId: install.attemptId,
      releaseId: progress.releaseId,
      completedAssets: progress.completedAssets,
      totalAssets: progress.totalAssets,
    }),
  )
}

function drainProgressSends() {
  const sends = pendingProgressSends
  pendingProgressSends = []
  return Promise.allSettled(sends)
}

function broadcastRevalidationFailed(
  identity: ReturnType<typeof currentKernelObservationIdentity>,
  attemptId: number,
  releaseId: string,
) {
  return broadcastToWindowClients({
    type: fwaRevalidationFailedMessageType,
    ...identity,
    attemptId,
    releaseId,
  }).catch(() => undefined)
}

function broadcastRevalidationCommitted(
  identity: ReturnType<typeof currentKernelObservationIdentity>,
  attemptId: number,
  releaseId: string,
) {
  return broadcastToWindowClients({
    type: fwaRevalidationCommittedMessageType,
    ...identity,
    attemptId,
    releaseId,
  })
}

function broadcastToWindowClients(payload: unknown) {
  return worker.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) {
      client.postMessage(payload)
    }
  })
}
