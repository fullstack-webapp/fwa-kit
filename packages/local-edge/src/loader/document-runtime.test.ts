import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fwaKernelProtocolHeaderName,
  fwaKernelProtocolVersion,
} from '../config-contract.ts'
import { createLocalEdgeDocumentRuntime } from './document-runtime.ts'

const workerPath = '/__fwa-sw.js'
const workerUrl = `https://app.example${workerPath}`
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

function stubControlledKernel(protocolVersion?: string) {
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

  vi.stubGlobal('window', {
    location: {
      href: 'https://app.example/',
      origin: 'https://app.example',
      reload,
    },
  })
  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = String(input)
      if (requestUrl === '/__fwa/state') {
        const headers = new Headers({ 'X-FWA-Kernel': workerPath })
        if (protocolVersion !== undefined) {
          headers.set(fwaKernelProtocolHeaderName, protocolVersion)
        }
        return Response.json(
          {
            localEdgeEnabled: true,
            mode: 'active',
            release: { releaseId: 'release-a' },
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
    }),
  )

  return { reload, replaceServiceWorker }
}

describe('createLocalEdgeDocumentRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('continues first install without a reload when the worker claims the document', async () => {
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

    vi.stubGlobal('window', {
      location: {
        href: 'https://app.example/',
        origin: 'https://app.example',
        reload,
      },
    })
    vi.stubGlobal('navigator', { serviceWorker })
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
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
      }),
    )

    const runtime = createLocalEdgeDocumentRuntime(documentConfig, {
      async registerServiceWorker() {
        queueMicrotask(() => {
          serviceWorker.controller = controller
          serviceWorker.dispatchEvent(new Event('controllerchange'))
        })
        return registration
      },
      async replaceServiceWorker() {
        throw new Error('legacy takeover is not expected')
      },
    })
    runtime.start()
    await waitForPhase(runtime, 'ready')

    expect(runtime.getState()).toMatchObject({
      controlled: true,
      phase: 'ready',
      releaseId: 'release-a',
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it('accepts a controlled worker that matches the kernel protocol identity', async () => {
    const { reload, replaceServiceWorker } = stubControlledKernel(
      String(fwaKernelProtocolVersion),
    )
    const runtime = createLocalEdgeDocumentRuntime(documentConfig, {
      async registerServiceWorker() {
        throw new Error('registration is not expected')
      },
      replaceServiceWorker,
    })

    runtime.start()
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
    ['missing', undefined],
    ['mismatched', String(fwaKernelProtocolVersion - 1)],
  ])(
    'routes a controlled worker with a %s protocol identity through one guarded takeover',
    async (_case, protocolVersion) => {
      const { reload, replaceServiceWorker } =
        stubControlledKernel(protocolVersion)
      const registrationOwner = {
        async registerServiceWorker() {
          throw new Error('registration is not expected')
        },
        replaceServiceWorker,
      }
      const runtime = createLocalEdgeDocumentRuntime(
        documentConfig,
        registrationOwner,
      )

      runtime.start()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))

      const repeatedRuntime = createLocalEdgeDocumentRuntime(
        documentConfig,
        registrationOwner,
      )
      repeatedRuntime.start()
      await waitForPhase(repeatedRuntime, 'error')

      expect(replaceServiceWorker).toHaveBeenCalledTimes(1)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(repeatedRuntime.getState().message).toContain(
        'still unavailable after Service Worker takeover',
      )
    },
  )
})
