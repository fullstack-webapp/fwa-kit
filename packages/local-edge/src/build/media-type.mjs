const MediaTypes = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function mediaTypeFor(filePath) {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const mediaType = MediaTypes[extension]

  if (!mediaType) {
    throw new Error(`No media type mapping for ${filePath}`)
  }
  return mediaType
}
