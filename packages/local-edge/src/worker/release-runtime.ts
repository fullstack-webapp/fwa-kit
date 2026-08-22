import { localEdgeConfig } from '../config.ts'
import {
  releaseAssetPaths,
  type AppRelease,
  type LocalEdgeRevalidationResult,
  type LocalEdgeSnapshot,
} from '../release.ts'
import {
  clearCandidateJournal,
  deleteReleaseMetadata,
  readCandidateJournal,
  readClientReleasePins,
  readLocalEdgeEnabled,
  readReleaseState,
  writeCandidateJournal,
  writeClientReleasePins,
  writeLocalEdgeEnabled,
  writeReleaseState,
  type ReleaseState,
} from './release-metadata.ts'
import {
  fetchVerifiedAsset,
  fetchVerifiedReleaseDescriptor,
} from './release-verifier.ts'
import { runBoundedTasks } from './bounded-tasks.ts'

const worker = self as unknown as ServiceWorkerGlobalScope
const releaseCachePrefix = `fwa-local-edge:${localEdgeConfig.appId}:release:`
const candidateInstallConcurrency = 8
let revalidationInFlight: Promise<LocalEdgeRevalidationResult> | undefined
let revalidationAbortController: AbortController | undefined
let resetInFlight: Promise<void> | undefined
let resetStarted = false
let clientReleasePins: Map<string, string> | undefined
let clientReleasePinsLoad: Promise<Map<string, string>> | undefined
let localEdgeEnabled: boolean | undefined
let localEdgeEnabledLoad: Promise<boolean> | undefined

export function activateReleaseRuntime() {
  return cleanupOrphanedReleaseCaches()
}

export async function revalidateReleaseForClient(clientId: string) {
  if (resetStarted) {
    throw new Error('release runtime is resetting')
  }
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

export async function getLocalEdgeSnapshot(): Promise<LocalEdgeSnapshot> {
  const enabled = await isLocalEdgeRuntimeEnabled()
  const releaseState = await readReleaseState()
  if (!enabled) {
    return {
      localEdgeEnabled: false,
      mode: 'disabled',
      release: releaseState.active,
      retainedReleases: releaseState.retained,
    }
  }
  return releaseState.active
    ? {
        localEdgeEnabled: true,
        mode: 'active',
        release: releaseState.active,
        retainedReleases: releaseState.retained,
      }
    : { localEdgeEnabled: true, mode: 'network-only' }
}

export async function isLocalEdgeRuntimeEnabled() {
  if (localEdgeEnabled !== undefined) {
    return localEdgeEnabled
  }
  if (!localEdgeEnabledLoad) {
    localEdgeEnabledLoad = readLocalEdgeEnabled().finally(() => {
      localEdgeEnabledLoad = undefined
    })
  }
  localEdgeEnabled = await localEdgeEnabledLoad
  return localEdgeEnabled
}

export function resetReleaseRuntime() {
  if (!resetInFlight) {
    resetStarted = true
    revalidationAbortController?.abort()
    resetInFlight = finishReset()
  }
  return resetInFlight
}

export async function selectRequestRelease(event: FetchEvent) {
  const { active, retained } = await readReleaseState()
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

async function revalidateRelease(signal: AbortSignal) {
  await recoverAbandonedCandidate()
  const descriptor = await fetchVerifiedReleaseDescriptor(signal)
  const wasLocalEdgeEnabled = await isLocalEdgeRuntimeEnabled()
  if (!descriptor.localEdgeEnabled) {
    await setLocalEdgeEnabled(false)
    return {
      status: wasLocalEdgeEnabled ? 'disabled' : 'disabled-current',
      localEdgeEnabled: false,
      release: (await readReleaseState()).active,
    } satisfies LocalEdgeRevalidationResult
  }
  const release = descriptor.release
  if (!release) {
    throw new Error('enabled release descriptor is missing its release')
  }
  const releaseState = await cleanupUnusedRetainedReleases()
  const activeRelease = releaseState.active
  if (
    activeRelease?.releaseId === release.releaseId &&
    (await isReleaseComplete(activeRelease))
  ) {
    await setLocalEdgeEnabled(true)
    return {
      status: wasLocalEdgeEnabled ? 'current' : 'enabled',
      localEdgeEnabled: true,
      release: activeRelease,
    } satisfies LocalEdgeRevalidationResult
  }

  const candidateCacheName = releaseCacheName(release.releaseId)
  const isRepairingActive = activeRelease?.releaseId === release.releaseId
  const isKnownRetained = releaseState.retained.some(
    (retainedRelease) => retainedRelease.releaseId === release.releaseId,
  )
  if (!isRepairingActive && !isKnownRetained) {
    await caches.delete(candidateCacheName)
  }
  await writeCandidateJournal({
    releaseId: release.releaseId,
    phase: 'installing',
  })
  const candidateCache = await caches.open(candidateCacheName)

  try {
    await runBoundedTasks(
      release.assets,
      candidateInstallConcurrency,
      async (asset) => {
        await candidateCache.put(
          asset.path,
          await fetchVerifiedAsset(asset, signal),
        )
      },
    )

    for (const asset of release.assets) {
      if (!(await candidateCache.match(asset.path))) {
        throw new Error(`${asset.path} missing after candidate install`)
      }
    }

    await writeCandidateJournal({
      releaseId: release.releaseId,
      phase: 'verified',
    })
    await writeReleaseState(
      {
        active: release,
        retained:
          activeRelease?.releaseId === release.releaseId
            ? releaseState.retained
            : dedupeReleases([
                ...(activeRelease ? [activeRelease] : []),
                ...releaseState.retained,
              ]).filter(
                (retainedRelease) =>
                  retainedRelease.releaseId !== release.releaseId,
              ),
      },
      { clearCandidate: true, localEdgeEnabled: true },
    )
    localEdgeEnabled = true
    return {
      status: !activeRelease
        ? 'installed'
        : isRepairingActive
          ? 'repaired'
          : 'updated',
      localEdgeEnabled: true,
      release,
    } satisfies LocalEdgeRevalidationResult
  } catch (error) {
    if (!isRepairingActive && !isKnownRetained) {
      await caches.delete(candidateCacheName)
    }
    await clearCandidateJournal()
    throw error
  }
}

async function finishReset() {
  try {
    await revalidationInFlight
  } catch {
    // Reset owns the final cleanup after an interrupted revalidation.
  }

  const cacheNames = await caches.keys()
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(releaseCachePrefix))
      .map((cacheName) => caches.delete(cacheName)),
  )
  await deleteReleaseMetadata()
  clientReleasePins = undefined
  clientReleasePinsLoad = undefined
  localEdgeEnabled = undefined
  localEdgeEnabledLoad = undefined
}

async function setLocalEdgeEnabled(enabled: boolean) {
  if (localEdgeEnabled === enabled) {
    return
  }
  await writeLocalEdgeEnabled(enabled)
  localEdgeEnabled = enabled
}

async function pinClientRelease(clientId: string, releaseId: string) {
  if (!clientId) {
    return
  }

  const pins = await getClientReleasePins()
  if (pins.get(clientId) === releaseId) {
    return
  }

  pins.set(clientId, releaseId)
  await writeClientReleasePins(pins)
}

async function pinClientReleaseIfAbsent(
  clientId: string,
  releaseId: string,
) {
  if (!clientId) {
    return
  }

  const pins = await getClientReleasePins()
  if (pins.has(clientId)) {
    return
  }

  pins.set(clientId, releaseId)
  await writeClientReleasePins(pins)
}

async function readClientReleasePin(clientId: string) {
  if (!clientId) {
    return undefined
  }
  return (await getClientReleasePins()).get(clientId)
}

async function cleanupUnusedRetainedReleases(
  releaseState?: ReleaseState,
): Promise<ReleaseState> {
  const currentState = releaseState ?? (await readReleaseState())
  const liveClients = await worker.clients.matchAll({
    type: 'window',
    includeUncontrolled: false,
  })
  const liveClientIds = new Set(liveClients.map((client) => client.id))
  const pins = await getClientReleasePins()
  let pinsChanged = false

  for (const clientId of pins.keys()) {
    if (!liveClientIds.has(clientId)) {
      pins.delete(clientId)
      pinsChanged = true
    }
  }

  if (pinsChanged) {
    await writeClientReleasePins(pins)
  }

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
  await writeReleaseState(nextState)
  await Promise.all(
    removedReleases.map((release) =>
      caches.delete(releaseCacheName(release.releaseId)),
    ),
  )
  return nextState
}

async function cleanupOrphanedReleaseCaches() {
  const releaseState = await readReleaseState()
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
}

async function getClientReleasePins() {
  if (clientReleasePins) {
    return clientReleasePins
  }
  if (!clientReleasePinsLoad) {
    clientReleasePinsLoad = readClientReleasePins().finally(() => {
      clientReleasePinsLoad = undefined
    })
  }

  clientReleasePins = await clientReleasePinsLoad
  return clientReleasePins
}

function releaseCacheName(releaseId: string) {
  return `${releaseCachePrefix}${releaseId}`
}

function isNavigation(request: Request) {
  return request.method === 'GET' && request.mode === 'navigate'
}

async function recoverAbandonedCandidate() {
  const journal = await readCandidateJournal()
  if (!journal) {
    return
  }

  const releaseState = await readReleaseState()
  if (
    releaseState.active?.releaseId !== journal.releaseId &&
    !releaseState.retained.some(
      (release) => release.releaseId === journal.releaseId,
    )
  ) {
    await caches.delete(releaseCacheName(journal.releaseId))
  }
  await clearCandidateJournal()
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
