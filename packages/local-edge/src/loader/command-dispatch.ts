import { isValidUpdateCheckIntervalMinutes } from '../config-contract.ts'
import type { FwaDebugApi, FwaLocalEdgeApi } from './loader-contract.ts'

// Executes one queued `window.__fwa.q` command against the loader facade.
// Malformed commands and arguments are ignored.
export function dispatchCommand(localEdgeApi: FwaLocalEdgeApi, command: unknown) {
  if (!Array.isArray(command)) {
    return
  }

  const [name, argument] = command
  switch (name) {
    case 'localEdge.getState':
      if (typeof argument === 'function') {
        argument(localEdgeApi.getState())
      }
      break
    case 'localEdge.subscribe':
      if (typeof argument === 'function') {
        localEdgeApi.subscribe(argument)
      }
      break
    case 'localEdge.revalidate':
      void localEdgeApi.revalidate().catch(() => undefined)
      break
    case 'localEdge.setUpdateCheck':
      if (isUpdateCheckCommandConfig(argument)) {
        localEdgeApi.setUpdateCheck(argument)
      }
      break
    case 'localEdge.applyUpdate':
      localEdgeApi.applyUpdate()
      break
    case 'localEdge.reset':
      void localEdgeApi.reset().catch(() => undefined)
      break
    case 'localEdge.openNetwork':
      localEdgeApi.openNetwork()
      break
    case 'debug.getState':
      if (typeof argument === 'function') {
        argument(localEdgeApi.debug.getState())
      }
      break
    case 'debug.subscribe':
      if (typeof argument === 'function') {
        localEdgeApi.debug.subscribe(argument)
      }
      break
    case 'debug.setEnabled':
      if (typeof argument === 'boolean') {
        localEdgeApi.debug.setEnabled(argument)
      }
      break
    case 'debug.setUrlWriter':
      if (typeof argument === 'function' || argument === null) {
        localEdgeApi.debug.setUrlWriter(argument)
      }
      break
  }
}

function isUpdateCheckCommandConfig(
  value: unknown,
): value is { enabled?: boolean; intervalMinutes?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const { enabled, intervalMinutes } = value as Record<string, unknown>
  return (
    (enabled === undefined || typeof enabled === 'boolean') &&
    (intervalMinutes === undefined ||
      isValidUpdateCheckIntervalMinutes(intervalMinutes))
  )
}

/**
 * Apply URL writers that the host queued before the loader ran, so the
 * startup `__fwa_debug=reset` removal already goes through the host. The
 * commands stay in the queue; replaying them later is idempotent.
 */
export function applyQueuedUrlWriters(queue: readonly unknown[], debug: FwaDebugApi) {
  for (const command of queue) {
    if (!Array.isArray(command) || command[0] !== 'debug.setUrlWriter') continue
    const writer = command[1]
    if (typeof writer === 'function' || writer === null) {
      debug.setUrlWriter(writer)
    }
  }
}
