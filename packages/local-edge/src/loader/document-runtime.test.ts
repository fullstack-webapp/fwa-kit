import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fwaKernelProtocolHeaderName,
  fwaKernelProtocolVersion,
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
  updateCheck?: {
    enabled?: boolean
    intervalMinutes?: number
  }
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
    updateCheck,
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
            ? { release: { releaseId: 'release-a' } }
            : undefined),
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
      href: 'https://app.example/',
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
      const beforeMessage = runtime.getState().message

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
        message: beforeMessage,
      })
      expect(reload).not.toHaveBeenCalled()
    })

    it('does not claim a network-only document became ready after prefetch', async () => {
      const fakeScheduler = createFakeScheduler()
      const { runtime } = createControlledKernel({
        scheduler: fakeScheduler.scheduler,
        snapshotMode: 'disabled',
        updateCheck: { intervalMinutes: 5 },
        revalidationReleaseId: 'release-b',
        revalidationStatus: 'updated',
      })
      await vi.waitFor(() => {
        expect(runtime.getState().phase).toBe('network-only')
      })
      const beforeMessage = runtime.getState().message

      fakeScheduler.elapse(updateCheckIntervalMs)
      fakeScheduler.triggerVisible()
      await vi.waitFor(() => {
        expect(runtime.getState().updateAvailable).toBe(true)
      })

      expect(runtime.getState()).toMatchObject({
        phase: 'network-only',
        controlled: true,
        availableReleaseId: 'release-b',
        updateAvailable: true,
        message: beforeMessage,
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
})
