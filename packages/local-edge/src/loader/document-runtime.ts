import type {
  LocalEdgeRevalidationResult,
  LocalEdgeSnapshot,
} from '../release.ts'
import {
  localEdgeControlPathsFor,
  fwaKernelProbeHeaderName,
  fwaKernelProtocolHeaderName,
  fwaKernelProtocolVersion,
  pathWithLocalEdgeNavigationMode,
  localEdgeNavigationModeFor,
} from '../config-contract.ts'
import type {
  LocalEdgeClientState,
  LocalEdgeRevalidationOutcome,
  LocalEdgeStateListener,
} from './loader-contract.ts'

interface LocalEdgeDocumentConfig {
  scopePath: string
  workerPath: string
  controlPrefix: string
}

interface LocalEdgeRegistrationOwner {
  registerServiceWorker(): Promise<ServiceWorkerRegistration>
  replaceServiceWorker(): Promise<ServiceWorkerRegistration>
}

interface LocalEdgeDocumentRuntime {
  getState(): LocalEdgeClientState
  subscribe(listener: LocalEdgeStateListener): () => void
  start(): void
  revalidate(): Promise<LocalEdgeRevalidationOutcome>
  applyUpdate(): boolean
  reset(): Promise<void>
  networkUrl(currentUrl?: string): string
}

const initialState: LocalEdgeClientState = {
  phase: 'starting',
  controlled: false,
  revalidating: false,
  updateAvailable: false,
  message: '正在读取 Local Edge 状态…',
}

export function createLocalEdgeDocumentRuntime(
  config: LocalEdgeDocumentConfig,
  registrationOwner: LocalEdgeRegistrationOwner,
): LocalEdgeDocumentRuntime {
  const controlPaths = localEdgeControlPathsFor(config)
  const listeners = new Set<LocalEdgeStateListener>()
  let state = initialState
  let started = false
  let revalidationInFlight: Promise<LocalEdgeRevalidationOutcome> | undefined

  const publish = (nextState: LocalEdgeClientState) => {
    state = nextState
    for (const listener of listeners) {
      publishToListener(listener, state)
    }
  }

  const fetchKernelSnapshot = async () => {
    if (!navigator.serviceWorker.controller) {
      return undefined
    }

    const response = await fetch(controlPaths.state, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`runtime snapshot returned ${response.status}`)
    }
    const kernelProtocolVersion = Number(
      response.headers.get(fwaKernelProtocolHeaderName),
    )
    if (
      response.headers.get(fwaKernelProbeHeaderName) !== config.workerPath ||
      !Number.isSafeInteger(kernelProtocolVersion) ||
      kernelProtocolVersion < fwaKernelProtocolVersion
    ) {
      throw new Error('active Service Worker does not expose the FWA kernel API')
    }
    const snapshot = await response.json()
    if (!isLocalEdgeSnapshot(snapshot)) {
      throw new Error('FWA kernel returned an invalid snapshot')
    }
    return snapshot
  }

  const publishSnapshot = (snapshot: LocalEdgeSnapshot, warning?: string) => {
    publish(
      snapshot.mode === 'disabled'
        ? {
            phase: 'network-only',
            controlled: true,
            revalidating: false,
            updateAvailable: false,
            message:
              'Local Edge 已由 release flag 禁用，当前使用 network baseline。',
          }
        : snapshot.mode === 'active' && snapshot.release
          ? {
              phase: 'ready',
              controlled: true,
              releaseId: snapshot.release.releaseId,
              revalidating: false,
              updateAvailable: false,
              message:
                warning ??
                '本地 release 已提交，navigation 可以从 Cache Storage 启动。',
            }
          : {
              phase: 'network-only',
              controlled: true,
              revalidating: false,
              updateAvailable: false,
              message: 'Local Edge 已激活，但还没有可用 release。',
            },
    )
  }

  const readAndPublishSnapshot = async (warning?: string) => {
    const snapshot = await fetchKernelSnapshot()
    if (!snapshot) {
      publish({
        phase: 'network-only',
        controlled: false,
        revalidating: false,
        updateAvailable: false,
        message: '页面尚未受 Local Edge 控制，继续使用 network baseline。',
      })
      return
    }

    publishSnapshot(snapshot, warning)
  }

  const requestRevalidation = async () => {
    try {
      const response = await fetch(controlPaths.revalidate, {
        method: 'POST',
        headers: { 'X-FWA-Control': 'revalidate' },
      })
      if (!response.ok) {
        return undefined
      }

      return (await response.json()) as LocalEdgeRevalidationResult
    } catch {
      return undefined
    }
  }

  const finishRevalidation = async () => {
    const result = await requestRevalidation()
    if (!result) {
      await readAndPublishSnapshot(
        'Release revalidation failed; the last committed release remains active.',
      )
      return 'failed' as const
    }
    if (result.status === 'updated') {
      const availableReleaseId = result.release?.releaseId
      if (availableReleaseId && availableReleaseId !== state.releaseId) {
        publish({
          ...state,
          phase: 'ready',
          controlled: true,
          availableReleaseId,
          updateAvailable: true,
          message:
            '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。',
        })
        return 'updated' as const
      }
    }
    if (result.status === 'disabled') {
      window.location.reload()
      return 'disabled' as const
    }
    if (result.status !== 'current') {
      await readAndPublishSnapshot()
    }
    return result.status === 'disabled-current'
      ? ('disabled' as const)
      : ('current' as const)
  }

  const revalidate = () => {
    if (!revalidationInFlight) {
      const idleMessage = state.message
      const activityMessage = state.releaseId
        ? '正在检查并下载新 release，当前版本继续可用…'
        : '正在下载初始 release…'
      publish({
        ...state,
        revalidating: true,
        message: activityMessage,
      })
      revalidationInFlight = finishRevalidation().finally(() => {
        if (state.revalidating) {
          publish({
            ...state,
            revalidating: false,
            message:
              state.message === activityMessage ? idleMessage : state.message,
          })
        }
        revalidationInFlight = undefined
      })
    }
    return revalidationInFlight
  }

  const publishRuntimeError = (error: unknown) => {
    publish({
      phase: 'error',
      controlled: Boolean(navigator.serviceWorker.controller),
      revalidating: false,
      updateAvailable: false,
      message:
        error instanceof Error ? error.message : 'Local Edge runtime failed',
    })
  }

  const startRuntime = async () => {
    if (!('serviceWorker' in navigator)) {
      publish({
        phase: 'unsupported',
        controlled: false,
        revalidating: false,
        updateAvailable: false,
        message: '当前浏览器不支持 Service Worker，继续使用 network baseline。',
      })
      return
    }

    const navigationMode = localEdgeNavigationModeFor(new URL(window.location.href))
    if (navigationMode === 'network') {
      publish({
        phase: 'network-only',
        controlled: Boolean(navigator.serviceWorker.controller),
        revalidating: false,
        updateAvailable: false,
        message: '当前页面经显式 network open 进入，不重新注册 Local Edge。',
      })
      return
    }
    if (navigationMode === 'reset') {
      window.location.replace(networkUrl())
      return
    }

    if (navigator.serviceWorker.controller) {
      let snapshot: LocalEdgeSnapshot | undefined
      try {
        snapshot = await fetchKernelSnapshot()
      } catch {
        snapshot = undefined
      }

      if (!snapshot) {
        if (takeoverWasAttempted(config.workerPath)) {
          throw new Error(
            'FWA kernel API is still unavailable after Service Worker takeover',
          )
        }
        markTakeoverAttempt(config.workerPath)
        publish({
          phase: 'registering',
          controlled: true,
          revalidating: false,
          updateAvailable: false,
          message: '旧 Service Worker 不支持 FWA kernel API，正在接管 scope…',
        })
        const registration = await registrationOwner.replaceServiceWorker()
        assertRegistrationScope(registration, config.scopePath)
        await waitForRegistrationActivation(registration, config.workerPath)
        window.location.reload()
        return
      }

      clearTakeoverAttempt(config.workerPath)
      publishSnapshot(snapshot)
    } else {
      publish({
        phase: 'registering',
        controlled: false,
        revalidating: false,
        updateAvailable: false,
        message: '正在建立 Local Edge 控制…',
      })
      const registration = await registrationOwner.registerServiceWorker()
      assertRegistrationScope(registration, config.scopePath)
      await waitForRegistrationActivation(registration, config.workerPath)
      await waitForDocumentControl(config.workerPath)
    }

    await revalidate()
  }

  const handleControllerChange = () => {
    void readAndPublishSnapshot().catch(publishRuntimeError)
  }

  const start = () => {
    if (started) {
      return
    }
    started = true
    navigator.serviceWorker?.addEventListener(
      'controllerchange',
      handleControllerChange,
    )
    void startRuntime().catch(publishRuntimeError)
  }

  const networkUrl = (currentUrl = window.location.href) =>
    pathWithLocalEdgeNavigationMode(
      new URL(currentUrl, window.location.origin),
      'network',
    )

  const applyUpdate = () => {
    if (!state.updateAvailable || !state.availableReleaseId) {
      return false
    }
    window.location.reload()
    return true
  }

  const reset = async () => {
    const currentUrl = new URL(window.location.href)
    const response = await fetch(
      pathWithLocalEdgeNavigationMode(currentUrl, 'reset'),
      {
        method: 'POST',
        headers: { 'X-FWA-Control': 'reset' },
      },
    )
    if (!response.ok) {
      throw new Error(`reset returned ${response.status}`)
    }
    window.location.replace(
      pathWithLocalEdgeNavigationMode(currentUrl, 'network'),
    )
  }

  return {
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener)
      publishToListener(listener, state)
      return () => listeners.delete(listener)
    },
    start,
    revalidate,
    applyUpdate,
    reset,
    networkUrl,
  }
}

function assertRegistrationScope(
  registration: ServiceWorkerRegistration,
  scopePath: string,
) {
  if (new URL(registration.scope).pathname !== scopePath) {
    throw new Error(
      'Host returned a Service Worker registration for the wrong scope',
    )
  }
}

function isLocalEdgeSnapshot(value: unknown): value is LocalEdgeSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.localEdgeEnabled === 'boolean' &&
    (snapshot.mode === 'active' ||
      snapshot.mode === 'disabled' ||
      snapshot.mode === 'network-only')
  )
}

function takeoverStorageKey(workerPath: string) {
  return `__fwa:takeover:${workerPath}`
}

function takeoverWasAttempted(workerPath: string) {
  try {
    return sessionStorage.getItem(takeoverStorageKey(workerPath)) === '1'
  } catch {
    return true
  }
}

function markTakeoverAttempt(workerPath: string) {
  sessionStorage.setItem(takeoverStorageKey(workerPath), '1')
}

function clearTakeoverAttempt(workerPath: string) {
  try {
    sessionStorage.removeItem(takeoverStorageKey(workerPath))
  } catch {
    // A successful capability probe is sufficient when storage is unavailable.
  }
}

function publishToListener(
  listener: LocalEdgeStateListener,
  state: LocalEdgeClientState,
) {
  try {
    listener({ ...state })
  } catch (error) {
    queueMicrotask(() => {
      throw error
    })
  }
}

async function waitForRegistrationActivation(
  registration: ServiceWorkerRegistration,
  workerPath: string,
) {
  if (workerMatchesPath(registration.active, workerPath)) {
    return
  }

  const pendingWorker = registration.installing ?? registration.waiting
  if (!pendingWorker) {
    throw new Error(
      'Host registration has no matching active or pending Service Worker',
    )
  }
  if (!workerMatchesPath(pendingWorker, workerPath)) {
    throw new Error('Host registration is installing an unexpected worker')
  }

  await new Promise<void>((resolve, reject) => {
    const handleStateChange = () => {
      if (
        workerMatchesPath(registration.active, workerPath) ||
        pendingWorker.state === 'activated'
      ) {
        pendingWorker.removeEventListener('statechange', handleStateChange)
        resolve()
      } else if (pendingWorker.state === 'redundant') {
        pendingWorker.removeEventListener('statechange', handleStateChange)
        reject(
          new Error('Host Service Worker became redundant before activation'),
        )
      }
    }

    pendingWorker.addEventListener('statechange', handleStateChange)
    handleStateChange()
  })
}

function workerMatchesPath(
  worker: ServiceWorker | null,
  workerPath: string,
) {
  return worker !== null && new URL(worker.scriptURL).pathname === workerPath
}

async function waitForDocumentControl(workerPath: string) {
  if (workerMatchesPath(navigator.serviceWorker.controller, workerPath)) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const handleControllerChange = () => {
      const controller = navigator.serviceWorker.controller
      if (!controller) {
        return
      }

      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      )
      if (workerMatchesPath(controller, workerPath)) {
        resolve()
      } else {
        reject(new Error('Host activated an unexpected Service Worker'))
      }
    }

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      handleControllerChange,
    )
    handleControllerChange()
  })
}
