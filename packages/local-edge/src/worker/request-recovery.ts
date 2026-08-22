export function cloneReplaySafeRequest(request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null
  }

  return request.clone()
}
