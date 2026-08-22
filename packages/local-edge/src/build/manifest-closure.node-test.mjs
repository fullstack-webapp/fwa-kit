import assert from 'node:assert/strict'
import test from 'node:test'
import { collectManifestAssetPaths } from './manifest-closure.mjs'

test('collects a cyclic Vite manifest graph exactly once', () => {
  const manifest = {
    'index.html': {
      file: 'assets/index.js',
      css: ['assets/index.css'],
      imports: ['shared.ts'],
      dynamicImports: ['route.ts'],
    },
    'shared.ts': {
      file: 'assets/shared.js',
      imports: ['index.html'],
    },
    'route.ts': {
      file: 'assets/route.js',
      assets: ['assets/route.svg'],
      imports: ['shared.ts'],
    },
  }

  assert.deepEqual(
    [...collectManifestAssetPaths(manifest, 'index.html')].sort(),
    [
      '/assets/index.css',
      '/assets/index.js',
      '/assets/route.js',
      '/assets/route.svg',
      '/assets/shared.js',
    ],
  )
})

test('rejects a reference to a missing manifest chunk', () => {
  assert.throws(
    () =>
      collectManifestAssetPaths(
        { 'index.html': { file: 'assets/index.js', imports: ['missing.ts'] } },
        'index.html',
      ),
    /missing chunk: missing\.ts/,
  )
})
