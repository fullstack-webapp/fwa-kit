import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

interface ReleaseAsset {
  path: string
  mediaType: string
  size: number
  digest: string
}

interface ReleaseDescriptor {
  schemaVersion: 2
  appId: string
  localEdgeEnabled: boolean
  releaseId: string
  appEntry: string
  assets: ReleaseAsset[]
}

const initialLazyAssetPath = '/assets/release-a-lazy.js'
const updatedLazyAssetPath = '/assets/release-b-lazy.js'
const thirdLazyAssetPath = '/assets/release-c-lazy.js'
const redirectedLazyAssetPath = '/assets/release-b-redirect-target.js'

export type CandidateFault =
  | 'cross-origin'
  | 'html-200'
  | 'redirect'
  | 'slow-asset'
  | 'wrong-digest'
  | 'wrong-mime'
  | 'wrong-size'

export async function startReleaseUpdateServer(
  options: { candidateFault?: CandidateFault } = {},
) {
  const distRoot = resolve(process.cwd(), 'dist')
  const localEdgeConfig = JSON.parse(
    await readFile(resolve(process.cwd(), 'fwa.config.json'), 'utf8'),
  ) as {
    controlPrefix: string
    descriptorPath: string
    workerPath: string
  }
  const loaderPath = `${localEdgeConfig.controlPrefix}/loader.js`
  const initialIndex = await readFile(resolve(distRoot, 'index.html'))
  const builtDescriptor = JSON.parse(
    await readFile(
      resolve(distRoot, localEdgeConfig.descriptorPath.slice(1)),
      'utf8',
    ),
  ) as ReleaseDescriptor
  const initialLazyAsset = Buffer.from(
    "export const releaseMarker = 'release-a'\n",
  )
  const updatedLazyAsset = Buffer.from(
    "export const releaseMarker = 'release-b'\n",
  )
  const thirdLazyAsset = Buffer.from(
    "export const releaseMarker = 'release-c'\n",
  )
  const initialDescriptor = withReleaseId({
    ...builtDescriptor,
    assets: [...builtDescriptor.assets, assetRecord(
      initialLazyAssetPath,
      initialLazyAsset,
    )].sort(compareAssetPaths),
  })
  const updatedIndex = Buffer.from(
    initialIndex
      .toString('utf8')
      .replace(
        '</head>',
        '<meta name="fwa-test-release" content="app-update" /></head>',
      ),
  )
  const disabledIndex = Buffer.from(
    initialIndex
      .toString('utf8')
      .replace(
        '</head>',
        '<meta name="fwa-test-network-bypass" content="disabled" /></head>',
      ),
  )
  const updatedReleaseTemplate = {
    ...builtDescriptor,
    assets: [
      ...builtDescriptor.assets.map((asset) =>
        asset.path === '/'
          ? assetRecord('/', updatedIndex, 'text/html')
          : asset,
      ),
      assetRecord(updatedLazyAssetPath, updatedLazyAsset),
    ].sort(compareAssetPaths),
  }
  const updatedDescriptorValue = withReleaseId(
    applyCandidateFault(updatedReleaseTemplate, options.candidateFault),
  )
  const updatedReleaseId = updatedDescriptorValue.releaseId
  const thirdIndex = Buffer.from(
    initialIndex
      .toString('utf8')
      .replace(
        '</head>',
        '<meta name="fwa-test-release" content="app-third" /></head>',
      ),
  )
  const thirdDescriptorValue = withReleaseId({
    ...builtDescriptor,
    assets: [
      ...builtDescriptor.assets.map((asset) =>
        asset.path === '/'
          ? assetRecord('/', thirdIndex, 'text/html')
          : asset,
      ),
      assetRecord(thirdLazyAssetPath, thirdLazyAsset),
    ].sort(compareAssetPaths),
  })
  const thirdReleaseId = thirdDescriptorValue.releaseId
  let releaseGeneration: 'initial' | 'updated' | 'third' = 'initial'
  let localEdgeEnabled = true
  let notifyCandidateAssetRequested: () => void = () => undefined
  const candidateAssetRequested = new Promise<void>((resolveRequest) => {
    notifyCandidateAssetRequested = resolveRequest
  })
  let allowCandidateAsset: () => void = () => undefined
  const candidateAssetGate = new Promise<void>((resolveAsset) => {
    allowCandidateAsset = resolveAsset
  })

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost')

    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/__test/switch-release'
    ) {
      releaseGeneration = 'updated'
      respond(response, Buffer.from(JSON.stringify({ updatedReleaseId })), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
      })
      return
    }
    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/__test/switch-third-release'
    ) {
      releaseGeneration = 'third'
      respond(response, Buffer.from(JSON.stringify({ thirdReleaseId })), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
      })
      return
    }
    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/__test/disable-local-edge'
    ) {
      localEdgeEnabled = false
      respond(response, Buffer.from(JSON.stringify({ localEdgeEnabled })), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
      })
      return
    }
    if (
      request.method === 'POST' &&
      requestUrl.pathname === '/__test/enable-local-edge'
    ) {
      localEdgeEnabled = true
      respond(response, Buffer.from(JSON.stringify({ localEdgeEnabled })), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'no-store',
      })
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }

    try {
      if (requestUrl.pathname === '/') {
        respond(response, !localEdgeEnabled
          ? disabledIndex
          : releaseGeneration === 'third'
            ? thirdIndex
            : releaseGeneration === 'updated'
              ? updatedIndex
              : initialIndex, {
          contentType: 'text/html; charset=utf-8',
          cacheControl: 'no-cache',
          headOnly: request.method === 'HEAD',
        })
        return
      }

      if (requestUrl.pathname === localEdgeConfig.descriptorPath) {
        const releaseDescriptor = releaseGeneration === 'third'
          ? thirdDescriptorValue
          : releaseGeneration === 'updated'
            ? updatedDescriptorValue
            : initialDescriptor
        const descriptorBody = localEdgeEnabled
          ? { ...releaseDescriptor, localEdgeEnabled: true }
          : { localEdgeEnabled: false }
        respond(
          response,
          Buffer.from(`${JSON.stringify(descriptorBody, null, 2)}\n`),
          {
            contentType: 'application/json; charset=utf-8',
            cacheControl: 'no-store',
            headOnly: request.method === 'HEAD',
          },
        )
        return
      }

      if (
        requestUrl.pathname === initialLazyAssetPath &&
        releaseGeneration === 'initial'
      ) {
        respond(
          response,
          initialLazyAsset,
          {
            contentType: 'text/javascript; charset=utf-8',
            cacheControl: 'no-store',
            headOnly: request.method === 'HEAD',
          },
        )
        return
      }
      if (
        requestUrl.pathname === updatedLazyAssetPath &&
        releaseGeneration === 'updated'
      ) {
        if (options.candidateFault === 'slow-asset') {
          notifyCandidateAssetRequested()
          await candidateAssetGate
        }
        if (options.candidateFault === 'redirect') {
          response
            .writeHead(302, {
              'Cache-Control': 'no-store',
              Location: redirectedLazyAssetPath,
            })
            .end()
          return
        }
        if (options.candidateFault === 'html-200') {
          respond(response, Buffer.from('<!doctype html><title>missing</title>'), {
            contentType: 'text/html; charset=utf-8',
            cacheControl: 'no-store',
            headOnly: request.method === 'HEAD',
          })
          return
        }
        respond(
          response,
          updatedLazyAsset,
          {
            contentType:
              options.candidateFault === 'wrong-mime'
                ? 'text/plain; charset=utf-8'
                : 'text/javascript; charset=utf-8',
            cacheControl: 'no-store',
            headOnly: request.method === 'HEAD',
          },
        )
        return
      }
      if (
        requestUrl.pathname === thirdLazyAssetPath &&
        releaseGeneration === 'third'
      ) {
        respond(response, thirdLazyAsset, {
          contentType: 'text/javascript; charset=utf-8',
          cacheControl: 'no-store',
          headOnly: request.method === 'HEAD',
        })
        return
      }
      if (
        requestUrl.pathname === redirectedLazyAssetPath &&
        releaseGeneration === 'updated'
      ) {
        respond(response, updatedLazyAsset, {
          contentType: 'text/javascript; charset=utf-8',
          cacheControl: 'no-store',
          headOnly: request.method === 'HEAD',
        })
        return
      }

      const filePath = resolve(
        distRoot,
        decodeURIComponent(requestUrl.pathname).replace(/^\/+/, ''),
      )
      if (!filePath.startsWith(`${distRoot}${sep}`)) {
        throw new Error('path escapes dist root')
      }

      respond(response, await readFile(filePath), {
        contentType: contentTypeFor(filePath),
        cacheControl:
          requestUrl.pathname === localEdgeConfig.workerPath ||
          requestUrl.pathname === loaderPath
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        headOnly: request.method === 'HEAD',
      })
    } catch {
      response
        .writeHead(404, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        })
        .end('Not Found')
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('release update server did not bind a TCP port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    initialReleaseId: initialDescriptor.releaseId,
    updatedReleaseId,
    thirdReleaseId,
    initialLazyAssetPath,
    updatedLazyAssetPath,
    thirdLazyAssetPath,
    waitForCandidateAssetRequest: () => candidateAssetRequested,
    releaseCandidateAsset: allowCandidateAsset,
    close: () => {
      allowCandidateAsset()
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        )
      })
    },
  }
}

function applyCandidateFault(
  release: Omit<ReleaseDescriptor, 'releaseId'> & { releaseId?: string },
  fault?: CandidateFault,
) {
  if (
    !fault ||
    ['html-200', 'redirect', 'slow-asset', 'wrong-mime'].includes(fault)
  ) {
    return release
  }

  return {
    ...release,
    assets: release.assets
      .map((asset) => {
        if (asset.path !== updatedLazyAssetPath) {
          return asset
        }
        if (fault === 'cross-origin') {
          return { ...asset, path: 'https://cross-origin.invalid/release.js' }
        }
        if (fault === 'wrong-size') {
          return { ...asset, size: asset.size + 1 }
        }
        return { ...asset, digest: `sha256:${'0'.repeat(64)}` }
      })
      .sort(compareAssetPaths),
  }
}

function compareAssetPaths(left: ReleaseAsset, right: ReleaseAsset) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function assetRecord(
  path: string,
  bytes: Buffer,
  mediaType = 'application/javascript',
): ReleaseAsset {
  return {
    path,
    mediaType,
    size: bytes.byteLength,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }
}

function withReleaseId(
  release: Omit<ReleaseDescriptor, 'releaseId'> & { releaseId?: string },
): ReleaseDescriptor {
  const releaseHash = createHash('sha256')
  releaseHash.update(`schemaVersion=${release.schemaVersion}\n`)
  releaseHash.update(`appId=${release.appId}\n`)
  releaseHash.update(`appEntry=${release.appEntry}\n`)
  for (const asset of release.assets) {
    releaseHash.update(
      `${asset.path}\0${asset.mediaType}\0${asset.size}\0${asset.digest}\n`,
    )
  }
  return { ...release, releaseId: releaseHash.digest('hex').slice(0, 16) }
}

function respond(
  response: ServerResponse,
  body: Buffer,
  options: {
    contentType: string
    cacheControl: string
    headOnly?: boolean
  },
) {
  response.writeHead(200, {
    'Cache-Control': options.cacheControl,
    'Content-Length': String(body.byteLength),
    'Content-Type': options.contentType,
  })
  response.end(options.headOnly ? undefined : body)
}

function contentTypeFor(filePath: string) {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}
