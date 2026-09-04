import type {
  LocalEdgeRevalidationProgress,
  LocalEdgeRevalidationResult,
  LocalEdgeSnapshot,
} from '../release.ts'
import {
  defaultUpdateCheckIntervalMinutes,
  fwaRevalidationCommittedMessageType,
  fwaRevalidationProgressMessageType,
  isValidUpdateCheckIntervalMinutes,
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
  LocalEdgeUpdateCheckCommandConfig,
} from './loader-contract.ts'

interface LocalEdgeDocumentConfig {
  scopePath: string
  workerPath: string
  controlPrefix: string
  updateCheck?: LocalEdgeUpdateCheckConfig
}

export interface LocalEdgeUpdateCheckConfig {
  enabled: boolean
  intervalMinutes: number
}

interface LocalEdgeRegistrationOwner {
  registerServiceWorker(): Promise<ServiceWorkerRegistration>
  replaceServiceWorker(): Promise<ServiceWorkerRegistration>
}

export interface LocalEdgeDocumentScheduler {
  now(): number
  isVisible(): boolean
  setInterval(callback: () => void, intervalMs: number): number
  clearInterval(handle: number): void
  onVisibilityChange(callback: () => void): () => void
  onOnline(callback: () => void): () => void
}

interface LocalEdgeDocumentDependencies extends LocalEdgeRegistrationOwner {
  scheduler: LocalEdgeDocumentScheduler
}

interface LocalEdgeDocumentRuntime {
  getState(): LocalEdgeClientState
  subscribe(listener: LocalEdgeStateListener): () => void
  start(): void
  stop(): void
  revalidate(): Promise<LocalEdgeRevalidationOutcome>
  setUpdateCheck(updateCheck: LocalEdgeUpdateCheckCommandConfig): void
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
  dependencies: LocalEdgeDocumentDependencies,
): LocalEdgeDocumentRuntime {
  const registrationOwner = dependencies
  const scheduler = dependencies.scheduler
  const controlPaths = localEdgeControlPathsFor(config)
  const listeners = new Set<LocalEdgeStateListener>()
  let state = initialState
  let started = false
  let stopped = false
  let scheduledChecksStarted = false
  let revalidationInFlight: Promise<LocalEdgeRevalidationOutcome> | undefined
  let revalidationVisible = false
  let revalidationIdleMessage: string | undefined
  let revalidationActivityMessage: string | undefined
  let updateCheck = config.updateCheck
  let intervalHandle: number | undefined
  let lastCheckAttemptAt: number | undefined
  let unsubscribeVisibility: (() => void) | undefined
  let unsubscribeOnline: (() => void) | undefined

  const clearScheduledCheckTimer = () => {
    if (intervalHandle === undefined) {
      return
    }
    scheduler.clearInterval(intervalHandle)
    intervalHandle = undefined
  }

  const scheduleScheduledCheckTimer = () => {
    clearScheduledCheckTimer()
    if (stopped || !scheduledChecksStarted || !updateCheck?.enabled) {
      return
    }
    intervalHandle = scheduler.setInterval(
      () => {
        if (scheduler.isVisible()) {
          maybeRevalidate()
        }
      },
      updateCheck.intervalMinutes * 60 * 1000,
    )
  }

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
    const revalidationProgress = snapshot.revalidation
    publish(
      snapshot.mode === 'disabled'
        ? {
            phase: 'network-only',
            controlled: true,
            revalidating: false,
            updateAvailable: false,
            ...(revalidationProgress
              ? { revalidationProgress }
              : undefined),
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
              ...(revalidationProgress
                ? { revalidationProgress }
                : undefined),
              message:
                warning ??
                '本地 release 已提交，navigation 可以从 Cache Storage 启动。',
            }
          : {
              phase: 'network-only',
              controlled: true,
              revalidating: false,
              updateAvailable: false,
              ...(revalidationProgress
                ? { revalidationProgress }
                : undefined),
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

  // A kernel commit broadcast reaches every controlled window client, including
  // the document whose own revalidate just committed. The pull must not relabel
  // the running document: keep the loaded releaseId and only surface a kernel
  // active release that differs from it as an available update.
  const publishCommittedSnapshot = async () => {
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
    const { revalidationProgress: _droppedProgress, ...restState } = state
    void _droppedProgress
    if (snapshot.mode !== 'active') {
      publishSnapshot(snapshot)
      return
    }
    if (!snapshot.release) {
      publish({
        ...restState,
        revalidating: false,
        updateAvailable: false,
        availableReleaseId: undefined,
        message: 'Local Edge 已激活，但还没有可用 release。',
      })
      return
    }

    const activeReleaseId = snapshot.release.releaseId
    if (!restState.releaseId) {
      publishSnapshot(snapshot)
      return
    }
    if (restState.releaseId === activeReleaseId) {
      publish({
        ...restState,
        revalidating: false,
        updateAvailable: false,
        availableReleaseId: undefined,
      })
      return
    }

    publish({
      ...restState,
      phase: 'ready',
      controlled: true,
      revalidating: false,
      availableReleaseId: activeReleaseId,
      updateAvailable: true,
      message:
        restState.availableReleaseId === activeReleaseId &&
        restState.updateAvailable
          ? restState.message
          : '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。',
    })
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

  const runRevalidation = async () => {
    const result = await requestRevalidation()
    if (!result) {
      if (revalidationVisible) {
        await readAndPublishSnapshot(
          'Release revalidation failed; the last committed release remains active.',
        )
      }
      return 'failed' as const
    }
    if (result.status === 'updated') {
      const availableReleaseId = result.release?.releaseId
      if (availableReleaseId && availableReleaseId !== state.releaseId) {
        publish(
          !revalidationVisible
            ? {
                ...state,
                availableReleaseId,
                updateAvailable: true,
              }
            : {
                ...state,
                phase: 'ready',
                controlled: true,
                availableReleaseId,
                updateAvailable: true,
                message:
                  '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。',
              },
        )
        return 'updated' as const
      }
    }
    if (result.status === 'disabled') {
      if (revalidationVisible) {
        window.location.reload()
      }
      return 'disabled' as const
    }
    if (
      !revalidationVisible &&
      (result.status === 'installed' || result.status === 'enabled') &&
      result.release
    ) {
      publishSnapshot({
        localEdgeEnabled: true,
        mode: 'active',
        release: result.release,
      })
    } else if (result.status !== 'current' && revalidationVisible) {
      await readAndPublishSnapshot()
    }
    return result.status === 'disabled-current'
      ? ('disabled' as const)
      : ('current' as const)
  }

  const showRevalidationActivity = () => {
    if (revalidationVisible) {
      return
    }
    revalidationVisible = true
    revalidationIdleMessage = state.message
    revalidationActivityMessage = state.releaseId
      ? '正在检查并下载新 release，当前版本继续可用…'
      : '正在下载初始 release…'
    publish({
      ...state,
      revalidating: true,
      message: revalidationActivityMessage,
    })
  }

  const revalidate = (silent = false) => {
    if (revalidationInFlight) {
      if (!silent) {
        showRevalidationActivity()
      }
      return revalidationInFlight
    }

    lastCheckAttemptAt = scheduler.now()
    if (!silent) {
      showRevalidationActivity()
    }
    revalidationInFlight = runRevalidation().finally(() => {
      if (revalidationVisible && state.revalidating) {
        publish({
          ...state,
          revalidating: false,
          message:
            state.message === revalidationActivityMessage
              ? (revalidationIdleMessage ?? state.message)
              : state.message,
        })
      }
      revalidationInFlight = undefined
      revalidationVisible = false
      revalidationIdleMessage = undefined
      revalidationActivityMessage = undefined
    })
    return revalidationInFlight
  }

  const maybeRevalidate = () => {
    if (
      !scheduledChecksStarted ||
      !updateCheck?.enabled ||
      stopped ||
      revalidationInFlight
    ) {
      return
    }
    if (
      lastCheckAttemptAt !== undefined &&
      scheduler.now() - lastCheckAttemptAt <
        updateCheck.intervalMinutes * 60 * 1000
    ) {
      return
    }
    void revalidate(true).catch(publishRuntimeError)
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
    startScheduledChecks()
  }

  const handleControllerChange = () => {
    void readAndPublishSnapshot().catch(publishRuntimeError)
  }

  const handleKernelMessage = (event: MessageEvent) => {
    const source = event.source
    if (!source || typeof source !== 'object') {
      return
    }
    const sourceScriptUrl = (source as { scriptURL?: unknown }).scriptURL
    if (
      typeof sourceScriptUrl !== 'string' ||
      new URL(sourceScriptUrl).pathname !== config.workerPath
    ) {
      return
    }
    const controller = navigator.serviceWorker?.controller
    if (controller && controller.scriptURL !== sourceScriptUrl) {
      return
    }
    if (typeof event.data !== 'object' || event.data === null) {
      return
    }

    const payload = event.data as Record<string, unknown>
    if (payload.type === fwaRevalidationProgressMessageType) {
      const progress = revalidationProgressFromMessage(payload)
      if (!progress) {
        return
      }
      publish({
        ...state,
        revalidationProgress: progress,
      })
      return
    }
    if (payload.type === fwaRevalidationCommittedMessageType) {
      void publishCommittedSnapshot().catch(publishRuntimeError)
    }
  }

  const handleVisibilityChange = () => {
    maybeRevalidate()
  }

  const handleOnline = () => {
    maybeRevalidate()
  }

  const startScheduledChecks = () => {
    if (scheduledChecksStarted || stopped) {
      return
    }
    scheduledChecksStarted = true
    unsubscribeVisibility = scheduler.onVisibilityChange(handleVisibilityChange)
    unsubscribeOnline = scheduler.onOnline(handleOnline)
    scheduleScheduledCheckTimer()
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
    navigator.serviceWorker?.addEventListener('message', handleKernelMessage)
    void startRuntime().catch(publishRuntimeError)
  }

  const stop = () => {
    if (stopped) {
      return
    }
    stopped = true
    scheduledChecksStarted = false
    navigator.serviceWorker?.removeEventListener(
      'controllerchange',
      handleControllerChange,
    )
    navigator.serviceWorker?.removeEventListener(
      'message',
      handleKernelMessage,
    )
    unsubscribeVisibility?.()
    unsubscribeOnline?.()
    clearScheduledCheckTimer()
  }

  const setUpdateCheck = (nextUpdateCheck: LocalEdgeUpdateCheckCommandConfig) => {
    updateCheck = normalizeUpdateCheck(nextUpdateCheck, updateCheck)
    scheduleScheduledCheckTimer()
    if (updateCheck.enabled) {
      maybeRevalidate()
    }
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
    stop,
    revalidate,
    setUpdateCheck,
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

function revalidationProgressFromMessage(
  payload: Record<string, unknown>,
): LocalEdgeRevalidationProgress | undefined {
  const { releaseId, completedAssets, totalAssets } = payload
  if (
    typeof releaseId !== 'string' ||
    !Number.isSafeInteger(completedAssets) ||
    !Number.isSafeInteger(totalAssets) ||
    (completedAssets as number) < 0 ||
    (totalAssets as number) < 1 ||
    (completedAssets as number) > (totalAssets as number)
  ) {
    return undefined
  }
  return {
    releaseId,
    completedAssets: completedAssets as number,
    totalAssets: totalAssets as number,
  }
}

function normalizeUpdateCheck(
  value: LocalEdgeUpdateCheckCommandConfig,
  current?: LocalEdgeUpdateCheckConfig,
): LocalEdgeUpdateCheckConfig {
  const enabled = value.enabled ?? current?.enabled ?? true
  const intervalMinutes =
    value.intervalMinutes ??
    current?.intervalMinutes ??
    defaultUpdateCheckIntervalMinutes
  if (
    typeof enabled !== 'boolean' ||
    !isValidUpdateCheckIntervalMinutes(intervalMinutes)
  ) {
    throw new TypeError('Local Edge update check config is invalid')
  }
  return { enabled, intervalMinutes }
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
