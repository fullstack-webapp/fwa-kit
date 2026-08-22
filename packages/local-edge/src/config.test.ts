import { describe, expect, it } from 'vitest'
import {
  localEdgeControlPathsFor,
  defineLocalEdgeConfig,
  loaderPathFor,
  pathWithLocalEdgeNavigationMode,
  pathWithoutLocalEdgeNavigationMode,
  localEdgeDebugEnabledFor,
  localEdgeDebugSeedFor,
  localEdgeNavigationModeFor,
  type LocalEdgeConfig,
} from './config-contract.ts'

const validConfig: LocalEdgeConfig = {
  appId: 'scoped-app',
  localEdgeEnabled: true,
  scopePath: '/app/',
  workerPath: '/app/worker.js',
  descriptorPath: '/app/release.json',
  controlPrefix: '/app/__edge',
  appEntry: '/app/',
  appRequestPrefixes: ['/app/api/'],
  releaseAssetPrefixes: ['/app/assets/'],
  supplementalAssetPaths: ['/app/favicon.svg'],
  navigation: {
    appPaths: ['/app/', '/app/library/'],
    appPathPrefixes: ['/app/library/'],
    notFound: { strategy: 'app-entry' },
  },
}

describe('defineLocalEdgeConfig', () => {
  it('accepts a non-root scope and derives custom control paths', () => {
    const config = defineLocalEdgeConfig({
      appId: 'scoped-app',
      localEdgeEnabled: false,
      scopePath: '/workspace/',
      workerPath: '/workspace/worker.js',
      descriptorPath: '/workspace/release.json',
      controlPrefix: '/workspace/__edge',
      appEntry: '/workspace/',
      appRequestPrefixes: ['/workspace/api/'],
      releaseAssetPrefixes: ['/workspace/assets/'],
      supplementalAssetPaths: ['/workspace/favicon.svg'],
      navigation: {
        appPaths: ['/workspace/'],
        appPathPrefixes: [],
        notFound: { strategy: 'network' },
      },
    })

    expect(localEdgeControlPathsFor(config)).toEqual({
      revalidate: '/workspace/__edge/revalidate',
      state: '/workspace/__edge/state',
    })
    expect(loaderPathFor(config)).toBe('/workspace/__edge/loader.js')
    expect(config.localEdgeEnabled).toBe(false)
  })

  it('allows the release descriptor inside the control namespace', () => {
    const config = defineLocalEdgeConfig({
      ...validConfig,
      descriptorPath: '/app/__edge/release.json',
    })

    expect(config.descriptorPath).toBe('/app/__edge/release.json')
  })

  it('rejects paths outside the configured scope', () => {
    expect(() =>
      defineLocalEdgeConfig({
        appId: 'scoped-app',
        localEdgeEnabled: true,
        scopePath: '/workspace/',
        workerPath: '/worker.js',
        descriptorPath: '/workspace/release.json',
        controlPrefix: '/workspace/__edge',
        appEntry: '/workspace/',
        appRequestPrefixes: ['/workspace/api/'],
        releaseAssetPrefixes: ['/workspace/assets/'],
        supplementalAssetPaths: [],
      }),
    ).toThrow('FWA Local Edge config is invalid')
  })

  it('rejects host assets inside the reserved control namespace', () => {
    expect(() =>
      defineLocalEdgeConfig({
        ...validConfig,
        appEntry: '/app/__edge/open',
      }),
    ).toThrow('FWA Local Edge config is invalid')
  })

  it('preserves the app URL while adding and removing a navigation mode', () => {
    const appUrl = new URL(
      'https://app.example/app/library/?view=all#recent',
    )
    const networkPath = pathWithLocalEdgeNavigationMode(appUrl, 'network')

    expect(networkPath).toBe(
      '/app/library/?view=all&__fwa=network#recent',
    )
    expect(
      localEdgeNavigationModeFor(new URL(networkPath, appUrl.origin)),
    ).toBe('network')
    expect(
      pathWithoutLocalEdgeNavigationMode(new URL(networkPath, appUrl.origin)),
    ).toBe('/app/library/?view=all#recent')
  })

  it('recognizes only SDK navigation mode values', () => {
    expect(
      localEdgeNavigationModeFor(
        new URL('https://app.example/app/?__fwa=reset'),
      ),
    ).toBe('reset')
    expect(
      localEdgeNavigationModeFor(
        new URL('https://app.example/app/?__fwa=enabled'),
      ),
    ).toBeUndefined()
    expect(
      localEdgeNavigationModeFor(
        new URL(
          'https://app.example/app/?__fwa=network&__fwa=reset',
        ),
      ),
    ).toBeUndefined()
  })

  it('recognizes debug without treating it as a navigation mode', () => {
    const debugUrl = new URL(
      'https://app.example/app/?view=all&__fwa_debug=1',
    )

    expect(localEdgeDebugEnabledFor(debugUrl)).toBe(true)
    expect(localEdgeDebugSeedFor(debugUrl)).toBe('enable')
    expect(localEdgeNavigationModeFor(debugUrl)).toBeUndefined()
    const networkDebugUrl = new URL(
      'https://app.example/app/?__fwa=network&__fwa_debug=1',
    )
    expect(localEdgeDebugEnabledFor(networkDebugUrl)).toBe(true)
    expect(localEdgeNavigationModeFor(networkDebugUrl)).toBe('network')
    expect(
      localEdgeDebugEnabledFor(
        new URL(
          'https://app.example/app/?__fwa_debug=1&__fwa_debug=1',
        ),
      ),
    ).toBe(false)
    expect(
      localEdgeDebugEnabledFor(
        new URL('https://app.example/app/?__fwa_debug=0'),
      ),
    ).toBe(false)
    expect(
      localEdgeDebugSeedFor(
        new URL('https://app.example/app/?__fwa_debug=0'),
      ),
    ).toBe('disable')
    const resetDebugUrl = new URL(
      'https://app.example/app/?__fwa_debug=reset',
    )
    expect(localEdgeDebugEnabledFor(resetDebugUrl)).toBe(true)
    expect(localEdgeDebugSeedFor(resetDebugUrl)).toBe('reset')
  })

  it('requires redirects to target a declared app route', () => {
    expect(() =>
      defineLocalEdgeConfig({
        ...validConfig,
        navigation: {
          ...validConfig.navigation,
          notFound: { strategy: 'redirect', targetPath: '/app/missing/' },
        },
      }),
    ).toThrow('FWA Local Edge navigation redirect target must be an app route')
  })

  it('rejects invalid supplemental asset declarations', () => {
    for (const supplementalAssetPaths of [
      ['/outside.svg'],
      ['/app/favicon.svg', '/app/favicon.svg'],
      ['/app/worker.js'],
      ['/app/__edge/icon.svg'],
      ['/app/api/icon.svg'],
    ]) {
      expect(() =>
        defineLocalEdgeConfig({
          ...validConfig,
          supplementalAssetPaths,
        }),
      ).toThrow('FWA Local Edge config is invalid')
    }
  })

  it('rejects broad or overlapping release asset prefixes', () => {
    for (const releaseAssetPrefixes of [
      ['/app/'],
      ['/outside/'],
      ['/app/assets/', '/app/assets/'],
      ['/app/__edge/assets/'],
      ['/app/api/assets/'],
    ]) {
      expect(() =>
        defineLocalEdgeConfig({
          ...validConfig,
          releaseAssetPrefixes,
        }),
      ).toThrow('FWA Local Edge config is invalid')
    }
  })
})
