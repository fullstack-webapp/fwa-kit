import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalEdgeDocumentRuntime } from './document-runtime.ts'

const workerPath = '/__fwa-sw.js'
const workerUrl = `https://app.example${workerPath}`

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
            { headers: { 'X-FWA-Kernel': workerPath } },
          )
        }
        throw new Error(`unexpected fetch: ${requestUrl}`)
      }),
    )

    const runtime = createLocalEdgeDocumentRuntime(
      { scopePath: '/', workerPath, controlPrefix: '/__fwa' },
      {
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
      },
    )
    const ready = new Promise<void>((resolve) => {
      runtime.subscribe((state) => {
        if (state.phase === 'ready') resolve()
      })
    })

    runtime.start()
    await ready

    expect(runtime.getState()).toMatchObject({
      controlled: true,
      phase: 'ready',
      releaseId: 'release-a',
    })
    expect(reload).not.toHaveBeenCalled()
  })
})
