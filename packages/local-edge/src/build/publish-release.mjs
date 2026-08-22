#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { collectManifestAssetPaths } from './manifest-closure.mjs'
import { mediaTypeFor } from './media-type.mjs'
import { assertReleaseAssetOwnership } from './release-asset-ownership.mjs'

const projectRoot = resolve(process.cwd())
const distRoot = resolve(projectRoot, 'dist')
const localEdgeConfig = JSON.parse(
  await readFile(resolve(distRoot, '.vite/fwa.config.json'), 'utf8'),
)
const manifest = JSON.parse(
  await readFile(resolve(distRoot, '.vite/manifest.json'), 'utf8'),
)
const loaderPath = `${localEdgeConfig.controlPrefix}/loader.js`
const appEntry = Object.entries(manifest).find(
  ([sourcePath, chunk]) => sourcePath === 'index.html' && chunk.isEntry,
)

if (!appEntry) {
  throw new Error('Vite manifest does not contain the index.html app entry')
}

const assetPaths = new Set([
  localEdgeConfig.appEntry,
  loaderPath,
  ...localEdgeConfig.supplementalAssetPaths,
])
for (const assetPath of collectManifestAssetPaths(manifest, appEntry[0])) {
  assetPaths.add(assetPath)
}

assertReleaseAssetOwnership(assetPaths, {
  appEntry: localEdgeConfig.appEntry,
  appRequestPrefixes: localEdgeConfig.appRequestPrefixes,
  loaderPath,
  releaseAssetPrefixes: localEdgeConfig.releaseAssetPrefixes,
  supplementalAssetPaths: localEdgeConfig.supplementalAssetPaths,
})

const coreAssets = [...assetPaths].sort()
const assets = []
for (const assetPath of coreAssets) {
  const assetFilePath =
    assetPath === localEdgeConfig.appEntry ? 'index.html' : assetPath.slice(1)
  const assetBytes = await readFile(resolve(distRoot, assetFilePath))
  assets.push({
    path: assetPath,
    mediaType: mediaTypeFor(assetFilePath),
    size: assetBytes.byteLength,
    digest: `sha256:${createHash('sha256').update(assetBytes).digest('hex')}`,
  })
}

const release = {
  schemaVersion: 2,
  appId: localEdgeConfig.appId,
  localEdgeEnabled: localEdgeConfig.localEdgeEnabled,
  releaseId: releaseIdFor(assets),
  appEntry: localEdgeConfig.appEntry,
  assets,
}

const descriptorFilePath = resolve(
  distRoot,
  localEdgeConfig.descriptorPath.slice(1),
)
await mkdir(dirname(descriptorFilePath), { recursive: true })
await writeFile(
  descriptorFilePath,
  `${JSON.stringify(release, null, 2)}\n`,
)
if (localEdgeConfig.navigation.notFound.strategy !== 'network') {
  await copyFile(resolve(distRoot, 'index.html'), resolve(distRoot, '404.html'))
}

const headerRules = [
  localEdgeConfig.appEntry,
  '  Cache-Control: no-cache, no-transform',
  '',
  '/404.html',
  '  Cache-Control: no-store',
  '',
  localEdgeConfig.workerPath,
  '  Cache-Control: no-cache',
  '',
  loaderPath,
  '  Cache-Control: no-cache',
  '',
  localEdgeConfig.descriptorPath,
  '  Cache-Control: no-store',
  '',
]

for (const assetPath of assets
  .map((asset) => asset.path)
  .filter(
    (assetPath) =>
      assetPath !== localEdgeConfig.appEntry &&
      assetPath !== loaderPath &&
      !localEdgeConfig.supplementalAssetPaths.includes(assetPath),
  )) {
  headerRules.push(
    '',
    assetPath,
    '  Cache-Control: public, max-age=31536000, immutable',
  )
}

for (const assetPath of localEdgeConfig.supplementalAssetPaths) {
  headerRules.push('', assetPath, '  Cache-Control: no-cache')
}

function releaseIdFor(releaseAssets) {
  const releaseHash = createHash('sha256')
  releaseHash.update('schemaVersion=2\n')
  releaseHash.update(`appId=${localEdgeConfig.appId}\n`)
  releaseHash.update(`appEntry=${localEdgeConfig.appEntry}\n`)
  for (const asset of releaseAssets) {
    releaseHash.update(
      `${asset.path}\0${asset.mediaType}\0${asset.size}\0${asset.digest}\n`,
    )
  }
  return releaseHash.digest('hex').slice(0, 16)
}

await writeFile(resolve(distRoot, '_headers'), `${headerRules.join('\n')}\n`)
