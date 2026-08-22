import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReleaseAssetOwnership } from './release-asset-ownership.mjs'

const ownership = {
  appEntry: '/',
  appRequestPrefixes: ['/api/'],
  loaderPath: '/__fwa/loader.js',
  releaseAssetPrefixes: ['/assets/'],
  supplementalAssetPaths: ['/favicon.svg'],
}

test('accepts a release closure contained by explicit worker paths', () => {
  assert.doesNotThrow(() =>
    assertReleaseAssetOwnership(
      ['/', '/__fwa/loader.js', '/favicon.svg', '/assets/app.js'],
      ownership,
    ),
  )
})

test('rejects a release asset outside the worker interception allowlist', () => {
  assert.throws(
    () => assertReleaseAssetOwnership(['/auth-probe.txt'], ownership),
    /outside the worker interception allowlist/,
  )
})

test('rejects a release asset inside an app request namespace', () => {
  assert.throws(
    () => assertReleaseAssetOwnership(['/api/schema.json'], ownership),
    /overlaps an app request prefix/,
  )
})
