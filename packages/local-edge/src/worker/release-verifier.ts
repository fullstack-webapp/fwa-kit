import { localEdgeConfig } from '../config.ts'
import {
  type AppReleaseAsset,
  type AppReleaseDescriptor,
  type VerifiedAppRelease,
} from '../release.ts'

const worker = self as unknown as ServiceWorkerGlobalScope
const maxAssetSize = 16 * 1024 * 1024
const maxReleaseSize = 64 * 1024 * 1024

export async function fetchVerifiedReleaseDescriptor(signal: AbortSignal) {
  const descriptorUrl = new URL(localEdgeConfig.descriptorPath, worker.location.origin)
  const response = await fetch(descriptorUrl, {
    cache: 'no-store',
    redirect: 'follow',
    signal,
  })
  if (response.status !== 200) {
    throw new Error(`release descriptor returned ${response.status}`)
  }
  if (response.redirected || response.url !== descriptorUrl.href) {
    throw new Error('release descriptor redirected')
  }
  if (mediaTypeEssence(response) !== 'application/json') {
    throw new Error('release descriptor must be application/json')
  }

  const descriptor = parseReleaseDescriptor(await response.json())
  if (descriptor.release) {
    await verifyReleaseIdentity(descriptor.release)
  }
  return descriptor
}

export async function fetchVerifiedAsset(asset: AppReleaseAsset, signal: AbortSignal) {
  const assetUrl = new URL(asset.path, worker.location.origin)
  const response = await fetch(assetUrl, {
    cache: 'reload',
    redirect: 'follow',
    signal,
  })
  if (response.status !== 200) {
    throw new Error(`${asset.path} returned ${response.status}`)
  }
  if (response.redirected || response.url !== assetUrl.href) {
    throw new Error(`${asset.path} redirected`)
  }

  const actualMediaType = mediaTypeEssence(response)
  if (!mediaTypesMatch(asset.mediaType, actualMediaType)) {
    throw new Error(
      `${asset.path} returned ${actualMediaType || 'no media type'}, expected ${asset.mediaType}`,
    )
  }

  const assetBytes = await response.arrayBuffer()
  if (assetBytes.byteLength !== asset.size) {
    throw new Error(
      `${asset.path} returned ${assetBytes.byteLength} bytes, expected ${asset.size}`,
    )
  }
  const digest = `sha256:${await sha256Hex(assetBytes)}`
  if (digest !== asset.digest) {
    throw new Error(`${asset.path} failed SHA-256 verification`)
  }

  const verifiedHeaders = new Headers(response.headers)
  verifiedHeaders.delete('Content-Encoding')
  verifiedHeaders.delete('Content-Length')
  return new Response(assetBytes, {
    status: 200,
    headers: verifiedHeaders,
  })
}

function parseReleaseDescriptor(value: unknown): AppReleaseDescriptor {
  if (!isRecord(value)) {
    throw new Error('release descriptor must be an object')
  }

  const localEdgeEnabled = value.localEdgeEnabled ?? true
  if (typeof localEdgeEnabled !== 'boolean') {
    throw new Error('release descriptor localEdgeEnabled must be a boolean')
  }
  if (!localEdgeEnabled) {
    return { localEdgeEnabled: false }
  }

  const {
    schemaVersion,
    appId,
    releaseId,
    appEntry,
    assets,
  } = value
  if (
    schemaVersion !== 2 ||
    appId !== localEdgeConfig.appId ||
    typeof releaseId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(releaseId) ||
    typeof appEntry !== 'string' ||
    !isCanonicalAssetPath(appEntry) ||
    !Array.isArray(assets)
  ) {
    throw new Error('release descriptor is invalid')
  }

  const parsedAssets = assets.map(parseAsset)
  const assetPaths = parsedAssets.map((asset) => asset.path)
  if (
    !assetPaths.includes(appEntry) ||
    new Set(assetPaths).size !== assetPaths.length ||
    !assetPaths.every(
      (assetPath, index) => index === 0 || assetPaths[index - 1] < assetPath,
    ) ||
    parsedAssets.reduce((total, asset) => total + asset.size, 0) > maxReleaseSize
  ) {
    throw new Error('release asset records are invalid')
  }

  return {
    localEdgeEnabled,
    release: {
      schemaVersion,
      appId,
      releaseId,
      appEntry,
      assets: parsedAssets,
    },
  }
}

function parseAsset(value: unknown): AppReleaseAsset {
  if (!isRecord(value)) {
    throw new Error('release asset must be an object')
  }

  const { path, mediaType, size, digest } = value
  if (
    typeof path !== 'string' ||
    !isCanonicalAssetPath(path) ||
    typeof mediaType !== 'string' ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > maxAssetSize ||
    typeof digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(digest)
  ) {
    throw new Error('release asset is invalid')
  }

  return { path, mediaType, size, digest }
}

function isCanonicalAssetPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return false
  }

  const assetUrl = new URL(path, worker.location.origin)
  return (
    assetUrl.origin === worker.location.origin &&
    assetUrl.pathname === path &&
    (localEdgeConfig.scopePath === '/' || path.startsWith(localEdgeConfig.scopePath)) &&
    !assetUrl.search &&
    !assetUrl.hash
  )
}

function mediaTypeEssence(response: Response) {
  return (response.headers.get('Content-Type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function mediaTypesMatch(expected: string, actual: string) {
  if (expected === actual) {
    return true
  }
  return expected === 'application/javascript' && actual === 'text/javascript'
}

async function verifyReleaseIdentity(release: VerifiedAppRelease) {
  const canonicalParts = [
    'schemaVersion=2\n',
    `appId=${release.appId}\n`,
    `appEntry=${release.appEntry}\n`,
    ...release.assets.map(
      (asset) =>
        `${asset.path}\0${asset.mediaType}\0${asset.size}\0${asset.digest}\n`,
    ),
  ]
  const identity = await sha256Hex(
    new TextEncoder().encode(canonicalParts.join('')),
  )
  if (release.releaseId !== identity.slice(0, 16)) {
    throw new Error('release id does not match its canonical asset records')
  }
}

async function sha256Hex(value: BufferSource) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
