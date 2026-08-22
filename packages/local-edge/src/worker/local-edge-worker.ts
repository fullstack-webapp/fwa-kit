import { releaseAssetPaths } from '../release.ts'
import {
  fwaKernelProbeHeaderName,
  loaderPathFor,
  pathWithLocalEdgeNavigationMode,
  localEdgeConfig,
  localEdgeControlPaths,
  localEdgeNavigationModeFor,
} from '../config.ts'
import { classifyRequest, shouldInterceptFetch } from '../route-policy.ts'
import {
  isTrustedProgrammaticControlPost,
  isTrustedResetPost,
  networkEntryOrFallback,
  recoverUnhandledRequest,
  resetConfirmationResponse,
} from './kernel-recovery.ts'
import {
  activateReleaseRuntime,
  getLocalEdgeSnapshot,
  isReleaseComplete,
  isLocalEdgeRuntimeEnabled,
  pinRequestClient,
  readReleaseAsset,
  resetReleaseRuntime,
  revalidateReleaseForClient,
  selectRequestRelease,
} from './release-runtime.ts'
import { cloneReplaySafeRequest } from './request-recovery.ts'

const worker = self as unknown as ServiceWorkerGlobalScope

export async function activateLocalEdgeKernel() {
  await activateReleaseRuntime()
  await worker.clients.claim()
}

export function handleLocalEdgeFetch(event: FetchEvent) {
  const recoveryRequest = cloneReplaySafeRequest(event.request)

  return handleRequest(event).catch(() =>
    recoveryRequest ? recoverUnhandledRequest(recoveryRequest) : Response.error(),
  )
}

export function shouldHandleLocalEdgeFetch(request: Request) {
  return shouldInterceptFetch(request, {
    scopeOrigin: worker.location.origin,
    controlPaths: localEdgeControlPaths,
    appRequestPrefixes: localEdgeConfig.appRequestPrefixes,
    loaderPath: loaderPathFor(localEdgeConfig),
    releaseAssetPrefixes: localEdgeConfig.releaseAssetPrefixes,
    supplementalAssetPaths: localEdgeConfig.supplementalAssetPaths,
    navigation: localEdgeConfig.navigation,
  })
}

async function handleRequest(event: FetchEvent) {
  const request = event.request
  const requestUrl = new URL(request.url)

  if (requestUrl.origin !== worker.location.origin) {
    return fetch(request)
  }
  if (requestUrl.pathname === localEdgeControlPaths.state) {
    return stateResponse(request)
  }
  if (requestUrl.pathname === localEdgeControlPaths.revalidate) {
    return revalidationResponse(event)
  }
  const navigationMode = localEdgeNavigationModeFor(requestUrl)
  if (
    navigationMode === 'reset' &&
    (request.mode === 'navigate' || request.method === 'POST')
  ) {
    return resetResponse(request, requestUrl)
  }
  if (navigationMode === 'network' && request.mode === 'navigate') {
    return fetch(request, { cache: 'reload' })
  }

  if (await usesNetworkOnlyClient(event.clientId)) {
    return fetch(request)
  }
  if (!(await isLocalEdgeRuntimeEnabled())) {
    return fetch(request)
  }

  const release = await selectRequestRelease(event)
  const decision = classifyRequest(request, {
    scopeOrigin: worker.location.origin,
    controlPaths: localEdgeControlPaths,
    appEntryPath: localEdgeConfig.appEntry,
    releaseAssetPaths: release ? releaseAssetPaths(release) : [],
    appRequestPrefixes: localEdgeConfig.appRequestPrefixes,
    navigation: localEdgeConfig.navigation,
  })

  if (decision.strategy === 'redirect' && decision.redirectTo) {
    return Response.redirect(
      new URL(decision.redirectTo, requestUrl.origin).href,
      302,
    )
  }

  if (!release || decision.strategy === 'browser-network') {
    return fetch(request)
  }

  if (decision.strategy === 'http-network') {
    return fetch(request)
  }

  if (decision.strategy === 'active-release') {
    if (
      decision.routeClass === 'navigation' &&
      !(await isReleaseComplete(release))
    ) {
      return networkEntryOrFallback(request, 'release-incomplete')
    }

    const assetPath =
      decision.routeClass === 'navigation'
        ? release.appEntry
        : requestUrl.pathname
    const cachedResponse = await readReleaseAsset(release, assetPath)

    if (cachedResponse) {
      if (decision.routeClass === 'navigation') {
        await pinRequestClient(event, release.releaseId)
      }
      return cachedResponse
    }

    if (decision.fallback === 'browser-network') {
      return networkEntryOrFallback(request, 'release-entry-missing')
    }

    return new Response('Committed release asset is missing', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return fetch(request)
}

async function stateResponse(request: Request) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET' },
    })
  }

  return Response.json(await getLocalEdgeSnapshot(), {
    headers: {
      'Cache-Control': 'no-store',
      [fwaKernelProbeHeaderName]: localEdgeConfig.workerPath,
    },
  })
}

async function revalidationResponse(event: FetchEvent) {
  const request = event.request
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    })
  }

  if (!isTrustedProgrammaticControlPost(request, 'revalidate')) {
    return new Response('Forbidden', { status: 403 })
  }

  try {
    const result = await revalidateReleaseForClient(event.clientId)

    return Response.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'release revalidation failed',
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    )
  }
}

async function resetResponse(request: Request, requestUrl: URL) {
  if (request.method === 'GET') {
    return resetConfirmationResponse(requestUrl)
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, POST' },
    })
  }

  if (!isTrustedResetPost(request)) {
    return new Response('Forbidden', { status: 403 })
  }

  await resetReleaseRuntime()
  await worker.registration.unregister()

  const openUrl = pathWithLocalEdgeNavigationMode(requestUrl, 'network')
  if (request.mode === 'navigate') {
    return Response.redirect(new URL(openUrl, requestUrl.origin).href, 303)
  }

  return Response.json({ ok: true }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function usesNetworkOnlyClient(clientId: string) {
  if (!clientId) {
    return false
  }

  const client = await worker.clients.get(clientId)
  return client
    ? localEdgeNavigationModeFor(new URL(client.url)) === 'network'
    : false
}
