import {
  type NavigationConfig,
  type LocalEdgeControlPaths,
  localEdgeNavigationModeFor,
} from './config-contract.ts'

export type RouteClass =
  | 'reserved-control'
  | 'navigation'
  | 'release-asset'
  | 'app-request'
  | 'network'

export type RouteStrategy =
  | 'kernel-response'
  | 'active-release'
  | 'http-network'
  | 'browser-network'
  | 'redirect'

export type NavigationDisposition =
  | 'app-route'
  | 'app-not-found'
  | 'network-not-found'
  | 'redirect'

export interface RoutePolicy {
  scopeOrigin: string
  controlPaths: LocalEdgeControlPaths
  appEntryPath: string
  releaseAssetPaths: readonly string[]
  appRequestPrefixes: readonly string[]
  navigation: NavigationConfig
}

export interface FetchInterceptionPolicy {
  scopeOrigin: string
  controlPaths: LocalEdgeControlPaths
  appRequestPrefixes: readonly string[]
  loaderPath: string
  releaseAssetPrefixes: readonly string[]
  supplementalAssetPaths: readonly string[]
  navigation: NavigationConfig
}

export interface RouteDecision {
  routeClass: RouteClass
  strategy: RouteStrategy
  fallback?: 'browser-network'
  navigationDisposition?: NavigationDisposition
  redirectTo?: string
  reason: string
}

export function shouldInterceptFetch(
  request: Request,
  policy: FetchInterceptionPolicy,
): boolean {
  const requestUrl = new URL(request.url)
  if (requestUrl.origin !== policy.scopeOrigin) return false

  if (Object.values(policy.controlPaths).includes(requestUrl.pathname)) {
    return true
  }

  const navigationMode = localEdgeNavigationModeFor(requestUrl)
  if (
    navigationMode === 'reset' &&
    (request.mode === 'navigate' || request.method === 'POST')
  ) {
    return true
  }
  if (navigationMode === 'network' && request.mode === 'navigate') {
    return true
  }

  if (
    policy.appRequestPrefixes.some((prefix) =>
      requestUrl.pathname.startsWith(prefix),
    )
  ) {
    return false
  }

  if (
    request.method === 'GET' &&
    (requestUrl.pathname === policy.loaderPath ||
      policy.supplementalAssetPaths.includes(requestUrl.pathname) ||
      policy.releaseAssetPrefixes.some((prefix) =>
        requestUrl.pathname.startsWith(prefix),
      ))
  ) {
    return true
  }

  if (request.method !== 'GET' || request.mode !== 'navigate') {
    return false
  }

  return (
    classifyNavigationPath(requestUrl.pathname, policy.navigation)
      .disposition !== 'network-not-found'
  )
}

export function classifyRequest(
  request: Request,
  policy: RoutePolicy,
): RouteDecision {
  const requestUrl = new URL(request.url)

  if (requestUrl.origin !== policy.scopeOrigin) {
    return {
      routeClass: 'network',
      strategy: 'browser-network',
      reason: 'cross-origin requests keep browser network semantics',
    }
  }

  const reservedStrategy = Object.values(policy.controlPaths).includes(
    requestUrl.pathname,
  )
    ? 'kernel-response'
    : undefined
  if (reservedStrategy) {
    return {
      routeClass: 'reserved-control',
      strategy: reservedStrategy,
      reason: 'reserved controls take precedence over app routing',
    }
  }

  if (
    policy.appRequestPrefixes.some((prefix) =>
      requestUrl.pathname.startsWith(prefix),
    )
  ) {
    return {
      routeClass: 'app-request',
      strategy: 'http-network',
      reason: 'app-owned requests use the baseline HTTP adapter',
    }
  }

  if (
    request.method === 'GET' &&
    requestUrl.pathname !== policy.appEntryPath &&
    policy.releaseAssetPaths.includes(requestUrl.pathname)
  ) {
    return {
      routeClass: 'release-asset',
      strategy: 'active-release',
      reason: 'release assets resolve by exact manifest membership',
    }
  }

  if (request.method === 'GET' && request.mode === 'navigate') {
    const navigation = classifyNavigationPath(
      requestUrl.pathname,
      policy.navigation,
    )
    if (navigation.disposition === 'network-not-found') {
      return {
        routeClass: 'navigation',
        strategy: 'browser-network',
        navigationDisposition: navigation.disposition,
        reason: 'unknown navigation belongs to the network host',
      }
    }
    if (navigation.disposition === 'redirect') {
      return {
        routeClass: 'navigation',
        strategy: 'redirect',
        navigationDisposition: navigation.disposition,
        redirectTo: navigation.targetPath,
        reason: 'unknown navigation redirects to a declared app route',
      }
    }
    return {
      routeClass: 'navigation',
      strategy: 'active-release',
      fallback: 'browser-network',
      navigationDisposition: navigation.disposition,
      reason:
        navigation.disposition === 'app-route'
          ? 'declared app navigation prefers the committed release'
          : 'the SPA owns its not-found navigation',
    }
  }

  return {
    routeClass: 'network',
    strategy: 'browser-network',
    reason: 'unknown requests fail open to browser network behavior',
  }
}

export function classifyNavigationPath(
  pathname: string,
  policy: NavigationConfig,
):
  | { disposition: 'app-route' }
  | { disposition: 'app-not-found' }
  | { disposition: 'network-not-found' }
  | { disposition: 'redirect'; targetPath: string } {
  if (
    policy.appPaths.includes(pathname) ||
    policy.appPathPrefixes.some((prefix) => pathname.startsWith(prefix))
  ) {
    return { disposition: 'app-route' }
  }

  if (policy.notFound.strategy === 'redirect') {
    return {
      disposition: 'redirect',
      targetPath: policy.notFound.targetPath,
    }
  }
  return {
    disposition:
      policy.notFound.strategy === 'app-entry'
        ? 'app-not-found'
        : 'network-not-found',
  }
}
