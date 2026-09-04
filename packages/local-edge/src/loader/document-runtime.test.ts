import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fwaKernelProtocolHeaderName,
  fwaKernelProtocolVersion,
  fwaRevalidationCommittedMessageType,
  fwaRevalidationFailedMessageType,
  fwaRevalidationProgressMessageType,
  maxUpdateCheckIntervalMinutes,
} from '../config-contract.ts'
import {
  createLocalEdgeDocumentRuntime,
  type LocalEdgeDocumentScheduler,
} from './document-runtime.ts'

const workerPath = '/__fwa-sw.js'
const workerUrl = `https://app.example${workerPath}`
const updateCheckIntervalMs = 5 * 60 * 1000
const documentConfig = {
  scopePath: '/',
  workerPath,
  controlPrefix: '/__fwa',
}

function fwaKernelStateHeaders() {
  return {
    'X-FWA-Kernel': workerPath,
    [fwaKernelProtocolHeaderName]: String(fwaKernelProtocolVersion),
  }
}

interface FakeScheduler {
  scheduler: LocalEdgeDocumentScheduler
  advanceTime(milliseconds: number): void
  elapse(milliseconds: number): void
  triggerVisible(): void
  triggerHidden(): void
  triggerOnline(): void
  intervalCount(): number
  visibilityListenerCount(): number
  onlineListenerCount(): number
}

function createFakeScheduler(): FakeScheduler {
  let now = 0
  let visible = true
  let nextIntervalId = 1
  const intervals = new Map<
    number,
    { callback: () => void; intervalMs: number; nextRunAt: number }
  >()
  const visibilityCallbacks = new Set<() => void>()
  const onlineCallbacks = new Set<() => void>()

  const scheduler: LocalEdgeDocumentScheduler = {
    now: () => now,
    isVisible: () => visible,
    setInterval(callback, intervalMs) {
      const id = nextIntervalId
      nextIntervalId += 1
      intervals.set(id, {
        callback,
        intervalMs,
        nextRunAt: now + intervalMs,
      })
      return id
    },
    clearInterval(handle) {
      intervals.delete(handle)
    },
    onVisibilityChange(callback) {
      visibilityCallbacks.add(callback)
      return () => visibilityCallbacks.delete(callback)
    },
    onOnline(callback) {
      onlineCallbacks.add(callback)
      return () => onlineCallbacks.delete(callback)
    },
  }

  return {
    scheduler,
    advanceTime(milliseconds: number) {
      now += milliseconds
      const due = [...intervals.values()].filter(
        (interval) => interval.nextRunAt <= now,
      )
      for (const interval of due) {
        const nextRunAt = interval.nextRunAt
        interval.callback()
        interval.nextRunAt = nextRunAt + interval.intervalMs
      }
    },
    elapse(milliseconds: number) {
      now += milliseconds
    },
    triggerVisible() {
      visible = true
      for (const callback of visibilityCallbacks) {
        callback()
      }
    },
    triggerHidden() {
      visible = false
    },
    triggerOnline() {
      for (const callback of onlineCallbacks) {
        callback()
      }
    },
    intervalCount: () => intervals.size,
    visibilityListenerCount: () => visibilityCallbacks.size,
    onlineListenerCount: () => onlineCallbacks.size,
  }
}

function createControlledKernel(options: {
  scheduler?: LocalEdgeDocumentScheduler
  protocolVersion?: string | null
  snapshotMode?: 'active' | 'disabled' | 'network-only'
  snapshotRevalidation?: {
    releaseId: string
    completedAssets: number
    totalAssets: number
  }
  updateCheck?: {
    enabled?: boolean
    intervalMinutes?: number
  }
  documentHref?: string
  revalidationStatus?: string
  revalidationReleaseId?: string
  scheduledFailure?: boolean
  scheduledResponse?: Promise<Response>
  fetch?: (input: RequestInfo | URL) => Promise<Response>
} = {}) {
  const {
    scheduler,
    protocolVersion = String(fwaKernelProtocolVersion),
    snapshotMode = 'active',
    snapshotRevalidation,
    updateCheck,
    documentHref = 'https://app.example/',
    revalidationStatus = 'current',
    revalidationReleaseId,
    scheduledFailure = false,
    scheduledResponse,
    fetch,
  } = options
  const normalizedUpdateCheck = updateCheck
    ? {
        enabled: updateCheck.enabled ?? true,
        intervalMinutes: updateCheck.intervalMinutes ?? 5,
      }
    : undefined
  const fakeScheduler = createFakeScheduler()
  const effectiveScheduler = scheduler ?? fakeScheduler.scheduler
  const reload = vi.fn()
  const controller = { scriptURL: workerUrl } as ServiceWorker
  const serviceWorker = Object.assign(new EventTarget(), { controller })
  const storage = new Map<string, string>()
  const registration = {
    active: controller,
    installing: null,
    scope: 'https://app.example/',
    waiting: null,
  } as unknown as ServiceWorkerRegistration
  const replaceServiceWorker = vi.fn(async () => registration)

  let revalidationCallCount = 0
  let kernelActiveReleaseId = 'release-a'
  const defaultFetch = async (input: RequestInfo | URL) => {
    const requestUrl = String(input)
    if (requestUrl === '/__fwa/state') {
      const headers = new Headers({ 'X-FWA-Kernel': workerPath })
      if (protocolVersion !== null) {
        headers.set(fwaKernelProtocolHeaderName, protocolVersion)
      }
      return Response.json(
        {
          localEdgeEnabled: snapshotMode === 'active',
          mode: snapshotMode,
          ...(snapshotMode === 'active'
            ? { release: { releaseId: kernelActiveReleaseId } }
            : undefined),
          ...(snapshotRevalidation ? { revalidation: snapshotRevalidation } : undefined),
        },
        { headers },
      )
    }
    if (requestUrl === '/__fwa/revalidate') {
      revalidationCallCount += 1
      if (revalidationCallCount === 1) {
        return Response.json({
          localEdgeEnabled: true,
          release: { releaseId: 'release-a' },
          status: 'current',
        })
      }
      if (scheduledResponse) {
        return scheduledResponse
      }
      if (scheduledFailure) {
        return new Response('boom', { status: 503 })
      }
      // A committed install becomes the kernel's active release: the state
      // endpoint mirrors the worker's in-memory state afterwards.
      if (
        revalidationReleaseId &&
        (revalidationStatus === 'updated' || revalidationStatus === 'repaired')
      ) {
        kernelActiveReleaseId = revalidationReleaseId
      }
      return Response.json({
        localEdgeEnabled: true,
        release: revalidationReleaseId
          ? { releaseId: revalidationReleaseId }
          : { releaseId: 'release-a' },
        status: revalidationStatus,
      })
    }
    throw new Error(`unexpected fetch: ${requestUrl}`)
  }
  const fetchMock = vi.fn(fetch ?? defaultFetch)

  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('window', {
    location: {
      href: documentHref,
      origin: 'https://app.example',
      reload,
      replace: vi.fn(),
    },
  })
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  })
  vi.stubGlobal('fetch', fetchMock)

  const runtime = createLocalEdgeDocumentRuntime(
    {
      ...documentConfig,
      ...(normalizedUpdateCheck ? { updateCheck: normalizedUpdateCheck } : undefined),
    },
    {
      registerServiceWorker: async () => {
        throw new Error('registration is not expected')
      },
      replaceServiceWorker,
      scheduler: effectiveScheduler,
    },
  )
  runtime.start()

  return {
    fetchMock,
    reload,
    replaceServiceWorker,
    runtime,
    serviceWorker,
  }
}

async function waitForPhase(
  runtime: ReturnType<typeof createLocalEdgeDocumentRuntime>,
  phase: string,
) {
  await new Promise<void>((resolve) => {
    runtime.subscribe((state) => {
      if (state.phase === phase) resolve()
    })
  })
}

async function settle(runtime: ReturnType<typeof createLocalEdgeDocumentRuntime>) {
  await vi.waitFor(() => {
    expect(runtime.getState()).toMatchObject({
      phase: 'ready',
      revalidating: false,
    })
  })
}

describe('createLocalEdgeDocumentRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('continues first install without a reload when the worker claims the document', async () => {
    const fakeScheduler = createFakeScheduler()
    const reload = vi.fn()
    const controller = { scriptURL: workerUrl } as ServiceWorker
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: null as ServiceWorker | null,
    })
    const registration = {
      active: controller,
      installing: null,
      scope: 'https://app.example/',
      waiting: null,
    } as unknown as ServiceWorkerRegistration

    vi.stubGlobal('navigator', { serviceWorker })
    vi.stubGlobal('window', {
      location: {
        href: 'https://app.example/',
        origin: 'https://app.example',
        reload,
        replace: vi.fn(),
      },
    })
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const requestUrl = String(input)
        if (requestUrl === '/__fwa/revalidate') {
          return Response.json({
            localEdgeEnabled: true,
            release: { releaseId: 'release-a' },
            status: 'installed',
          })
        }
        if (requestUrl === '/__fwa/state') {
          return Response.json(
            {
              localEdgeEnabled: true,
              mode: 'active',
              release: { releaseId: 'release-a' },
            },
            { headers: fwaKernelStateHeaders() },
          )
        }
        throw new Error(`unexpected fetch: ${requestUrl}`)
      })
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createLocalEdgeDocumentRuntime(
      documentConfig,
      {
        registerServiceWorker: async () => {
          queueMicrotask(() => {
            serviceWorker.controller = controller
            serviceWorker.dispatchEvent(new Event('controllerchange'))
          })
          return registration
        },
        replaceServiceWorker: async () => {
          throw new Error('legacy takeover is not expected')
        },
        scheduler: fakeScheduler.scheduler,
      },
    )
    runtime.start()
    await waitForPhase(runtime, 'ready')

    expect(runtime.getState()).toMatchObject({
      controlled: true,
      phase: 'ready',
      releaseId: 'release-a',
    })
    expect(reload).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.stop()
  })

  it('accepts a controlled worker that meets the required kernel protocol level', async () => {
    const { runtime, replaceServiceWorker, reload } = createControlledKernel({
      protocolVersion: String(fwaKernelProtocolVersion),
    })
    await waitForPhase(runtime, 'ready')

    expect(runtime.getState()).toMatchObject({
      controlled: true,
      phase: 'ready',
      releaseId: 'release-a',
    })
    expect(replaceServiceWorker).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('allows a cached loader to continue with a newer backward-compatible kernel', async () => {
    const { runtime, replaceServiceWorker, reload } = createControlledKernel({
      protocolVersion: String(fwaKernelProtocolVersion + 1),
    })
    await waitForPhase(runtime, 'ready')

    expect(runtime.getState()).toMatchObject({
      controlled: true,
      phase: 'ready',
      releaseId: 'release-a',
    })
    expect(replaceServiceWorker).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', null],
    ['invalid', 'not-a-version'],
    ['older', String(fwaKernelProtocolVersion - 1)],
  ])(
    'routes a controlled worker with a %s protocol identity through one guarded takeover',
    async (_case, protocolVersion) => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, reload, replaceServiceWorker } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        protocolVersion,
      })

      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
      await new Promise((resolve) => setTimeout(resolve, 0))

      const repeatedRuntime = createLocalEdgeDocumentRuntime(
        documentConfig,
        {
          registerServiceWorker: async () => {
            throw new Error('registration is not expected')
          },
          replaceServiceWorker,
          scheduler: fakeScheduler.scheduler,
        },
      )
      repeatedRuntime.start()
      await waitForPhase(repeatedRuntime, 'error')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(replaceServiceWorker).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(repeatedRuntime.getState().message).toContain(
        'still unavailable after Service Worker takeover',
      )
      expect(runtime.getState()).toBeDefined()
      runtime.stop()
      repeatedRuntime.stop()
    },
  )

  it('does not schedule checks when Service Worker is unsupported', async () => {
    const fakeScheduler = createFakeScheduler()
    vi.stubGlobal('navigator', {})
    const runtime = createLocalEdgeDocumentRuntime(
      {
        ...documentConfig,
        updateCheck: { enabled: true, intervalMinutes: 5 },
      },
      {
        registerServiceWorker: async () => {
          throw new Error('registration is not expected')
        },
        replaceServiceWorker: async () => {
          throw new Error('replacement is not expected')
        },
        scheduler: fakeScheduler.scheduler,
      },
    )

    runtime.start()
    await waitForPhase(runtime, 'unsupported')

    expect(fakeScheduler.intervalCount()).toBe(0)
    runtime.stop()
  })

  describe('scheduled update checks', () => {
    it('leaves the published state unchanged when the release is unchanged', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)
      const before = runtime.getState()

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(2)
      expect(runtime.getState()).toEqual(before)
    })

    it('publishes updateAvailable with the new release id after a scheduled check', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, reload } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        revalidationReleaseId: 'release-b',
        revalidationStatus: 'updated',
      })
      await settle(runtime)

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(runtime.getState().updateAvailable).toBe(true)
      })

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        availableReleaseId: 'release-b',
        updateAvailable: true,
        message: '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。',
      })
      expect(reload).not.toHaveBeenCalled()
    })

    it('does not claim a network-only document became ready after prefetch', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        snapshotMode: 'disabled',
        updateCheck: { intervalMinutes: 5 },
        revalidationStatus: 'disabled',
      })
      await vi.waitFor(() => {
        expect(runtime.getState().phase).toBe('network-only')
      })
      const beforeMessage = runtime.getState().message

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()

      expect(runtime.getState()).toMatchObject({
        phase: 'network-only',
        controlled: true,
        updateAvailable: false,
        message: beforeMessage,
      })
    })

    it('publishes the first release installed by a scheduled check', async () => {
      const fakeScheduler = createFakeScheduler()
      let installed = false
      let revalidationCount = 0
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            return Response.json(
              installed
                ? {
                    localEdgeEnabled: true,
                    mode: 'active',
                    release: { releaseId: 'release-a' },
                  }
                : { localEdgeEnabled: true, mode: 'network-only' },
              { headers: fwaKernelStateHeaders() },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            revalidationCount += 1
            if (revalidationCount === 1) {
              return new Response('boom', { status: 503 })
            }
            installed = true
            return Response.json({
              localEdgeEnabled: true,
              release: { releaseId: 'release-a' },
              status: 'installed',
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'network-only',
          revalidating: false,
          updateAvailable: false,
        })
      })

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()

      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          controlled: true,
          phase: 'ready',
          releaseId: 'release-a',
          revalidating: false,
          updateAvailable: false,
        })
      })
    })

    it('keeps the last known good release silent when a scheduled check fails', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        scheduledFailure: true,
      })
      await settle(runtime)
      const before = runtime.getState()

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(2)
      expect(runtime.getState()).toEqual(before)
      expect(before.message).not.toMatch(/failed|失败|warning/i)
    })

    it('fires at most one descriptor request for rapid visibility triggers within the interval', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)

      fakeScheduler.triggerVisible()
      await Promise.resolve()
      fakeScheduler.triggerVisible()
      await Promise.resolve()
      fakeScheduler.triggerVisible()
      await Promise.resolve()

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(1)

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(2)
      expect(runtime.getState().revalidating).toBe(false)
      expect(runtime.getState().message).not.toMatch(/正在检查|正在下载/)
    })

    it('checks on the configured interval while the document remains visible', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)

      fakeScheduler.advanceTime(updateCheckIntervalMs)

      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })
    })

    it('skips interval checks while hidden and checks when visible again', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)

      fakeScheduler.triggerHidden()
      fakeScheduler.advanceTime(updateCheckIntervalMs)
      await Promise.resolve()
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(1)

      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })
    })

    it('does not retry immediately after a failed check', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        scheduledFailure: true,
      })
      await settle(runtime)

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      fakeScheduler.triggerVisible()
      await Promise.resolve()

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(2)
      expect(runtime.getState().revalidating).toBe(false)

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerOnline()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(3)
      })
    })

    it('keeps the visible activity state for explicit revalidate calls', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)
      const idleMessage = runtime.getState().message

      const outcome = runtime.revalidate()

      expect(runtime.getState().revalidating).toBe(true)
      expect(runtime.getState().message).toMatch(/正在检查/)
      await outcome
      expect(runtime.getState().revalidating).toBe(false)
      expect(runtime.getState().message).toBe(idleMessage)
    })

    it('keeps the visible warning for an explicit revalidation failure', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        scheduledFailure: true,
      })
      await settle(runtime)

      await expect(runtime.revalidate()).resolves.toBe('failed')

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        revalidating: false,
        message:
          'Release revalidation failed; the last committed release remains active.',
      })
    })

    it('promotes an in-flight scheduled check when explicitly requested', async () => {
      const fakeScheduler = createFakeScheduler()
      let resolveScheduledResponse!: (response: Response) => void
      const scheduledResponse = new Promise<Response>((resolve) => {
        resolveScheduledResponse = resolve
      })
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        scheduledResponse,
      })
      await settle(runtime)

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })

      const explicitOutcome = runtime.revalidate()
      expect(runtime.getState().revalidating).toBe(true)
      expect(runtime.getState().message).toMatch(/正在检查/)

      resolveScheduledResponse(new Response('boom', { status: 503 }))
      await expect(explicitOutcome).resolves.toBe('failed')

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        revalidating: false,
        message:
          'Release revalidation failed; the last committed release remains active.',
      })
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(2)
    })

    it('starts no timer when the update check is disabled', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { enabled: false, intervalMinutes: 5 },
      })
      await settle(runtime)

      expect(fakeScheduler.intervalCount()).toBe(0)
    })

    it('removes scheduled timers and listeners when stopped', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)

      expect(fakeScheduler.intervalCount()).toBe(1)
      expect(fakeScheduler.visibilityListenerCount()).toBe(1)
      expect(fakeScheduler.onlineListenerCount()).toBe(1)

      runtime.stop()

      expect(fakeScheduler.intervalCount()).toBe(0)
      expect(fakeScheduler.visibilityListenerCount()).toBe(0)
      expect(fakeScheduler.onlineListenerCount()).toBe(0)
      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      fakeScheduler.triggerOnline()
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(1)
    })

    it('updates the current document schedule without persisting it', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { enabled: false, intervalMinutes: 5 },
      })
      await settle(runtime)

      runtime.setUpdateCheck({ enabled: true, intervalMinutes: 10 })
      expect(fakeScheduler.intervalCount()).toBe(1)
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/revalidate',
        ),
      ).toHaveLength(1)

      fakeScheduler.advanceTime(10 * 60 * 1000)
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })

      runtime.setUpdateCheck({ enabled: false })
      expect(fakeScheduler.intervalCount()).toBe(0)
    })

    it('rejects runtime intervals that overflow browser timers', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
      })
      await settle(runtime)

      expect(() =>
        runtime.setUpdateCheck({
          intervalMinutes: maxUpdateCheckIntervalMinutes + 1,
        }),
      ).toThrow('Local Edge update check config is invalid')
      expect(fakeScheduler.intervalCount()).toBe(1)
    })

    it('checks immediately when a shorter runtime interval is already due', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime, fetchMock } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { enabled: true, intervalMinutes: 10 },
      })
      await settle(runtime)

      fakeScheduler.elapse(8 * 60 * 1000)
      runtime.setUpdateCheck({ intervalMinutes: 2 })

      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/revalidate',
          ),
        ).toHaveLength(2)
      })
    })
  })

  describe('kernel revalidation progress messages', () => {
    const controllerSource = (serviceWorker: { controller: ServiceWorker | null }) =>
      serviceWorker.controller

    function kernelMessage(
      data: unknown,
      source: unknown,
    ): MessageEvent {
      const event = new MessageEvent('message', { data })
      Object.defineProperty(event, 'source', {
        configurable: true,
        value: source,
      })
      return event
    }

    it('publishes revalidationProgress from the kernel snapshot when a pull sees an install', async () => {
      const { runtime } = createControlledKernel({
        snapshotRevalidation: {
          releaseId: 'release-b',
          completedAssets: 2,
          totalAssets: 9,
        },
      })
      await settle(runtime)

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        revalidationProgress: {
          releaseId: 'release-b',
          completedAssets: 2,
          totalAssets: 9,
        },
      })
    })

    it('drops a stale revalidationProgress after a committed snapshot pull', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 3,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toBeDefined()

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState().revalidationProgress).toBeUndefined()
      })
    })

    it('keeps progress from a newer install when a settle pull lands late', async () => {
      let stateCall = 0
      const { runtime, serviceWorker } = createControlledKernel({
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            stateCall += 1
            const releaseId = stateCall === 1 ? 'release-a' : 'release-b'
            return Response.json(
              { localEdgeEnabled: true, mode: 'active', release: { releaseId } },
              { headers: fwaKernelStateHeaders() },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            return Response.json({
              localEdgeEnabled: true,
              release: { releaseId: 'release-a' },
              status: 'current',
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await settle(runtime)

      // A new install of release-c starts (and broadcasts progress) while
      // the terminal pull for the older release-b is still in flight.
      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-c',
            completedAssets: 3,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        releaseId: 'release-c',
      })

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationCommittedMessageType,
            releaseId: 'release-b',
          },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState().updateAvailable).toBe(true)
      })

      // The settled release-b pull must not drop release-c's live progress.
      expect(runtime.getState().revalidationProgress).toMatchObject({
        releaseId: 'release-c',
        completedAssets: 3,
      })
    })

    it('resolves revalidate with the announcement already visible', async () => {
      const { runtime } = createControlledKernel({
        revalidationReleaseId: 'release-b',
        revalidationStatus: 'updated',
      })
      await settle(runtime)

      await runtime.revalidate()

      // No waitFor: the public promise resolves only after the ordered
      // announcement pull has published.
      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        availableReleaseId: 'release-b',
        updateAvailable: true,
        revalidating: false,
      })
    })

    it('does not let a slow startup read overwrite a newer commit observation', async () => {
      let stateCall = 0
      const { runtime, serviceWorker } = createControlledKernel({
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            stateCall += 1
            const headers = new Headers(fwaKernelStateHeaders())
            if (stateCall === 1) {
              // A commit lands while the startup read is still in flight.
              serviceWorker.dispatchEvent(
                kernelMessage(
                  {
                    type: fwaRevalidationCommittedMessageType,
                    releaseId: 'release-b',
                  },
                  controllerSource(serviceWorker),
                ),
              )
              await new Promise((resolve) => setTimeout(resolve, 30))
              // The startup read resolves with the pre-commit kernel state.
              return Response.json(
                {
                  localEdgeEnabled: true,
                  mode: 'active',
                  release: { releaseId: 'release-a' },
                },
                { headers },
              )
            }
            return Response.json(
              {
                localEdgeEnabled: true,
                mode: 'active',
                release: { releaseId: 'release-b' },
              },
              { headers },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            return Response.json({
              localEdgeEnabled: true,
              release: { releaseId: 'release-a' },
              status: 'current',
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await settle(runtime)

      // The terminal pull runs after the startup read on the ordered chain,
      // so its newer observation survives the older startup snapshot.
      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        availableReleaseId: 'release-b',
        updateAvailable: true,
      })
    })

    it('does not let a delayed silent install response overwrite a newer cross-tab commit', async () => {
      const fakeScheduler = createFakeScheduler()
      let stateCall = 0
      let revalidateCall = 0
      let resolveRevalidate: ((response: Response) => void) | undefined
      const { runtime, serviceWorker } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        updateCheck: { intervalMinutes: 5 },
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            stateCall += 1
            const headers = new Headers(fwaKernelStateHeaders())
            if (stateCall === 1) {
              return Response.json(
                { localEdgeEnabled: true, mode: 'network-only' },
                { headers },
              )
            }
            return Response.json(
              {
                localEdgeEnabled: true,
                mode: 'active',
                release: { releaseId: 'release-c' },
              },
              { headers },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            revalidateCall += 1
            if (revalidateCall === 1) {
              return Response.json({
                localEdgeEnabled: true,
                release: { releaseId: undefined },
                status: 'current',
              })
            }
            // The background tab's silent first-install response stays
            // pending while the other tab commits.
            return new Promise<Response>((resolve) => {
              resolveRevalidate = resolve
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await vi.waitFor(() => {
        expect(runtime.getState().phase).toBe('network-only')
      })

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(resolveRevalidate).toBeDefined()
      })

      // Another tab commits release-c while this document's response is
      // still pending; the terminal pull claims release-c for this tab.
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-c' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState().releaseId).toBe('release-c')
      })

      // The delayed response claims release-b: its first-install claim must
      // derive from a fresh ordered snapshot read, not overwrite release-c.
      resolveRevalidate?.(
        Response.json({
          localEdgeEnabled: true,
          release: { releaseId: 'release-b' },
          status: 'installed',
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-c',
        updateAvailable: false,
      })
    })

    it('accepts a same-release retry after a terminal event resets the baseline', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)

      // The first attempt of release-b reaches 7 assets and then fails.
      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 7,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        completedAssets: 7,
      })

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationFailedMessageType, releaseId: 'release-b' },
          controllerSource(serviceWorker),
        ),
      )

      // The retry starts from zero: its first count must be accepted
      // synchronously, before the terminal pull resolves.
      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 1,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        completedAssets: 1,
      })
    })

    it('isolates the nested progress object from consumer mutations', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 3,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      const exposed = runtime.getState()
      ;(exposed.revalidationProgress as { completedAssets: number }).completedAssets = 99

      // The runtime's own baseline is unaffected by the consumer's mutation,
      // so the monotonic guard still accepts fresh counts.
      expect(runtime.getState().revalidationProgress).toMatchObject({
        completedAssets: 3,
      })
      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 4,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        completedAssets: 4,
      })
    })

    it('keeps a document-owned revalidate flag when a settle pull lands mid-revalidate', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({
        scheduledResponse: new Promise<Response>(() => {}),
      })
      await settle(runtime)
      await vi.waitFor(() => {
        expect(runtime.getState().revalidating).toBe(false)
      })

      void runtime.revalidate()
      await vi.waitFor(() => {
        expect(runtime.getState().revalidating).toBe(true)
      })

      const stateFetchCallsBefore = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === '/__fwa/state',
      ).length
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-a' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter((call) => String(call[0]) === '/__fwa/state')
            .length,
        ).toBeGreaterThan(stateFetchCallsBefore)
      })

      expect(runtime.getState().updateAvailable).toBe(false)
      expect(runtime.getState().revalidating).toBe(true)
    })

    it('ignores an out-of-order progress broadcast that would regress the count', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 5,
            totalAssets: 10,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        releaseId: 'release-b',
        completedAssets: 5,
        totalAssets: 10,
      })

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 2,
            totalAssets: 10,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toMatchObject({
        releaseId: 'release-b',
        completedAssets: 5,
        totalAssets: 10,
      })
    })

    it('lets a newer terminal message overwrite an older settle pull result', async () => {
      let stateCall = 0
      const customFetch = async (input: RequestInfo | URL) => {
        const requestUrl = String(input)
        if (requestUrl === '/__fwa/state') {
          stateCall += 1
          const headers = new Headers(fwaKernelStateHeaders())
          if (stateCall === 1) {
            return Response.json(
              { localEdgeEnabled: true, mode: 'active', release: { releaseId: 'release-a' } },
              { headers },
            )
          }
          if (stateCall === 2) {
            // The first settle pull is slow; without serialization its result
            // would land after the second pull's and overwrite it.
            await new Promise((resolve) => setTimeout(resolve, 30))
            return Response.json(
              { localEdgeEnabled: true, mode: 'active', release: { releaseId: 'release-b' } },
              { headers },
            )
          }
          return Response.json(
            { localEdgeEnabled: true, mode: 'active', release: { releaseId: 'release-c' } },
            { headers },
          )
        }
        if (requestUrl === '/__fwa/revalidate') {
          return Response.json({
            localEdgeEnabled: true,
            release: { releaseId: 'release-a' },
            status: 'current',
          })
        }
        throw new Error(`unexpected fetch: ${requestUrl}`)
      }
      const { runtime, serviceWorker } = createControlledKernel({
        fetch: customFetch,
      })
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'ready',
          releaseId: 'release-a',
        })
      })

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-b' },
          controllerSource(serviceWorker),
        ),
      )
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-c' },
          controllerSource(serviceWorker),
        ),
      )

      await vi.waitFor(() => {
        expect(runtime.getState().availableReleaseId).toBe('release-c')
      })
      // Well past the delayed pull's landing time: the older settle result
      // must not have overwritten the newer one.
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(runtime.getState().availableReleaseId).toBe('release-c')
    })

    it('keeps an explicitly network-opened document on the network baseline when a commit settles', async () => {
      const { runtime, serviceWorker } = createControlledKernel({
        documentHref: 'https://app.example/?__fwa=network',
      })
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'network-only',
          controlled: true,
        })
      })
      expect(runtime.getState().releaseId).toBeUndefined()

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 1,
            totalAssets: 4,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState()).toMatchObject({
        phase: 'network-only',
        revalidationProgress: {
          releaseId: 'release-b',
          completedAssets: 1,
          totalAssets: 4,
        },
      })

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-b' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'network-only',
          controlled: true,
          revalidating: false,
          updateAvailable: false,
          message: '当前页面经显式 network open 进入，不重新注册 Local Edge。',
        })
      })
      expect(runtime.getState().releaseId).toBeUndefined()
      expect(runtime.getState().availableReleaseId).toBeUndefined()
      expect(runtime.getState().revalidationProgress).toBeUndefined()
    })

    it('still pulls for an ordinary network-only document that is not an explicit network open', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({
        snapshotMode: 'disabled',
      })
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'network-only',
          controlled: true,
        })
      })

      const fetchCallsBefore = fetchMock.mock.calls.length
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-b' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchCallsBefore)
      })
      expect(runtime.getState()).toMatchObject({
        phase: 'network-only',
        controlled: true,
      })
    })

    it('drops progress and re-pulls the snapshot after a failed install message', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({})
      await settle(runtime)

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 2,
            totalAssets: 6,
          },
          controllerSource(serviceWorker),
        ),
      )
      expect(runtime.getState().revalidationProgress).toBeDefined()

      const fetchCallsBefore = fetchMock.mock.calls.length
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationFailedMessageType, releaseId: 'release-b' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState().revalidationProgress).toBeUndefined()
      })
      expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchCallsBefore)
      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        revalidating: false,
        updateAvailable: false,
      })
    })

    it('does not let a stale revalidate response overwrite a newer cross-tab commit', async () => {
      let stateCall = 0
      let revalidateCall = 0
      let resolveRevalidate: ((response: Response) => void) | undefined
      const { runtime, serviceWorker } = createControlledKernel({
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            stateCall += 1
            const releaseId = stateCall === 1 ? 'release-a' : 'release-c'
            return Response.json(
              { localEdgeEnabled: true, mode: 'active', release: { releaseId } },
              { headers: fwaKernelStateHeaders() },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            revalidateCall += 1
            if (revalidateCall === 1) {
              return Response.json({
                localEdgeEnabled: true,
                release: { releaseId: 'release-a' },
                status: 'current',
              })
            }
            // This document's revalidation response stays pending while the
            // other tab commits.
            return new Promise<Response>((resolve) => {
              resolveRevalidate = resolve
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await settle(runtime)

      void runtime.revalidate()
      await vi.waitFor(() => {
        expect(runtime.getState().revalidating).toBe(true)
      })

      // Another tab commits release-c while this document's response is pending.
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType, releaseId: 'release-c' },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(runtime.getState().availableReleaseId).toBe('release-c')
      })

      // The stale response claims release-b: its announcement must not
      // regress the newer cross-tab observation.
      resolveRevalidate?.(
        Response.json({
          localEdgeEnabled: true,
          release: { releaseId: 'release-b' },
          status: 'updated',
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(runtime.getState().availableReleaseId).toBe('release-c')
      expect(runtime.getState().revalidating).toBe(false)
    })

    it('keeps an announced available update when the committed pull sees the same active release', async () => {
      let announcedActive = 'release-a'
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({
        revalidationReleaseId: 'release-b',
        revalidationStatus: 'updated',
        fetch: async (input) => {
          const requestUrl = String(input)
          if (requestUrl === '/__fwa/state') {
            return Response.json(
              {
                localEdgeEnabled: true,
                mode: 'active',
                release: { releaseId: announcedActive },
              },
              { headers: fwaKernelStateHeaders() },
            )
          }
          if (requestUrl === '/__fwa/revalidate') {
            // The committed install becomes the kernel's active release.
            announcedActive = 'release-b'
            return Response.json({
              localEdgeEnabled: true,
              release: { releaseId: 'release-b' },
              status: 'updated',
            })
          }
          throw new Error(`unexpected fetch: ${requestUrl}`)
        },
      })
      await settle(runtime)
      // The document's own visible revalidate announces the update through a
      // fresh kernel pull.
      const outcome = runtime.revalidate()
      await outcome
      await vi.waitFor(() => {
        expect(runtime.getState()).toMatchObject({
          phase: 'ready',
          releaseId: 'release-a',
          availableReleaseId: 'release-b',
          updateAvailable: true,
        })
      })

      // The kernel commit broadcast pulls a snapshot whose active release is the
      // one it just committed (release-b). The loader keeps the announcement.
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType },
          controllerSource(serviceWorker),
        ),
      )
      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/state',
          ),
        ).toHaveLength(3)
      })

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        availableReleaseId: 'release-b',
        updateAvailable: true,
      })
    })

    it('publishes revalidationProgress from a matching progress message', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)
      expect(runtime.getState().revalidationProgress).toBeUndefined()

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 3,
            totalAssets: 12,
          },
          controllerSource(serviceWorker),
        ),
      )

      expect(runtime.getState()).toMatchObject({
        phase: 'ready',
        releaseId: 'release-a',
        revalidationProgress: {
          releaseId: 'release-b',
          completedAssets: 3,
          totalAssets: 12,
        },
      })
      expect(runtime.getState().revalidating).toBe(false)
    })

    it('pulls and publishes the snapshot after a committed message', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({})
      await settle(runtime)
      const stateFetchesBefore = fetchMock.mock.calls.filter(
        ([input]) => String(input) === '/__fwa/state',
      ).length

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType },
          controllerSource(serviceWorker),
        ),
      )

      await vi.waitFor(() => {
        expect(
          fetchMock.mock.calls.filter(
            ([input]) => String(input) === '/__fwa/state',
          ),
        ).toHaveLength(stateFetchesBefore + 1)
      })
    })

    it('ignores messages from a worker that is not the current controller', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({})
      await settle(runtime)
      const stateFetchesBefore = fetchMock.mock.calls.filter(
        ([input]) => String(input) === '/__fwa/state',
      ).length
      const foreignWorker = { scriptURL: 'https://app.example/other-sw.js' }

      serviceWorker.dispatchEvent(
        kernelMessage(
          {
            type: fwaRevalidationProgressMessageType,
            releaseId: 'release-b',
            completedAssets: 3,
            totalAssets: 12,
          },
          foreignWorker,
        ),
      )
      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType },
          foreignWorker,
        ),
      )

      expect(runtime.getState().revalidationProgress).toBeUndefined()
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/state',
        ),
      ).toHaveLength(stateFetchesBefore)
    })

    it('ignores malformed progress messages', async () => {
      const { runtime, serviceWorker } = createControlledKernel({})
      await settle(runtime)

      for (const data of [
        'not-an-object',
        { type: '__fwa:unknown' },
        {
          type: fwaRevalidationProgressMessageType,
          releaseId: 'release-b',
          completedAssets: '3',
          totalAssets: 12,
        },
        {
          type: fwaRevalidationProgressMessageType,
          releaseId: 'release-b',
          completedAssets: 13,
          totalAssets: 12,
        },
      ]) {
        serviceWorker.dispatchEvent(
          kernelMessage(data, controllerSource(serviceWorker)),
        )
      }

      expect(runtime.getState().revalidationProgress).toBeUndefined()
    })

    it('removes the message listener when stopped', async () => {
      const { runtime, serviceWorker, fetchMock } = createControlledKernel({})
      await settle(runtime)
      runtime.stop()
      const stateFetchesBefore = fetchMock.mock.calls.filter(
        ([input]) => String(input) === '/__fwa/state',
      ).length

      serviceWorker.dispatchEvent(
        kernelMessage(
          { type: fwaRevalidationCommittedMessageType },
          controllerSource(serviceWorker),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === '/__fwa/state',
        ),
      ).toHaveLength(stateFetchesBefore)
    })
  })
})
