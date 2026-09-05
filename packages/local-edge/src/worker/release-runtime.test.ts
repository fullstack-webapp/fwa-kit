import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AppRelease,
  AppReleaseDescriptor,
  VerifiedAppRelease,
} from '../release.ts'

// vi.mock factories are hoisted above test definitions, so they can only close
// over module-level bindings. Verifier and metadata behavior is configured
// through these module-level mutable holders.
const verifierState: {
  descriptor: AppReleaseDescriptor
  failure?: Error
  assetFailure?: Error
  descriptorGate?: Promise<void>
  gateAssets?: Promise<void>
} = {
  descriptor: { localEdgeEnabled: false },
}

vi.mock('./release-verifier.ts', () => ({
  fetchVerifiedReleaseDescriptor: vi.fn(async () => {
    if (verifierState.descriptorGate) {
      await verifierState.descriptorGate
    }
    if (verifierState.failure) {
      throw verifierState.failure
    }
    return verifierState.descriptor
  }),
  fetchVerifiedAsset: vi.fn(async (_asset: unknown, signal?: AbortSignal) => {
    if (verifierState.assetFailure) {
      throw verifierState.assetFailure
    }
    if (verifierState.gateAssets) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        verifierState.gateAssets!.then(resolve, reject)
      })
    }
    return new Response('export const marker = 1', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    })
  }),
}))

vi.mock('./release-metadata.ts', () => ({
  readCandidateJournal: vi.fn(async () => undefined),
  claimCandidateJournal: vi.fn(async () => undefined),
  clearCandidateJournalIfOwned: vi.fn(async () => true),
  markCandidateJournalCleaningIfOwned: vi.fn(async () => true),
  readOrCreateMetadataEpoch: vi.fn(async () => 'metadata-epoch-test'),
  readReleaseState: vi.fn(async () => ({ retained: [] })),
  readKernelSnapshotMetadata: vi.fn(async () => ({
    localEdgeEnabled: true,
    releaseState: { retained: [] },
  })),
  readClientReleasePins: vi.fn(async () => new Map()),
  updateClientReleasePin: vi.fn(async () => new Map()),
  pruneClientReleasePins: vi.fn(async () => new Map()),
  readLocalEdgeEnabled: vi.fn(async () => true),
  writeLocalEdgeEnabled: vi.fn(async () => undefined),
  writeReleaseStateForCandidate: vi.fn(async () => undefined),
  writeRetainedReleasesIfActive: vi.fn(async () => true),
  writeCandidateJournalIfOwned: vi.fn(async () => true),
  deleteReleaseMetadata: vi.fn(async () => undefined),
}))

function makeReleaseDescriptor(assetCount: number): AppReleaseDescriptor {
  const assets = Array.from({ length: assetCount }, (_, index) => ({
    path: `/assets/app-${index}.js`,
    mediaType: 'application/javascript',
    size: 1,
    digest: `sha256:${String(index).padStart(64, '0')}`,
  }))
  return {
    localEdgeEnabled: true,
    release: {
      schemaVersion: 2,
      appId: 'local-edge-package-test',
      releaseId: '0123456789abcdef',
      appEntry: '/',
      assets,
    } satisfies VerifiedAppRelease,
  }
}

interface FakeWindowClient {
  id: string
  postMessage: ReturnType<typeof vi.fn>
}

describe('release-runtime candidate install progress', () => {
  let client: FakeWindowClient
  let runtime: typeof import('./release-runtime.ts')
  let cacheStore: Map<string, Map<string, Response>>

  beforeEach(async () => {
    client = { id: 'window-1', postMessage: vi.fn() }
    cacheStore = new Map()
    verifierState.descriptor = makeReleaseDescriptor(5)
    verifierState.failure = undefined
    verifierState.assetFailure = undefined
    verifierState.descriptorGate = undefined
    verifierState.gateAssets = undefined

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1250)
      .mockReturnValueOnce(1300)
      .mockReturnValueOnce(1300)

    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(
          async (_name: string, callback: () => Promise<unknown>) => callback(),
        ),
      },
    })
    vi.stubGlobal('self', {
      clients: { matchAll: vi.fn(async () => [client]) },
      location: { origin: 'https://app.test' },
    })

    const fakeCaches = {
      has: vi.fn(async (name: string) => cacheStore.has(name)),
      open: vi.fn(async (name: string) => {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, new Map())
        }
        const entries = cacheStore.get(name)!
        return {
          put: vi.fn(async (path: string, response: Response) => {
            entries.set(path, response)
          }),
          match: vi.fn(async (path: string) => entries.get(path)),
        }
      }),
      keys: vi.fn(async () => [...cacheStore.keys()]),
      delete: vi.fn(async (name: string) => cacheStore.delete(name)),
    }
    vi.stubGlobal('caches', fakeCaches)

    runtime = await import('./release-runtime.ts')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('broadcasts progress through the install and a committed message on success', async () => {
    const metadata = await import('./release-metadata.ts')
    const result = await runtime.revalidateReleaseForClient('window-1')

    expect(result).toMatchObject({
      status: 'installed',
      attemptId: expect.any(Number),
      kernelInstanceId: expect.any(String),
      observationRevision: expect.any(Number),
    })
    const postMessages = client.postMessage.mock.calls.map(
      ([payload]) => payload,
    )
    const progressMessages = postMessages.filter(
      (payload: { type?: string }) =>
        payload.type === '__fwa:revalidation-progress',
    )
    expect(progressMessages.length).toBeGreaterThan(0)
    const releaseId = (verifierState.descriptor as {
      release?: { releaseId: string }
    }).release?.releaseId
    const lastProgress = progressMessages[progressMessages.length - 1]
    expect(lastProgress).toMatchObject({
      type: '__fwa:revalidation-progress',
      releaseId,
      completedAssets: 5,
      totalAssets: 5,
    })
    expect(
      postMessages.some(
        (payload: { type?: string; releaseId?: string }) =>
          payload.type === '__fwa:revalidation-committed' &&
          payload.releaseId === releaseId,
      ),
    ).toBe(true)
    const terminal = postMessages.find(
      (payload: { type?: string }) =>
        payload.type === '__fwa:revalidation-committed',
    ) as {
      attemptId: number
      kernelInstanceId: string
      observationRevision: number
    }
    expect(terminal).toMatchObject({
      attemptId: result.attemptId,
      kernelInstanceId: result.kernelInstanceId,
      observationRevision: result.observationRevision,
    })
    expect(
      progressMessages.every(
        (payload: { attemptId?: number; kernelInstanceId?: string }) =>
          payload.attemptId === result.attemptId &&
          payload.kernelInstanceId === result.kernelInstanceId,
      ),
    ).toBe(true)
    expect(vi.mocked(metadata.writeReleaseStateForCandidate)).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataEpoch: 'metadata-epoch-test',
        attemptId: result.attemptId,
        kernelInstanceId: result.kernelInstanceId,
        releaseId,
      }),
      expect.objectContaining({
        active: expect.objectContaining({ releaseId }),
      }),
    )

    const snapshot = await runtime.getLocalEdgeSnapshot()
    expect(snapshot.revalidation).toBeUndefined()
  })

  it('clears progress state and broadcasts failed (not committed) when an asset fails', async () => {
    verifierState.assetFailure = new Error('candidate asset failed')

    await expect(
      runtime.revalidateReleaseForClient('window-1'),
    ).rejects.toThrow('candidate asset failed')

    const snapshot = await runtime.getLocalEdgeSnapshot()
    expect(snapshot.revalidation).toBeUndefined()
    expect(
      client.postMessage.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string } | undefined)?.type ===
          '__fwa:revalidation-committed',
      ),
    ).toBe(false)
    const releaseId = (verifierState.descriptor as {
      release?: { releaseId: string }
    }).release?.releaseId
    expect(
      client.postMessage.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string; releaseId?: string })?.type ===
            '__fwa:revalidation-failed' &&
          (call[0] as { releaseId?: string }).releaseId === releaseId,
      ),
    ).toBe(true)
  })

  it('broadcasts failed when reset aborts the install', async () => {
    const never = new Promise<void>(() => {})
    verifierState.gateAssets = never

    const revalidation = runtime.revalidateReleaseForClient('window-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    await runtime.resetReleaseRuntime()
    await expect(revalidation).rejects.toThrow()

    const releaseId = (verifierState.descriptor as {
      release?: { releaseId: string }
    }).release?.releaseId
    expect(
      client.postMessage.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string; releaseId?: string })?.type ===
            '__fwa:revalidation-failed' &&
          (call[0] as { releaseId?: string }).releaseId === releaseId,
      ),
    ).toBe(true)
    expect(
      client.postMessage.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string } | undefined)?.type ===
          '__fwa:revalidation-committed',
      ),
    ).toBe(false)
  })

  it('answers post-reset snapshots from memory without touching metadata', async () => {
    const metadata = await import('./release-metadata.ts')
    await runtime.revalidateReleaseForClient('window-1')
    await runtime.resetReleaseRuntime()
    const readCallsAfterReset = vi.mocked(metadata.readReleaseState).mock.calls
      .length

    const snapshot = await runtime.getLocalEdgeSnapshot()

    expect(snapshot).toMatchObject({
      localEdgeEnabled: false,
      mode: 'network-only',
    })
    expect(vi.mocked(metadata.readReleaseState).mock.calls.length).toBe(
      readCallsAfterReset,
    )
  })

  it('rejects revalidation attempts after a reset', async () => {
    await runtime.resetReleaseRuntime()

    await expect(
      runtime.revalidateReleaseForClient('window-1'),
    ).rejects.toThrow('release runtime is resetting')
  })

  it.each([
    ['active', { active: makeReleaseDescriptor(5).release, retained: [] }],
    [
      'retained',
      {
        active: {
          ...makeReleaseDescriptor(5).release!,
          releaseId: 'aaaaaaaaaaaaaaaa',
        },
        retained: [makeReleaseDescriptor(5).release!],
      },
    ],
  ])(
    'preserves a referenced %s release cache when repair installation fails',
    async (_kind, releaseState) => {
      const metadata = await import('./release-metadata.ts')
      const releaseId = makeReleaseDescriptor(5).release!.releaseId
      const cacheName =
        `fwa-local-edge:local-edge-package-test:release:${releaseId}`
      cacheStore.set(cacheName, new Map([['/assets/app-0.js', new Response('old')]]))
      vi.mocked(metadata.readReleaseState)
        .mockResolvedValueOnce(releaseState)
        .mockResolvedValueOnce(releaseState)
        .mockResolvedValueOnce(releaseState)
      vi.mocked(metadata.pruneClientReleasePins).mockResolvedValueOnce(
        new Map([['window-1', releaseId]]),
      )
      verifierState.assetFailure = new Error('repair failed')

      await expect(
        runtime.revalidateReleaseForClient('window-1'),
      ).rejects.toThrow('repair failed')

      expect(cacheStore.has(cacheName)).toBe(true)
      expect(caches.delete).not.toHaveBeenCalledWith(cacheName)
    },
  )

  it('re-reads release metadata under the commit lock before deriving retained releases', async () => {
    const metadata = await import('./release-metadata.ts')
    const candidate = makeReleaseDescriptor(5).release!
    const active = { ...candidate, releaseId: 'aaaaaaaaaaaaaaaa' }
    const pruned = { ...candidate, releaseId: 'bbbbbbbbbbbbbbbb' }
    vi.mocked(metadata.pruneClientReleasePins).mockResolvedValueOnce(
      new Map([['window-1', pruned.releaseId]]),
    )
    vi.mocked(metadata.readReleaseState)
      .mockResolvedValueOnce({ active, retained: [pruned] })
      .mockResolvedValueOnce({ active, retained: [pruned] })
      .mockResolvedValueOnce({ active, retained: [] })

    await runtime.revalidateReleaseForClient('window-1')

    expect(metadata.writeReleaseStateForCandidate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        active: candidate,
        retained: [active],
      }),
    )
  })

  it('holds descriptor observation and its mode transition under one lock', async () => {
    const metadata = await import('./release-metadata.ts')
    let releaseDescriptor!: () => void
    let lockHeld = false
    verifierState.descriptor = { localEdgeEnabled: false }
    verifierState.descriptorGate = new Promise<void>((resolve) => {
      releaseDescriptor = resolve
    })
    const requestLock = navigator.locks.request as unknown as ReturnType<
      typeof vi.fn
    >
    requestLock.mockImplementation(
      async (_name: string, callback: (lock: Lock) => Promise<unknown>) => {
        lockHeld = true
        try {
          return await callback({} as Lock)
        } finally {
          lockHeld = false
        }
      },
    )
    vi.mocked(metadata.writeLocalEdgeEnabled).mockImplementationOnce(
      async () => {
        expect(lockHeld).toBe(true)
      },
    )

    const revalidation = runtime.revalidateReleaseForClient('window-1')
    await vi.waitFor(() => expect(lockHeld).toBe(true))
    releaseDescriptor()

    await expect(revalidation).resolves.toMatchObject({ status: 'disabled' })
    expect(lockHeld).toBe(false)
  })

  it('revokes an in-flight candidate owner before publishing disabled mode', async () => {
    const metadata = await import('./release-metadata.ts')
    const previousOwner = {
      metadataEpoch: 'metadata-epoch-test',
      kernelInstanceId: '00000000-0000-4000-8000-000000000099',
      attemptId: 7,
      releaseId: 'fedcba9876543210',
      phase: 'installing' as const,
    }
    verifierState.descriptor = { localEdgeEnabled: false }
    vi.mocked(metadata.readCandidateJournal).mockResolvedValueOnce(previousOwner)

    const result = await runtime.revalidateReleaseForClient('window-1')

    expect(result).toMatchObject({
      status: 'disabled',
      localEdgeEnabled: false,
    })
    expect(metadata.claimCandidateJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataEpoch: 'metadata-epoch-test',
        releaseId: previousOwner.releaseId,
        phase: 'cleaning',
      }),
    )
    expect(metadata.clearCandidateJournalIfOwned).toHaveBeenCalled()
    expect(caches.delete).toHaveBeenCalledWith(
      `fwa-local-edge:local-edge-package-test:release:${previousOwner.releaseId}`,
    )
  })

  it('does not clean candidate state after a superseded commit is rejected', async () => {
    const metadata = await import('./release-metadata.ts')
    vi.mocked(metadata.writeReleaseStateForCandidate).mockClear()
    vi.mocked(metadata.markCandidateJournalCleaningIfOwned).mockClear()
    vi.mocked(metadata.clearCandidateJournalIfOwned).mockClear()
    vi.mocked(caches.delete).mockClear()
    vi.mocked(metadata.writeReleaseStateForCandidate).mockRejectedValueOnce(
      new Error('Local Edge candidate ownership was superseded'),
    )
    vi.mocked(metadata.markCandidateJournalCleaningIfOwned).mockResolvedValueOnce(
      false,
    )

    await expect(
      runtime.revalidateReleaseForClient('window-1'),
    ).rejects.toThrow('candidate ownership was superseded')

    expect(metadata.clearCandidateJournalIfOwned).not.toHaveBeenCalled()
    expect(caches.delete).not.toHaveBeenCalledWith(
      'fwa-local-edge:fwa-local-edge-demo:release:0123456789abcdef',
    )
    expect(
      client.postMessage.mock.calls.some(
        (call: unknown[]) =>
          (call[0] as { type?: string })?.type ===
          '__fwa:revalidation-committed',
      ),
    ).toBe(false)
  })

  it('keeps a committed install when the committed broadcast fails', async () => {
    client.postMessage = vi.fn((payload: { type?: string }) => {
      if (payload.type === '__fwa:revalidation-committed') {
        throw new Error('postMessage channel unavailable')
      }
      return undefined
    })

    const result = await runtime.revalidateReleaseForClient('window-1')

    expect(result).toMatchObject({ status: 'installed' })
    const postMessages = client.postMessage.mock.calls.map(
      ([payload]) => payload as { type?: string },
    )
    expect(
      postMessages.some(({ type }) => type === '__fwa:revalidation-failed'),
    ).toBe(false)
    const releaseId = (verifierState.descriptor as {
      release?: { releaseId: string }
    }).release?.releaseId
    const releaseCache = cacheStore.get(`fwa-local-edge:local-edge-package-test:release:${releaseId}`)
    expect(releaseCache).toBeDefined()
    expect(releaseCache!.size).toBe(5)
  })

  it('clears kernel progress before the committed broadcast is observable', async () => {
    let snapshotAtCommit: Awaited<ReturnType<typeof runtime.getLocalEdgeSnapshot>> | undefined
    client.postMessage = vi.fn(async (payload: { type?: string }) => {
      if (payload.type === '__fwa:revalidation-committed') {
        // A client reacting to the terminal message re-pulls the state
        // endpoint; the kernel must already report no running install.
        snapshotAtCommit = await runtime.getLocalEdgeSnapshot()
      }
      return undefined
    })

    await runtime.revalidateReleaseForClient('window-1')

    expect(snapshotAtCommit).toBeDefined()
    expect(snapshotAtCommit!.revalidation).toBeUndefined()
  })

  it('refreshes the enabled cache before the committed broadcast is observable', async () => {
    vi.resetModules()
    verifierState.descriptor = makeReleaseDescriptor(5)
    const metadata = await import('./release-metadata.ts')
    // The kernel was previously disabled: the first enabled read primes the
    // runtime's cache with false.
    vi.mocked(metadata.readLocalEdgeEnabled).mockResolvedValueOnce(false)
    // The release state becomes active once the install commits, mirroring
    // the worker's persisted state endpoint.
    let committedActive: AppRelease | undefined
    vi.mocked(metadata.writeReleaseStateForCandidate).mockImplementation(async (_owner, state) => {
      committedActive = state.active
    })
    vi.mocked(metadata.readReleaseState).mockImplementation(async () =>
      committedActive
        ? { active: committedActive, retained: [] }
        : { retained: [] },
    )
    vi.mocked(metadata.readKernelSnapshotMetadata).mockImplementation(async () => ({
      localEdgeEnabled: committedActive ? true : false,
      releaseState: committedActive
        ? { active: committedActive, retained: [] }
        : { retained: [] },
    }))
    runtime = await import('./release-runtime.ts')

    const disabledSnapshot = await runtime.getLocalEdgeSnapshot()
    expect(disabledSnapshot.mode).toBe('disabled')

    let snapshotAtCommit:
      | Awaited<ReturnType<typeof runtime.getLocalEdgeSnapshot>>
      | undefined
    client.postMessage = vi.fn(async (payload: { type?: string }) => {
      if (payload.type === '__fwa:revalidation-committed') {
        // A pull triggered by the commit message must see the committed
        // release as active, not the previously disabled kernel.
        snapshotAtCommit = await runtime.getLocalEdgeSnapshot()
      }
      return undefined
    })

    await runtime.revalidateReleaseForClient('window-1')

    expect(snapshotAtCommit).toBeDefined()
    expect(snapshotAtCommit!.mode).toBe('active')
    expect(snapshotAtCommit!.release?.releaseId).toBe('0123456789abcdef')

    // Restore the factory defaults for the tests that follow.
    vi.mocked(metadata.writeReleaseStateForCandidate).mockImplementation(async () => undefined)
    vi.mocked(metadata.readReleaseState).mockImplementation(
      async () => ({ retained: [] }),
    )
  })

  it('clears kernel progress before the failed broadcast is observable', async () => {
    verifierState.assetFailure = new Error('candidate asset failed')
    let snapshotAtFailure: Awaited<ReturnType<typeof runtime.getLocalEdgeSnapshot>> | undefined
    client.postMessage = vi.fn(async (payload: { type?: string }) => {
      if (payload.type === '__fwa:revalidation-failed') {
        snapshotAtFailure = await runtime.getLocalEdgeSnapshot()
      }
      return undefined
    })

    await expect(
      runtime.revalidateReleaseForClient('window-1'),
    ).rejects.toThrow('candidate asset failed')

    expect(snapshotAtFailure).toBeDefined()
    expect(snapshotAtFailure!.revalidation).toBeUndefined()
  })

  it('drains pending progress sends before the committed broadcast', async () => {
    vi.resetModules()
    verifierState.descriptor = makeReleaseDescriptor(3)
    const delayedClient = { id: 'window-1', postMessage: vi.fn() }
    let matchAllCalls = 0
    vi.stubGlobal('self', {
      clients: {
        matchAll: vi.fn(async () => {
          matchAllCalls += 1
          if (matchAllCalls === 1) {
            // The first progress send is slow: without draining the pending
            // sends, the committed broadcast would overtake it and a client
            // could receive stale progress after the terminal event.
            await new Promise((resolve) => setTimeout(resolve, 30))
          }
          return [delayedClient]
        }),
      },
      location: { origin: 'https://app.test' },
    })
    const cacheStoreForDrain = new Map<string, Map<string, Response>>()
    vi.stubGlobal('caches', {
      has: vi.fn(async (name: string) => cacheStoreForDrain.has(name)),
      open: vi.fn(async (name: string) => {
        if (!cacheStoreForDrain.has(name)) {
          cacheStoreForDrain.set(name, new Map())
        }
        const entries = cacheStoreForDrain.get(name)!
        return {
          put: vi.fn(async (path: string, response: Response) => {
            entries.set(path, response)
          }),
          match: vi.fn(async (path: string) => entries.get(path)),
        }
      }),
      keys: vi.fn(async () => [...cacheStoreForDrain.keys()]),
      delete: vi.fn(async (name: string) => cacheStoreForDrain.delete(name)),
    })

    const fresh = await import('./release-runtime.ts')
    await fresh.revalidateReleaseForClient('window-1')

    const types = delayedClient.postMessage.mock.calls.map(
      ([payload]) => (payload as { type?: string }).type,
    )
    expect(types[types.length - 1]).toBe('__fwa:revalidation-committed')
  })

  it('does not broadcast failed when the descriptor fetch fails before an install starts', async () => {
    verifierState.failure = new Error('descriptor fetch failed')

    await expect(
      runtime.revalidateReleaseForClient('window-1'),
    ).rejects.toThrow('descriptor fetch failed')

    expect(client.postMessage.mock.calls).toHaveLength(0)
  })

  it('sends the final progress message even when assets complete in the same millisecond', async () => {
    verifierState.descriptor = makeReleaseDescriptor(3)
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReset().mockReturnValue(2000)

    await runtime.revalidateReleaseForClient('window-1')

    const progressMessages = client.postMessage.mock.calls
      .map(([payload]) => payload as { type?: string; completedAssets?: number; totalAssets?: number })
      .filter((payload) => payload.type === '__fwa:revalidation-progress')
    expect(progressMessages).toMatchObject([
      {
        type: '__fwa:revalidation-progress',
        releaseId: (verifierState.descriptor as { release?: { releaseId: string } })
          .release?.releaseId,
        completedAssets: 1,
        totalAssets: 3,
      },
      {
        type: '__fwa:revalidation-progress',
        releaseId: (verifierState.descriptor as { release?: { releaseId: string } })
          .release?.releaseId,
        completedAssets: 3,
        totalAssets: 3,
      },
    ])
  })

  it('exposes revalidation in the snapshot while the install is running', async () => {
    let releaseAssetGate!: () => void
    const assetGate = new Promise<void>((resolve) => {
      releaseAssetGate = resolve
    })
    verifierState.gateAssets = assetGate

    const revalidationPromise = runtime.revalidateReleaseForClient('window-1')
    // Give the install loop a chance to begin before the gated assets resolve.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const midInstallSnapshot = await runtime.getLocalEdgeSnapshot()
    const releaseId = (verifierState.descriptor as {
      release?: { releaseId: string }
    }).release?.releaseId
    expect(midInstallSnapshot.revalidation).toMatchObject({
      releaseId,
      completedAssets: 0,
      totalAssets: 5,
    })

    releaseAssetGate()
    await revalidationPromise

    const committedSnapshot = await runtime.getLocalEdgeSnapshot()
    expect(committedSnapshot.revalidation).toBeUndefined()
  })
})
