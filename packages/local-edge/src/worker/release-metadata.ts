import { localEdgeConfig } from '../config.ts'
import type { AppRelease } from '../release.ts'

const databaseName = `fwa-local-edge:${localEdgeConfig.appId}`
const storeName = 'metadata'
const activeReleaseKey = 'activeRelease'
const previousReleaseKey = 'previousRelease'
const retainedReleasesKey = 'retainedReleases'
const clientReleasePinsKey = 'clientReleasePins'
const candidateJournalKey = 'candidateJournal'
const metadataEpochKey = 'metadataEpoch'
const localEdgeEnabledKey = 'localEdgeEnabled'

export interface ReleaseState {
  active?: AppRelease
  retained: readonly AppRelease[]
}

export interface KernelSnapshotMetadata {
  localEdgeEnabled: boolean
  releaseState: ReleaseState
}

export interface CandidateJournal {
  metadataEpoch: string
  kernelInstanceId: string
  attemptId: number
  releaseId: string
  phase: 'installing' | 'verified' | 'cleaning'
}

export async function readOrCreateMetadataEpoch(allowCreate: boolean) {
  const database = await openDatabase({ allowCreate })

  try {
    return await new Promise<string>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.get(metadataEpochKey)
      request.onsuccess = () => {
        if (typeof request.result === 'string' && request.result.length > 0) {
          resolve(request.result)
          return
        }
        if (!allowCreate) {
          transaction.abort()
          reject(new Error('Local Edge metadata epoch is unavailable'))
          return
        }
        const metadataEpoch = crypto.randomUUID()
        store.put(metadataEpoch, metadataEpochKey)
        transaction.oncomplete = () => resolve(metadataEpoch)
      }
      request.onerror = () => reject(request.error)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error ?? new Error('metadata epoch transaction aborted'))
    })
  } finally {
    database.close()
  }
}

export async function readCandidateJournal(metadataEpoch: string) {
  const database = await openDatabase()

  try {
    return await new Promise<CandidateJournal | undefined>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const request = store.get(candidateJournalKey)
      transaction.oncomplete = () => {
        if (epochRequest.result !== metadataEpoch) {
          reject(new Error('release runtime lost metadata authority'))
          return
        }
        resolve(request.result as CandidateJournal | undefined)
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function claimCandidateJournal(journal: CandidateJournal) {
  const database = await openDatabase()

  try {
    return await new Promise<CandidateJournal | undefined>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const request = store.get(candidateJournalKey)
      let previous: CandidateJournal | undefined
      let claimed = false
      const claim = () => {
        if (
          claimed ||
          epochRequest.readyState !== 'done' ||
          request.readyState !== 'done'
        ) {
          return
        }
        if (epochRequest.result !== journal.metadataEpoch) {
          transaction.abort()
          return
        }
        claimed = true
        previous = isRecord(request.result)
          ? (request.result as unknown as CandidateJournal)
          : undefined
        store.put(journal, candidateJournalKey)
      }
      epochRequest.onsuccess = claim
      request.onsuccess = claim
      transaction.oncomplete = () => resolve(previous)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function writeCandidateJournalIfOwned(
  owner: Omit<CandidateJournal, 'phase'>,
  phase: CandidateJournal['phase'],
) {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.get(candidateJournalKey)
      let written = false
      request.onsuccess = () => {
        if (candidateOwnerMatches(request.result, owner)) {
          written = true
          store.put({ ...owner, phase }, candidateJournalKey)
        }
      }
      transaction.oncomplete = () => resolve(written)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function markCandidateJournalCleaningIfOwned(
  owner: Omit<CandidateJournal, 'phase'>,
) {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.get(candidateJournalKey)
      let marked = false
      request.onsuccess = () => {
        if (candidateOwnerMatches(request.result, owner)) {
          marked = true
          store.put({ ...owner, phase: 'cleaning' }, candidateJournalKey)
        }
      }
      transaction.oncomplete = () => resolve(marked)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function clearCandidateJournalIfOwned(
  owner: Omit<CandidateJournal, 'phase'>,
) {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.get(candidateJournalKey)
      let cleared = false
      request.onsuccess = () => {
        if (candidateOwnerMatches(request.result, owner)) {
          cleared = true
          store.delete(candidateJournalKey)
        }
      }
      transaction.oncomplete = () => resolve(cleared)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function readKernelSnapshotMetadata(
  metadataEpoch: string,
): Promise<KernelSnapshotMetadata> {
  const database = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const activeRequest = store.get(activeReleaseKey)
      const previousRequest = store.get(previousReleaseKey)
      const retainedRequest = store.get(retainedReleasesKey)
      const enabledRequest = store.get(localEdgeEnabledKey)
      const epochRequest = store.get(metadataEpochKey)
      transaction.oncomplete = () => {
        if (epochRequest.result !== metadataEpoch) {
          reject(new Error('release runtime lost metadata authority'))
          return
        }
        resolve({
          localEdgeEnabled: enabledRequest.result !== false,
          releaseState: normalizeStoredReleaseState(
            activeRequest.result,
            retainedRequest.result,
            previousRequest.result,
          ),
        })
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function writeReleaseStateForCandidate(
  owner: Omit<CandidateJournal, 'phase'>,
  releaseState: ReleaseState,
): Promise<void> {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const candidateRequest = store.get(candidateJournalKey)
      let ownerVerified = false
      const verifyOwner = () => {
        if (
          ownerVerified ||
          epochRequest.readyState !== 'done' ||
          candidateRequest.readyState !== 'done'
        ) {
          return
        }
        if (
          epochRequest.result !== owner.metadataEpoch ||
          !candidateOwnerMatches(candidateRequest.result, owner)
        ) {
          transaction.abort()
          return
        }
        ownerVerified = true
        writeOptionalValue(store, activeReleaseKey, releaseState.active)
        writeOptionalValue(
          store,
          retainedReleasesKey,
          releaseState.retained.length > 0
            ? [...releaseState.retained]
            : undefined,
        )
        store.delete(previousReleaseKey)
        store.delete(candidateJournalKey)
        store.put(true, localEdgeEnabledKey)
      }
      epochRequest.onsuccess = verifyOwner
      candidateRequest.onsuccess = verifyOwner
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(new Error('candidate install lost metadata authority'))
    })
  } finally {
    database.close()
  }
}

export async function readReleaseState(metadataEpoch: string): Promise<ReleaseState> {
  const database = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const activeRequest = store.get(activeReleaseKey)
      const previousRequest = store.get(previousReleaseKey)
      const retainedRequest = store.get(retainedReleasesKey)
      const epochRequest = store.get(metadataEpochKey)
      transaction.oncomplete = () => {
        if (epochRequest.result !== metadataEpoch) {
          reject(new Error('release runtime lost metadata authority'))
          return
        }
        resolve(
          normalizeStoredReleaseState(
            activeRequest.result,
            retainedRequest.result,
            previousRequest.result,
          ),
        )
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function readLocalEdgeEnabled(metadataEpoch: string) {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const request = store.get(localEdgeEnabledKey)
      transaction.oncomplete = () => {
        if (epochRequest.result !== metadataEpoch) {
          reject(new Error('release runtime lost metadata authority'))
          return
        }
        resolve(request.result !== false)
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function writeRetainedReleasesIfActive(
  metadataEpoch: string,
  expectedActiveReleaseId: string | undefined,
  retained: readonly AppRelease[],
) {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const activeRequest = store.get(activeReleaseKey)
      let applied = false
      const apply = () => {
        if (
          applied ||
          epochRequest.readyState !== 'done' ||
          activeRequest.readyState !== 'done'
        ) {
          return
        }
        const active = isAppRelease(activeRequest.result)
          ? activeRequest.result
          : undefined
        if (
          epochRequest.result !== metadataEpoch ||
          active?.releaseId !== expectedActiveReleaseId
        ) {
          return
        }
        applied = true
        writeOptionalValue(
          store,
          retainedReleasesKey,
          retained.length > 0 ? [...retained] : undefined,
        )
        store.delete(previousReleaseKey)
      }
      epochRequest.onsuccess = apply
      activeRequest.onsuccess = apply
      transaction.oncomplete = () => resolve(applied)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export function normalizeStoredReleaseState(
  activeValue: unknown,
  retainedValue: unknown,
  legacyPreviousValue: unknown,
): ReleaseState {
  const active = isAppRelease(activeValue) ? activeValue : undefined
  const retainedCandidates = [
    ...(Array.isArray(retainedValue)
      ? retainedValue.filter(isAppRelease)
      : []),
    ...(isAppRelease(legacyPreviousValue) ? [legacyPreviousValue] : []),
  ]
  const releaseIds = new Set(active ? [active.releaseId] : [])
  const retained = retainedCandidates.filter((release) => {
    if (releaseIds.has(release.releaseId)) {
      return false
    }
    releaseIds.add(release.releaseId)
    return true
  })

  return { active, retained }
}

export async function writeLocalEdgeEnabled(
  metadataEpoch: string,
  localEdgeEnabled: boolean,
) {
  const database = await openDatabase()

  try {
    await writeIfMetadataEpochMatches(database, metadataEpoch, (store) => {
      store.put(localEdgeEnabled, localEdgeEnabledKey)
    })
  } finally {
    database.close()
  }
}

export async function readClientReleasePins(metadataEpoch: string) {
  const database = await openDatabase()

  try {
    return await new Promise<Map<string, string>>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      const request = store.get(clientReleasePinsKey)
      transaction.oncomplete = () => {
        if (epochRequest.result !== metadataEpoch) {
          reject(new Error('release runtime lost metadata authority'))
          return
        }
        const value = request.result
        resolve(
          isRecord(value)
            ? new Map(
                Object.entries(value).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === 'string',
                ),
              )
            : new Map(),
        )
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function updateClientReleasePin(
  metadataEpoch: string,
  clientId: string,
  releaseId: string,
  options: { onlyIfAbsent?: boolean } = {},
) {
  return mutateClientReleasePins(metadataEpoch, (pins) => {
    if (!options.onlyIfAbsent || !pins.has(clientId)) {
      pins.set(clientId, releaseId)
    }
  })
}

export async function pruneClientReleasePins(
  metadataEpoch: string,
  liveClientIds: Set<string>,
) {
  return mutateClientReleasePins(metadataEpoch, (pins) => {
    for (const clientId of pins.keys()) {
      if (!liveClientIds.has(clientId)) {
        pins.delete(clientId)
      }
    }
  })
}

async function mutateClientReleasePins(
  metadataEpoch: string,
  mutate: (pins: Map<string, string>) => void,
) {
  const database = await openDatabase()

  try {
    return await new Promise<Map<string, string>>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const epochRequest = store.get(metadataEpochKey)
      let pins = new Map<string, string>()

      epochRequest.onsuccess = () => {
        if (epochRequest.result !== metadataEpoch) {
          transaction.abort()
          return
        }
        const pinsRequest = store.get(clientReleasePinsKey)
        pinsRequest.onsuccess = () => {
          pins = normalizeClientReleasePins(pinsRequest.result)
          mutate(pins)
          store.put(Object.fromEntries(pins), clientReleasePinsKey)
        }
      }
      transaction.oncomplete = () => resolve(pins)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error('release runtime lost metadata authority'),
        )
    })
  } finally {
    database.close()
  }
}

function normalizeClientReleasePins(value: unknown) {
  return isRecord(value)
    ? new Map(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : new Map<string, string>()
}

export function deleteReleaseMetadata(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function openDatabase(
  options: { allowCreate?: boolean } = { allowCreate: false },
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = (event) => {
      if (
        options.allowCreate === false &&
        (event as IDBVersionChangeEvent).oldVersion === 0
      ) {
        request.transaction?.abort()
        return
      }
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('metadata database unavailable'))
  })
}

function writeIfMetadataEpochMatches(
  database: IDBDatabase,
  metadataEpoch: string,
  write: (store: IDBObjectStore) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(metadataEpochKey)
    request.onsuccess = () => {
      if (request.result !== metadataEpoch) {
        transaction.abort()
        return
      }
      write(store)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () =>
      reject(new Error('release runtime lost metadata authority'))
  })
}

function candidateOwnerMatches(
  value: unknown,
  owner: Omit<CandidateJournal, 'phase'>,
) {
  return (
    isRecord(value) &&
    value.metadataEpoch === owner.metadataEpoch &&
    value.kernelInstanceId === owner.kernelInstanceId &&
    value.attemptId === owner.attemptId &&
    value.releaseId === owner.releaseId
  )
}

function writeOptionalValue(
  store: IDBObjectStore,
  key: string,
  value: unknown,
) {
  if (value === undefined) {
    store.delete(key)
  } else {
    store.put(value, key)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAppRelease(value: unknown): value is AppRelease {
  if (!isRecord(value)) {
    return false
  }
  const commonFieldsAreValid =
    typeof value.appId === 'string' &&
    typeof value.releaseId === 'string' &&
    typeof value.appEntry === 'string'
  if (!commonFieldsAreValid) {
    return false
  }
  if (value.schemaVersion === 1) {
    return (
      Array.isArray(value.coreAssets) &&
      value.coreAssets.every((assetPath) => typeof assetPath === 'string')
    )
  }
  if (value.schemaVersion === 2) {
    return Array.isArray(value.assets) && value.assets.every(isAppReleaseAsset)
  }
  return false
}

function isAppReleaseAsset(value: unknown) {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.mediaType === 'string' &&
    typeof value.size === 'number' &&
    typeof value.digest === 'string'
  )
}
