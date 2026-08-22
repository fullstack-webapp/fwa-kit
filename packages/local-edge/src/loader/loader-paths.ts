export interface FwaLoaderPaths {
  scopePath: string
  workerPath: string
  descriptorPath: string
  controlPrefix: string
  loaderPath: string
  statePath: string
  revalidatePath: string
}

export function deriveFwaLoaderPaths(
  loaderUrl: URL,
  expectedOrigin?: string,
): FwaLoaderPaths {
  if (expectedOrigin && loaderUrl.origin !== expectedOrigin) {
    throw new Error('FWA loader must be served from the app origin')
  }

  const loaderSuffix = '__fwa/loader.js'
  if (!loaderUrl.pathname.endsWith(loaderSuffix)) {
    throw new Error('FWA loader URL must end with /__fwa/loader.js')
  }

  const scopePath = loaderUrl.pathname.slice(0, -loaderSuffix.length)
  if (!scopePath.startsWith('/') || !scopePath.endsWith('/')) {
    throw new Error('FWA loader URL does not contain a canonical app scope')
  }

  const controlPrefix = `${scopePath}__fwa`
  return {
    scopePath,
    workerPath: `${scopePath}__fwa-sw.js`,
    descriptorPath: `${controlPrefix}/release.json`,
    controlPrefix,
    loaderPath: `${controlPrefix}/loader.js`,
    statePath: `${controlPrefix}/state`,
    revalidatePath: `${controlPrefix}/revalidate`,
  }
}
