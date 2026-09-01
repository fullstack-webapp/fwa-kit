import { createLocalEdgeDocumentRuntime } from './document-runtime.ts'
import {
  fwaTakeoverMessageType,
  localEdgeConfig,
} from '../config.ts'
import { isValidUpdateCheckIntervalMinutes } from '../config-contract.ts'
import { createFwaDebugRuntime } from './debug-runtime.ts'
import {
  deriveFwaLoaderPaths,
  fwaGlobalReadyEventName,
  fwaLoaderVersion,
  type FwaLocalEdgeApi,
  type FwaGlobal,
  type FwaQueuedCommand,
} from './loader-contract.ts'

const loaderScript = document.currentScript

if (!(loaderScript instanceof HTMLScriptElement) || !loaderScript.src) {
  throw new Error('FWA loader requires a same-origin script src')
}

bootstrap(loaderScript)

function bootstrap(script: HTMLScriptElement) {
  const fwa = readOrCreateGlobal()
  if (fwa.localEdge) {
    window.dispatchEvent(new CustomEvent(fwaGlobalReadyEventName))
    return
  }

  const paths = Object.freeze(
    deriveFwaLoaderPaths(
      new URL(script.src, window.location.href),
      window.location.origin,
    ),
  )
  const runtime = createLocalEdgeDocumentRuntime(
    {
      ...paths,
      updateCheck: localEdgeConfig.updateCheck,
    },
    {
      registerServiceWorker: () =>
        navigator.serviceWorker.register(paths.workerPath, {
          scope: paths.scopePath,
        }),
      replaceServiceWorker: async () => {
        const registrations = await navigator.serviceWorker.getRegistrations()
        const ownedRegistrations = registrations.filter(
          (registration) =>
            new URL(registration.scope).pathname === paths.scopePath,
        )
        await Promise.all(
          ownedRegistrations.map((registration) => registration.unregister()),
        )
        const registration = await navigator.serviceWorker.register(
          paths.workerPath,
          {
            scope: paths.scopePath,
          },
        )
        const pendingWorker = registration.installing ?? registration.waiting
        pendingWorker?.postMessage({ type: fwaTakeoverMessageType })
        return registration
      },
      scheduler: {
        now: () => performance.now(),
        isVisible: () => document.visibilityState === 'visible',
        setInterval: (callback, intervalMs) =>
          window.setInterval(callback, intervalMs),
        clearInterval: (handle) => window.clearInterval(handle),
        onVisibilityChange: (callback) => {
          const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
              callback()
            }
          }
          document.addEventListener(
            'visibilitychange',
            handleVisibilityChange,
          )
          return () => {
            document.removeEventListener(
              'visibilitychange',
              handleVisibilityChange,
            )
          }
        },
        onOnline: (callback) => {
          window.addEventListener('online', callback)
          return () => {
            window.removeEventListener('online', callback)
          }
        },
      },
    },
  )
  let localEdge: FwaLocalEdgeApi
  const debug = createFwaDebugRuntime(() => localEdge)
  localEdge = Object.freeze({
    paths,
    debug,
    getState: runtime.getState,
    subscribe: runtime.subscribe,
    revalidate: runtime.revalidate,
    setUpdateCheck: runtime.setUpdateCheck,
    applyUpdate: runtime.applyUpdate,
    reset: runtime.reset,
    networkUrl: runtime.networkUrl,
    openNetwork: () => window.location.assign(runtime.networkUrl()),
  })

  fwa.version = fwaLoaderVersion
  fwa.localEdge = localEdge
  debug.start()
  installCommandQueue(fwa, localEdge)
  runtime.start()
  window.dispatchEvent(new CustomEvent(fwaGlobalReadyEventName))
}

function readOrCreateGlobal(): FwaGlobal {
  const existing = window.__fwa
  if (existing && Array.isArray(existing.q)) {
    return existing
  }

  const value: FwaGlobal = { q: [] }
  Object.defineProperty(window, '__fwa', {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  })
  return value
}

function installCommandQueue(fwa: FwaGlobal, localEdgeApi: FwaLocalEdgeApi) {
  const queuedCommands: unknown[] = [...fwa.q]
  const nativePush = fwa.q.push.bind(fwa.q)

  fwa.q.push = (...commands: FwaQueuedCommand[]) => {
    const length = nativePush(...commands)
    for (const command of commands) {
      dispatchCommand(localEdgeApi, command)
    }
    return length
  }

  for (const command of queuedCommands) {
    dispatchCommand(localEdgeApi, command)
  }
}

function dispatchCommand(localEdgeApi: FwaLocalEdgeApi, command: unknown) {
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
