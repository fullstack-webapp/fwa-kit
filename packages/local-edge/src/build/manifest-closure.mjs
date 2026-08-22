export function collectManifestAssetPaths(manifest, entryKey) {
  const assetPaths = new Set()
  const visitedChunks = new Set()

  function visit(manifestKey) {
    if (visitedChunks.has(manifestKey)) {
      return
    }
    visitedChunks.add(manifestKey)

    const chunk = manifest[manifestKey]
    if (!chunk) {
      throw new Error(`Vite manifest references missing chunk: ${manifestKey}`)
    }

    assetPaths.add(`/${chunk.file}`)
    for (const assetPath of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      assetPaths.add(`/${assetPath}`)
    }
    for (const importedKey of [
      ...(chunk.imports ?? []),
      ...(chunk.dynamicImports ?? []),
    ]) {
      visit(importedKey)
    }
  }

  visit(entryKey)
  return assetPaths
}
