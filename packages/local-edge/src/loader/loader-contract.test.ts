import { describe, expect, it } from 'vitest'
import { deriveFwaLoaderPaths } from './loader-contract.ts'

describe('deriveFwaLoaderPaths', () => {
  it('derives the root loader profile from its own URL', () => {
    expect(
      deriveFwaLoaderPaths(
        new URL('https://app.example/__fwa/loader.js?v=1'),
        'https://app.example',
      ),
    ).toEqual({
      scopePath: '/',
      workerPath: '/__fwa-sw.js',
      descriptorPath: '/__fwa/release.json',
      controlPrefix: '/__fwa',
      loaderPath: '/__fwa/loader.js',
      statePath: '/__fwa/state',
      revalidatePath: '/__fwa/revalidate',
    })
  })

  it('derives a non-root loader profile without page config', () => {
    expect(
      deriveFwaLoaderPaths(
        new URL('https://app.example/app/__fwa/loader.js'),
      ),
    ).toMatchObject({
      scopePath: '/app/',
      workerPath: '/app/__fwa-sw.js',
      descriptorPath: '/app/__fwa/release.json',
      controlPrefix: '/app/__fwa',
    })
  })

  it('rejects cross-origin and non-canonical loader entry points', () => {
    expect(() =>
      deriveFwaLoaderPaths(
        new URL('https://cdn.example/__fwa/loader.js'),
        'https://app.example',
      ),
    ).toThrow('FWA loader must be served from the app origin')
    expect(() =>
      deriveFwaLoaderPaths(
        new URL('https://app.example/assets/fwa-loader.js'),
      ),
    ).toThrow('FWA loader URL must end with /__fwa/loader.js')
  })
})
