import { localEdgeConfig } from '../config.ts'
import type { AppRelease } from '../release.ts'

const databaseName = `fwa-local-edge:${localEdgeConfig.appId}`
const storeName = 'metadata'
const activeReleaseKey = 'activeRelease'
const previousReleaseKey = 'previousRelease'
const retainedReleasesKey = 'retainedReleases'
const clientReleasePinsKey = 'clientReleasePins'
const candidateJournalKey = 'candidateJournal'
const localEdgeEnabledKey = 'localEdgeEnabled'

export interface ReleaseState {
  active?: AppRelease
  retained: readonly AppRelease[]
}

export interface CandidateJournal {
  releaseId: string
  phase: 'installing' | 'verified'
}

export async function readCandidateJournal() {
  const database = await openDatabase()

  try {
    return await new Promise<CandidateJournal | undefined>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).get(candidateJournalKey)
      request.onsuccess = () =>
        resolve(request.result as CandidateJournal | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export async function writeCandidateJournal(journal: CandidateJournal) {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).put(journal, candidateJournalKey)
      settleTransaction(transaction, resolve, reject)
    })
  } finally {
    database.close()
  }
}

export async function clearCandidateJournal() {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction.objectStore(storeName).delete(candidateJournalKey)
      settleTransaction(transaction, resolve, reject)
    })
  } finally {
    database.close()
  }
}

export async function readReleaseState(): Promise<ReleaseState> {
  const database = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const activeRequest = store.get(activeReleaseKey)
      const previousRequest = store.get(previousReleaseKey)
      const retainedRequest = store.get(retainedReleasesKey)
      transaction.oncomplete = () =>
        resolve(
          normalizeStoredReleaseState(
            activeRequest.result,
            retainedRequest.result,
            previousRequest.result,
          ),
        )
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function readLocalEdgeEnabled() {
  const database = await openDatabase()

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).get(localEdgeEnabledKey)
      request.onsuccess = () => resolve(request.result !== false)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export async function writeReleaseState(
  releaseState: ReleaseState,
  options: { clearCandidate?: boolean; localEdgeEnabled?: boolean } = {},
): Promise<void> {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      writeOptionalValue(store, activeReleaseKey, releaseState.active)
      writeOptionalValue(
        store,
        retainedReleasesKey,
        releaseState.retained.length > 0
          ? [...releaseState.retained]
          : undefined,
      )
      store.delete(previousReleaseKey)
      if (options.clearCandidate) {
        store.delete(candidateJournalKey)
      }
      if (options.localEdgeEnabled !== undefined) {
        store.put(options.localEdgeEnabled, localEdgeEnabledKey)
      }
      settleTransaction(transaction, resolve, reject)
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

export async function writeLocalEdgeEnabled(localEdgeEnabled: boolean) {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction
        .objectStore(storeName)
        .put(localEdgeEnabled, localEdgeEnabledKey)
      settleTransaction(transaction, resolve, reject)
    })
  } finally {
    database.close()
  }
}

export async function readClientReleasePins() {
  const database = await openDatabase()

  try {
    return await new Promise<Map<string, string>>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const request = transaction.objectStore(storeName).get(clientReleasePinsKey)
      request.onsuccess = () => {
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
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export async function writeClientReleasePins(pins: Map<string, string>) {
  const database = await openDatabase()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      transaction
        .objectStore(storeName)
        .put(Object.fromEntries(pins), clientReleasePinsKey)
      settleTransaction(transaction, resolve, reject)
    })
  } finally {
    database.close()
  }
}

export function deleteReleaseMetadata(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error('metadata database deletion blocked'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
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

function settleTransaction(
  transaction: IDBTransaction,
  resolve: () => void,
  reject: (reason?: unknown) => void,
) {
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error)
  transaction.onabort = () => reject(transaction.error)
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
