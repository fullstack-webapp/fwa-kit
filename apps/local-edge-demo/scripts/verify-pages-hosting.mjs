import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const host = '127.0.0.1'
const port = 4174
const baseUrl = `http://${host}:${port}`
const localEdgeConfig = JSON.parse(
  await readFile(resolve(import.meta.dirname, '..', 'fwa.config.json'), 'utf8'),
)
const loaderPath = `${localEdgeConfig.controlPrefix}/loader.js`
const server = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'pages',
    'dev',
    'dist',
    '--ip',
    host,
    '--port',
    String(port),
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let serverOutput = ''
server.stdout.on('data', (chunk) => {
  serverOutput += chunk
})
server.stderr.on('data', (chunk) => {
  serverOutput += chunk
})

try {
  await waitForServer()
  await verifyRootEntry()
  await verifyNetworkModeEntry()
  await verifyNavigationFallback()
  await verifySdkEntryPoints()
  await verifyPublishedAssets()
  await verifyMissingAssets()
  console.log('Pages hosting contract verified')
} catch (error) {
  if (serverOutput.trim()) {
    console.error(serverOutput.trim())
  }
  throw error
} finally {
  server.kill('SIGTERM')
}

async function waitForServer() {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler pages dev exited with ${server.exitCode}`)
    }

    try {
      const response = await fetch(`${baseUrl}${localEdgeConfig.appEntry}`)
      if (response.ok) {
        return
      }
    } catch {
      // The local Pages runtime is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('wrangler pages dev did not become ready within 20 seconds')
}

async function verifyRootEntry() {
  const response = await fetch(`${baseUrl}${localEdgeConfig.appEntry}`)
  assert(response.status === 200, `root returned ${response.status}`)
  assertContentType(response, 'text/html')
  const cacheControl = response.headers.get('cache-control') ?? ''
  assert(cacheControl.includes('no-cache'), 'root is missing no-cache')
  assert(cacheControl.includes('no-transform'), 'root is missing no-transform')
  const html = await response.text()
  assert(
    html.includes(`src="${loaderPath}"`),
    `root document omitted ${loaderPath}`,
  )
}

async function verifyNetworkModeEntry() {
  const entryUrl = new URL(localEdgeConfig.appEntry, baseUrl)
  entryUrl.searchParams.set('__fwa', 'network')
  const response = await fetch(entryUrl)
  assert(response.status === 200, `network mode returned ${response.status}`)
  assertContentType(response, 'text/html')
}

async function verifyNavigationFallback() {
  for (const routePath of ['/library/', '/missing-route']) {
    const response = await fetch(`${baseUrl}${routePath}`)
    const responseBody = await response.text()

    assert(response.status === 404, `${routePath} returned ${response.status}`)
    assertContentType(response, 'text/html')
    assert(
      responseBody.includes('<div id="root"></div>'),
      `${routePath} did not return the app-bearing 404 document`,
    )
    assert(
      response.headers.get('cache-control')?.includes('no-store') === true,
      `${routePath} did not inherit the no-store 404 policy`,
    )
  }
}

async function verifyPublishedAssets() {
  const descriptor = await fetch(
    `${baseUrl}${localEdgeConfig.descriptorPath}`,
  ).then((response) => response.json())
  const assetRecords = descriptor.assets.filter(
    (asset) => asset.path !== localEdgeConfig.appEntry,
  )

  assert(assetRecords.length > 0, 'release descriptor has no static assets')
  assert(
    assetRecords.some((asset) => asset.path === '/favicon.svg'),
    'release descriptor omitted the declared supplemental asset',
  )
  assert(
    assetRecords.some((asset) => asset.path === loaderPath),
    'release descriptor omitted the same-origin loader',
  )

  for (const asset of assetRecords) {
    const response = await fetch(`${baseUrl}${asset.path}`)
    assert(response.status === 200, `${asset.path} returned ${response.status}`)
    const cacheControl = response.headers.get('cache-control') ?? ''
    if (
      asset.path === loaderPath ||
      localEdgeConfig.supplementalAssetPaths.includes(asset.path)
    ) {
      assert(
        cacheControl.includes('no-cache'),
        `${asset.path} is missing its revalidation policy`,
      )
      assert(
        !cacheControl.includes('immutable'),
        `${asset.path} incorrectly uses immutable caching`,
      )
    } else {
      assert(cacheControl.includes('immutable'), `${asset.path} is not immutable`)
    }
    assertContentType(response, asset.mediaType)
  }
}

async function verifySdkEntryPoints() {
  for (const assetPath of [loaderPath, localEdgeConfig.workerPath]) {
    const response = await fetch(`${baseUrl}${assetPath}`)
    assert(response.status === 200, `${assetPath} returned ${response.status}`)
    assertContentType(response, 'javascript')
    const cacheControl = response.headers.get('cache-control') ?? ''
    assert(
      cacheControl.includes('no-cache'),
      `${assetPath} is missing its revalidation policy`,
    )
    assert(
      !cacheControl.includes('immutable'),
      `${assetPath} incorrectly uses immutable caching`,
    )
  }

  const descriptorResponse = await fetch(
    `${baseUrl}${localEdgeConfig.descriptorPath}`,
  )
  assert(
    descriptorResponse.status === 200,
    `${localEdgeConfig.descriptorPath} returned ${descriptorResponse.status}`,
  )
  assertContentType(descriptorResponse, 'application/json')
  assert(
    descriptorResponse.headers.get('cache-control')?.includes('no-store') ===
      true,
    `${localEdgeConfig.descriptorPath} is missing no-store`,
  )
}

async function verifyMissingAssets() {
  for (const assetPath of [
    '/assets/missing-release.js',
    '/assets/missing-release.css',
  ]) {
    const response = await fetch(`${baseUrl}${assetPath}`)
    assert(response.status === 404, `${assetPath} returned ${response.status}`)
    assert(
      response.headers.get('cache-control')?.includes('immutable') !== true,
      `${assetPath} returned an immutable fallback`,
    )
  }
}

function assertContentType(response, expectedFragment) {
  const contentType = response.headers.get('content-type') ?? ''
  assert(
    contentType.includes(expectedFragment),
    `${new URL(response.url).pathname} returned ${contentType || 'no content type'}`,
  )
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}
