import { localEdgeConfig } from '../config.ts'
import { fwaTakeoverMessageType } from '../config-contract.ts'
import {
  activateLocalEdgeKernel,
  handleLocalEdgeFetch,
  shouldHandleLocalEdgeFetch,
} from './local-edge-worker.ts'

const worker = self as unknown as ServiceWorkerGlobalScope
const hostPingPath = `${localEdgeConfig.controlPrefix}/host-ping`

worker.addEventListener('message', (event) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    (event.data as { type?: unknown }).type === fwaTakeoverMessageType
  ) {
    event.waitUntil(worker.skipWaiting())
  }
})

worker.addEventListener('activate', (event) => {
  event.waitUntil(activateLocalEdgeKernel())
})

worker.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url)
  if (
    requestUrl.origin === worker.location.origin &&
    requestUrl.pathname === hostPingPath
  ) {
    event.respondWith(
      Response.json(
        { host: 'reference-worker', kernelComposed: true },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    )
    return
  }

  if (!shouldHandleLocalEdgeFetch(event.request)) return
  event.respondWith(handleLocalEdgeFetch(event))
})
