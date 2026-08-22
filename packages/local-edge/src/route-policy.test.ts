import { describe, expect, it } from 'vitest'
import { localEdgeControlPathsFor } from './config-contract.ts'
import {
  classifyRequest,
  shouldInterceptFetch,
  type FetchInterceptionPolicy,
  type RoutePolicy,
} from './route-policy.ts'

const scopeOrigin = 'https://local-edge.example'

const policy: RoutePolicy = {
  scopeOrigin,
  controlPaths: localEdgeControlPathsFor({
    appId: 'route-test',
    localEdgeEnabled: true,
    scopePath: '/',
    workerPath: '/worker.js',
    descriptorPath: '/release.json',
    controlPrefix: '/__fwa',
    appEntry: '/',
    appRequestPrefixes: ['/api/'],
    supplementalAssetPaths: ['/favicon.svg'],
    navigation: {
      appPaths: ['/', '/library/'],
      appPathPrefixes: ['/library/'],
      notFound: { strategy: 'app-entry' },
    },
  }),
  appEntryPath: '/',
  releaseAssetPaths: ['/assets/app.js'],
  appRequestPrefixes: ['/api/'],
  navigation: {
    appPaths: ['/', '/library/'],
    appPathPrefixes: ['/library/'],
    notFound: { strategy: 'app-entry' },
  },
}

const interceptionPolicy: FetchInterceptionPolicy = {
  scopeOrigin,
  controlPaths: policy.controlPaths,
  appRequestPrefixes: ['/api/'],
  loaderPath: '/__fwa/loader.js',
  releaseAssetPrefixes: ['/assets/'],
  supplementalAssetPaths: ['/favicon.svg'],
  navigation: {
    ...policy.navigation,
    notFound: { strategy: 'network' },
  },
}

function createRequest(
  path: string,
  options: {
    method?: string
    mode?: RequestMode
    origin?: string
  } = {},
) {
  const request = new Request(`${options.origin ?? scopeOrigin}${path}`, {
    method: options.method,
  })

  if (options.mode) {
    Object.defineProperty(request, 'mode', { value: options.mode })
  }

  return request
}

describe('classifyRequest', () => {
  it('keeps reserved controls ahead of app request prefixes', () => {
    for (const controlPath of ['/__fwa/state', '/__fwa/revalidate']) {
      const decision = classifyRequest(createRequest(controlPath), {
        ...policy,
        appRequestPrefixes: ['/'],
      })

      expect(decision).toMatchObject({
        routeClass: 'reserved-control',
        strategy: 'kernel-response',
      })
    }
  })

  it('prefers active release for navigation with a network fallback', () => {
    expect(
      classifyRequest(createRequest('/library/', { mode: 'navigate' }), policy),
    ).toMatchObject({
      routeClass: 'navigation',
      strategy: 'active-release',
      fallback: 'browser-network',
      navigationDisposition: 'app-route',
    })
  })

  it('requires exact manifest membership for release assets', () => {
    expect(
      classifyRequest(createRequest('/assets/app.js'), policy),
    ).toMatchObject({
      routeClass: 'release-asset',
      strategy: 'active-release',
    })

    expect(
      classifyRequest(createRequest('/assets/app.js.map'), policy),
    ).toMatchObject({
      routeClass: 'network',
      strategy: 'browser-network',
    })

    expect(
      classifyRequest(
        createRequest('/assets/app.js', { mode: 'navigate' }),
        policy,
      ),
    ).toMatchObject({
      routeClass: 'release-asset',
      strategy: 'active-release',
    })
  })

  it('sends app requests through the baseline HTTP adapter', () => {
    expect(
      classifyRequest(createRequest('/api/memos', { method: 'POST' }), policy),
    ).toMatchObject({
      routeClass: 'app-request',
      strategy: 'http-network',
    })
    expect(
      classifyRequest(createRequest('/api/memos', { mode: 'navigate' }), policy),
    ).toMatchObject({
      routeClass: 'app-request',
      strategy: 'http-network',
    })
  })

  it('makes SPA and host not-found ownership explicit', () => {
    expect(
      classifyRequest(createRequest('/missing', { mode: 'navigate' }), policy),
    ).toMatchObject({
      strategy: 'active-release',
      navigationDisposition: 'app-not-found',
    })

    expect(
      classifyRequest(createRequest('/missing', { mode: 'navigate' }), {
        ...policy,
        navigation: {
          ...policy.navigation,
          notFound: { strategy: 'network' },
        },
      }),
    ).toMatchObject({
      strategy: 'browser-network',
      navigationDisposition: 'network-not-found',
    })
  })

  it('redirects unknown navigation only to a declared app route', () => {
    expect(
      classifyRequest(createRequest('/legacy', { mode: 'navigate' }), {
        ...policy,
        navigation: {
          ...policy.navigation,
          notFound: { strategy: 'redirect', targetPath: '/' },
        },
      }),
    ).toMatchObject({
      strategy: 'redirect',
      navigationDisposition: 'redirect',
      redirectTo: '/',
    })
  })

  it('preserves browser semantics for cross-origin and unknown requests', () => {
    const crossOrigin = classifyRequest(
      createRequest('/widget.js', { origin: 'https://cdn.example' }),
      policy,
    )
    const unknown = classifyRequest(createRequest('/robots.txt'), policy)

    expect(crossOrigin.routeClass).toBe('network')
    expect(unknown).toMatchObject({
      routeClass: 'network',
      strategy: 'browser-network',
    })
  })
})

describe('shouldInterceptFetch', () => {
  it('intercepts only explicit controls, release asset namespaces, and app navigation', () => {
    for (const request of [
      createRequest('/__fwa/state'),
      createRequest('/__fwa/revalidate', { method: 'POST' }),
      createRequest('/__fwa/loader.js'),
      createRequest('/assets/app.js'),
      createRequest('/favicon.svg'),
      createRequest('/library/', { mode: 'navigate' }),
      createRequest('/library/?__fwa=reset', { mode: 'navigate' }),
      createRequest('/library/?__fwa=network', { mode: 'navigate' }),
    ]) {
      expect(shouldInterceptFetch(request, interceptionPolicy)).toBe(true)
    }
  })

  it('does not call respondWith territory for unknown, API, auth probe, or cross-origin paths', () => {
    for (const request of [
      createRequest('/missing', { mode: 'navigate' }),
      createRequest('/api/memos'),
      createRequest('/__fwa/auth-probe.txt'),
      createRequest('/robots.txt'),
      createRequest('/assets/upload', { method: 'POST' }),
      createRequest('/widget.js', { origin: 'https://cdn.example' }),
    ]) {
      expect(shouldInterceptFetch(request, interceptionPolicy)).toBe(false)
    }
  })

  it('allows an explicit app-entry not-found policy to opt into all navigation', () => {
    expect(
      shouldInterceptFetch(createRequest('/missing', { mode: 'navigate' }), {
        ...interceptionPolicy,
        navigation: {
          ...interceptionPolicy.navigation,
          notFound: { strategy: 'app-entry' },
        },
      }),
    ).toBe(true)
  })
})
