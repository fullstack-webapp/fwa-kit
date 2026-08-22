export interface LocalEdgeConfig {
  appId: string
  localEdgeEnabled: boolean
  scopePath: string
  workerPath: string
  descriptorPath: string
  controlPrefix: string
  appEntry: string
  appRequestPrefixes: readonly string[]
  releaseAssetPrefixes: readonly string[]
  supplementalAssetPaths: readonly string[]
  navigation: NavigationConfig
}

export interface NavigationConfig {
  appPaths: readonly string[]
  appPathPrefixes: readonly string[]
  notFound: NavigationNotFoundConfig
}

export type NavigationNotFoundConfig =
  | { strategy: 'app-entry' }
  | { strategy: 'network' }
  | { strategy: 'redirect'; targetPath: string }

export interface LocalEdgeControlPaths {
  revalidate: string
  state: string
}

export const localEdgeModeQueryParameter = '__fwa'
export const localEdgeDebugQueryParameter = '__fwa_debug'
export const fwaKernelProbeHeaderName = 'X-FWA-Kernel'
export const fwaTakeoverMessageType = '__fwa:takeover'
export type LocalEdgeNavigationMode = 'network' | 'reset'
export type LocalEdgeDebugSeed = 'enable' | 'disable' | 'reset'

export function loaderPathFor(
  config: Pick<LocalEdgeConfig, 'controlPrefix'>,
) {
  return `${config.controlPrefix}/loader.js`
}

export function defineLocalEdgeConfig(value: unknown): LocalEdgeConfig {
  if (!isRecord(value)) {
    throw new Error('FWA Local Edge config must be an object')
  }

  const {
    appId,
    localEdgeEnabled,
    scopePath,
    workerPath,
    descriptorPath,
    controlPrefix,
    appEntry,
    appRequestPrefixes,
    releaseAssetPrefixes,
    supplementalAssetPaths,
    navigation,
  } = value
  if (
    typeof appId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(appId) ||
    typeof localEdgeEnabled !== 'boolean' ||
    typeof scopePath !== 'string' ||
    !isCanonicalPath(scopePath) ||
    !scopePath.endsWith('/') ||
    typeof workerPath !== 'string' ||
    !isPathWithinScope(workerPath, scopePath) ||
    typeof descriptorPath !== 'string' ||
    !isPathWithinScope(descriptorPath, scopePath) ||
    typeof controlPrefix !== 'string' ||
    !isPathWithinScope(controlPrefix, scopePath) ||
    controlPrefix.endsWith('/') ||
    typeof appEntry !== 'string' ||
    !isPathWithinScope(appEntry, scopePath) ||
    !Array.isArray(appRequestPrefixes) ||
    !appRequestPrefixes.every(
      (prefix) =>
        typeof prefix === 'string' && isPathWithinScope(prefix, scopePath),
    ) ||
    !Array.isArray(releaseAssetPrefixes) ||
    !releaseAssetPrefixes.every(
      (prefix) =>
        typeof prefix === 'string' &&
        prefix.endsWith('/') &&
        prefix !== scopePath &&
        isPathWithinScope(prefix, scopePath) &&
        !isPathWithinNamespace(prefix, controlPrefix) &&
        !appRequestPrefixes.some(
          (appPrefix) =>
            prefix.startsWith(appPrefix) || appPrefix.startsWith(prefix),
        ),
    ) ||
    new Set(releaseAssetPrefixes).size !== releaseAssetPrefixes.length ||
    !Array.isArray(supplementalAssetPaths) ||
    !supplementalAssetPaths.every(
      (assetPath) =>
        typeof assetPath === 'string' &&
        isPathWithinScope(assetPath, scopePath) &&
        !assetPath.endsWith('/') &&
        assetPath !== workerPath &&
        assetPath !== descriptorPath &&
        assetPath !== appEntry &&
        !isPathWithinNamespace(assetPath, controlPrefix) &&
        !appRequestPrefixes.some((prefix) => assetPath.startsWith(prefix)),
    ) ||
    new Set(supplementalAssetPaths).size !== supplementalAssetPaths.length ||
    new Set([workerPath, descriptorPath, appEntry]).size !== 3 ||
    [workerPath, appEntry].some((path) =>
      isPathWithinNamespace(path, controlPrefix),
    )
  ) {
    throw new Error('FWA Local Edge config is invalid')
  }

  const parsedNavigation = parseNavigationConfig(navigation, {
    appEntry,
    controlPrefix,
    reservedPaths: [workerPath, descriptorPath],
    scopePath,
  })

  return {
    appId,
    localEdgeEnabled,
    scopePath,
    workerPath,
    descriptorPath,
    controlPrefix,
    appEntry,
    appRequestPrefixes: [...appRequestPrefixes],
    releaseAssetPrefixes: [...releaseAssetPrefixes],
    supplementalAssetPaths: [...supplementalAssetPaths],
    navigation: parsedNavigation,
  }
}

function parseNavigationConfig(
  value: unknown,
  context: {
    appEntry: string
    controlPrefix: string
    reservedPaths: readonly string[]
    scopePath: string
  },
): NavigationConfig {
  if (!isRecord(value)) {
    throw new Error('FWA Local Edge navigation config must be an object')
  }

  const { appPaths, appPathPrefixes, notFound } = value
  if (
    !Array.isArray(appPaths) ||
    !appPaths.every(
      (path) =>
        typeof path === 'string' &&
        isPathWithinScope(path, context.scopePath) &&
        !isPathWithinNamespace(path, context.controlPrefix),
    ) ||
    !appPaths.includes(context.appEntry) ||
    new Set(appPaths).size !== appPaths.length ||
    !Array.isArray(appPathPrefixes) ||
    !appPathPrefixes.every(
      (prefix) =>
        typeof prefix === 'string' &&
        prefix.endsWith('/') &&
        prefix !== context.scopePath &&
        isPathWithinScope(prefix, context.scopePath) &&
        !isPathWithinNamespace(prefix, context.controlPrefix),
    ) ||
    new Set(appPathPrefixes).size !== appPathPrefixes.length ||
    context.reservedPaths.some(
      (reservedPath) =>
        appPaths.includes(reservedPath) ||
        appPathPrefixes.some((prefix) => reservedPath.startsWith(prefix)),
    )
  ) {
    throw new Error('FWA Local Edge navigation routes are invalid')
  }

  const parsedNotFound = parseNavigationNotFound(notFound)
  if (
    parsedNotFound.strategy === 'redirect' &&
    !matchesAppNavigationRoute(
      parsedNotFound.targetPath,
      appPaths,
      appPathPrefixes,
    )
  ) {
    throw new Error('FWA Local Edge navigation redirect target must be an app route')
  }

  return {
    appPaths: [...appPaths],
    appPathPrefixes: [...appPathPrefixes],
    notFound: parsedNotFound,
  }
}

function parseNavigationNotFound(value: unknown): NavigationNotFoundConfig {
  if (!isRecord(value)) {
    throw new Error('FWA Local Edge navigation notFound config must be an object')
  }

  if (value.strategy === 'app-entry' || value.strategy === 'network') {
    return { strategy: value.strategy }
  }
  if (
    value.strategy === 'redirect' &&
    typeof value.targetPath === 'string' &&
    isCanonicalPath(value.targetPath)
  ) {
    return { strategy: value.strategy, targetPath: value.targetPath }
  }

  throw new Error('FWA Local Edge navigation notFound config is invalid')
}

function matchesAppNavigationRoute(
  pathname: string,
  appPaths: readonly string[],
  appPathPrefixes: readonly string[],
) {
  return (
    appPaths.includes(pathname) ||
    appPathPrefixes.some((prefix) => pathname.startsWith(prefix))
  )
}

export function localEdgeControlPathsFor<T extends { controlPrefix: string }>(
  config: T,
): LocalEdgeControlPaths {
  return {
    revalidate: `${config.controlPrefix}/revalidate`,
    state: `${config.controlPrefix}/state`,
  }
}

export function localEdgeNavigationModeFor(url: URL) {
  const modes = url.searchParams.getAll(localEdgeModeQueryParameter)
  if (modes.length !== 1) {
    return undefined
  }
  const [mode] = modes
  return mode === 'network' || mode === 'reset' ? mode : undefined
}

export function localEdgeDebugEnabledFor(url: URL) {
  const seed = localEdgeDebugSeedFor(url)
  return seed === 'enable' || seed === 'reset'
}

export function localEdgeDebugSeedFor(url: URL): LocalEdgeDebugSeed | undefined {
  const values = url.searchParams.getAll(localEdgeDebugQueryParameter)
  if (values.length !== 1) {
    return undefined
  }
  if (values[0] === '1') {
    return 'enable'
  }
  if (values[0] === '0') {
    return 'disable'
  }
  if (values[0] === 'reset') {
    return 'reset'
  }
  return undefined
}

export function pathWithLocalEdgeNavigationMode(
  url: URL,
  mode: LocalEdgeNavigationMode,
) {
  const targetUrl = new URL(url)
  targetUrl.searchParams.set(localEdgeModeQueryParameter, mode)
  return pathFromUrl(targetUrl)
}

export function pathWithoutLocalEdgeNavigationMode(url: URL) {
  const targetUrl = new URL(url)
  targetUrl.searchParams.delete(localEdgeModeQueryParameter)
  return pathFromUrl(targetUrl)
}

function pathFromUrl(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`
}

function isPathWithinScope(path: string, scopePath: string) {
  return (
    isCanonicalPath(path) &&
    (scopePath === '/' || path.startsWith(scopePath))
  )
}

function isCanonicalPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }
  const pathUrl = new URL(path, 'https://fwa-config.invalid')
  return pathUrl.pathname === path && !pathUrl.search && !pathUrl.hash
}

function isPathWithinNamespace(path: string, namespace: string) {
  return path === namespace || path.startsWith(`${namespace}/`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
