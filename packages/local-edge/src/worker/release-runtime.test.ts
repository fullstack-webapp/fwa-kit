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
  gateAssets?: Promise<void>
} = {
  descriptor: { localEdgeEnabled: false },
}

vi.mock('./release-verifier.ts', () => ({
  fetchVerifiedReleaseDescriptor: vi.fn(async () => {
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
  writeCandidateJournal: vi.fn(async () => undefined),
  clearCandidateJournal: vi.fn(async () => undefined),
  readReleaseState: vi.fn(async () => ({ retained: [] })),
  readClientReleasePins: vi.fn(async () => new Map()),
  writeClientReleasePins: vi.fn(async () => undefined),
  readLocalEdgeEnabled: vi.fn(async () => true),
  writeLocalEdgeEnabled: vi.fn(async () => undefined),
  writeReleaseState: vi.fn(async () => undefined),
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
    verifierState.gateAssets = undefined

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1250)
      .mockReturnValueOnce(1300)
      .mockReturnValueOnce(1300)

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
    const result = await runtime.revalidateReleaseForClient('window-1')

    expect(result).toMatchObject({ status: 'installed' })
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

    expect(snapshot).toEqual({
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
    vi.mocked(metadata.writeReleaseState).mockImplementation(async (state) => {
      committedActive = state.active
    })
    vi.mocked(metadata.readReleaseState).mockImplementation(async () =>
      committedActive
        ? { active: committedActive, retained: [] }
        : { retained: [] },
    )
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
    vi.mocked(metadata.writeReleaseState).mockImplementation(async () => undefined)
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
    expect(progressMessages).toEqual([
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
    expect(midInstallSnapshot.revalidation).toEqual({
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
