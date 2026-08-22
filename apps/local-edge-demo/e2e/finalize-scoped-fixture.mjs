import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const distRoot = resolve(import.meta.dirname, '..', 'dist')
const fixtureRoot = resolve(distRoot, 'scoped')
const localEdgeConfig = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, '..', 'e2e', 'scoped-fwa.config.json'),
    'utf8',
  ),
)
const fixtureConfig = {
  schemaVersion: 2,
  appId: localEdgeConfig.appId,
  localEdgeEnabled: localEdgeConfig.localEdgeEnabled,
  appEntry: localEdgeConfig.appEntry,
}
const appBytes = Buffer.from(
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Scoped fixture</title>
  </head>
  <body>
    <main data-scoped-fixture data-local-edge-phase="starting">
      Scoped framework-neutral FWA fixture
    </main>
    <script>
      window.__fwa = window.__fwa || { q: [] }
      window.__fwaObservedStates = []
      window.__fwa.q.push([
        'localEdge.subscribe',
        function (state) {
          window.__fwaObservedStates.push(state)
          document.querySelector('[data-scoped-fixture]').dataset.localEdgePhase =
            state.phase
        },
      ])
    </script>
    <script defer src="${localEdgeConfig.controlPrefix}/loader.js"></script>
  </body>
</html>
`,
)
const loaderPath = `${localEdgeConfig.controlPrefix}/loader.js`
const loaderBytes = await readFile(resolve(distRoot, loaderPath.slice(1)))
const assets = [
  {
    path: fixtureConfig.appEntry,
    mediaType: 'text/html',
    size: appBytes.byteLength,
    digest: `sha256:${createHash('sha256').update(appBytes).digest('hex')}`,
  },
  {
    path: loaderPath,
    mediaType: 'application/javascript',
    size: loaderBytes.byteLength,
    digest: `sha256:${createHash('sha256').update(loaderBytes).digest('hex')}`,
  },
].sort((left, right) => left.path.localeCompare(right.path))
const releaseHash = createHash('sha256')
releaseHash.update(`schemaVersion=${fixtureConfig.schemaVersion}\n`)
releaseHash.update(`appId=${fixtureConfig.appId}\n`)
releaseHash.update(`appEntry=${fixtureConfig.appEntry}\n`)
for (const asset of assets) {
  releaseHash.update(
    `${asset.path}\0${asset.mediaType}\0${asset.size}\0${asset.digest}\n`,
  )
}
const descriptor = {
  ...fixtureConfig,
  releaseId: releaseHash.digest('hex').slice(0, 16),
  assets,
}

await mkdir(fixtureRoot, { recursive: true })
await writeFile(resolve(fixtureRoot, 'index.html'), appBytes)
const legacyWorkerFilePath = resolve(distRoot, 'legacy-worker.js')
await mkdir(dirname(legacyWorkerFilePath), { recursive: true })
await writeFile(
  legacyWorkerFilePath,
  "self.addEventListener('fetch', function () {})\n",
)
const descriptorFilePath = resolve(
  distRoot,
  localEdgeConfig.descriptorPath.slice(1),
)
await mkdir(dirname(descriptorFilePath), { recursive: true })
await writeFile(
  descriptorFilePath,
  `${JSON.stringify(descriptor, null, 2)}\n`,
)
