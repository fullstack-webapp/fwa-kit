import type {
  LocalEdgeRevalidationProgress,
  LocalEdgeRevalidationResult,
  LocalEdgeSnapshot,
} from '../release.ts'
import {
  isKernelObservationIdentity,
  isKernelRevalidationProgress,
  isOrderedLocalEdgeSnapshot,
  isOrderedRevalidationResult,
  reduceRevalidationObservation,
  type OrderedLocalEdgeRevalidationResult,
  type OrderedLocalEdgeSnapshot,
  type RevalidationObservation,
  type RevalidationObservationCursor,
  type RevalidationObservationRejection,
} from '../revalidation-observation.ts'
import {
  defaultUpdateCheckIntervalMinutes,
  fwaRevalidationCommittedMessageType,
  fwaRevalidationFailedMessageType,
  fwaRevalidationProgressMessageType,
  isValidUpdateCheckIntervalMinutes,
  fwaMinimumKernelProtocolVersion,
  fwaOrderedProgressProtocolVersion,
  fwaKernelProbeHeaderName,
  fwaKernelProtocolHeaderName,
  localEdgeControlPathsFor,
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

type KernelSnapshotRead =
  | { kind: 'uncontrolled' }
  | { kind: 'incompatible' }
  | { kind: 'unavailable'; error: Error }
  | { kind: 'stale-controller' }
  | { kind: 'legacy'; snapshot: LocalEdgeSnapshot }
  | { kind: 'ordered'; snapshot: OrderedLocalEdgeSnapshot }

type KernelRevalidationRead =
  | { kind: 'failed' }
  | { kind: 'stale-controller' }
  | { kind: 'legacy'; result: LocalEdgeRevalidationResult }
  | { kind: 'ordered'; result: OrderedLocalEdgeRevalidationResult }

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

const maxSnapshotPullAttempts = 8

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
  let explicitNetworkOpen = false
  let settlePullChain: Promise<void> = Promise.resolve()
  let observationCursor: RevalidationObservationCursor = { phase: 'unknown' }
  let controllerGeneration = 0
  let orderedProgressEnabled = false
  let lastKernelMode: LocalEdgeSnapshot['mode'] | undefined
  let snapshotPullQueued = false
  let queuedSnapshotWarning: string | undefined
  let queuedSnapshotFailureVisible = false
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
  const cursorProgress = () =>
    observationCursor.phase === 'running'
      ? observationCursor.progress
      : undefined

  const publishCursorProgress = () => {
    const { revalidationProgress: _previous, ...rest } = state
    void _previous
    const progress = cursorProgress()
    publish({ ...rest, ...(progress ? { revalidationProgress: progress } : undefined) })
  }

  const fetchKernelSnapshot = async (): Promise<KernelSnapshotRead> => {
    const controller = navigator.serviceWorker.controller
    if (!controller) return { kind: 'uncontrolled' }
    const generation = controllerGeneration
    let response: Response
    try {
      response = await fetch(controlPaths.state, { cache: 'no-store' })
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error : new Error('runtime snapshot failed') }
    }
    if (generation !== controllerGeneration || controller !== navigator.serviceWorker.controller) {
      return { kind: 'stale-controller' }
    }
    const protocolVersion = Number(response.headers.get(fwaKernelProtocolHeaderName))
    if (
      response.headers.get(fwaKernelProbeHeaderName) !== config.workerPath ||
      !Number.isSafeInteger(protocolVersion) ||
      protocolVersion < fwaMinimumKernelProtocolVersion
    ) return { kind: 'incompatible' }
    if (!response.ok) {
      return { kind: 'unavailable', error: new Error(`runtime snapshot returned ${response.status}`) }
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      return { kind: 'unavailable', error: new Error('FWA kernel returned unreadable snapshot JSON') }
    }
    if (generation !== controllerGeneration || controller !== navigator.serviceWorker.controller) {
      return { kind: 'stale-controller' }
    }
    if (protocolVersion >= fwaOrderedProgressProtocolVersion) {
      return isOrderedLocalEdgeSnapshot(value)
        ? { kind: 'ordered', snapshot: value }
        : { kind: 'unavailable', error: new Error('FWA kernel returned an invalid ordered snapshot') }
    }
    return isLocalEdgeSnapshot(value)
      ? { kind: 'legacy', snapshot: value }
      : { kind: 'unavailable', error: new Error('FWA kernel returned an invalid snapshot') }
  }

  const publishStartupSnapshot = (
    snapshot: LocalEdgeSnapshot,
    progress?: LocalEdgeRevalidationProgress,
    warning?: string,
  ) => {
    publish(
      snapshot.mode === 'disabled'
        ? {
            phase: 'network-only', controlled: true, revalidating: false,
            updateAvailable: false,
            ...(progress ? { revalidationProgress: progress } : undefined),
            message: 'Local Edge 已由 release flag 禁用，当前使用 network baseline。',
          }
        : snapshot.mode === 'active' && snapshot.release
          ? {
              phase: 'ready', controlled: true,
              releaseId: snapshot.release.releaseId, revalidating: false,
              updateAvailable: false,
              ...(progress ? { revalidationProgress: progress } : undefined),
              message: warning ?? '本地 release 已提交，navigation 可以从 Cache Storage 启动。',
            }
          : {
              phase: 'network-only', controlled: true, revalidating: false,
              updateAvailable: false,
              ...(progress ? { revalidationProgress: progress } : undefined),
              message: 'Local Edge 已激活，但还没有可用 release。',
            },
    )
  }

  const publishSettledSnapshotValue = (
    snapshot: LocalEdgeSnapshot,
    progress?: LocalEdgeRevalidationProgress,
    warning?: string,
  ) => {
    const { revalidationProgress: _previous, ...restState } = state
    void _previous
    const publishSettled = (value: LocalEdgeClientState) =>
      publish({ ...value, ...(progress ? { revalidationProgress: progress } : undefined) })

    if (snapshot.mode !== 'active') {
      const { releaseId: _droppedReleaseId, ...restWithoutReleaseId } = restState
      void _droppedReleaseId
      publishSettled({
        ...restWithoutReleaseId, phase: 'network-only', controlled: true,
        updateAvailable: false, availableReleaseId: undefined,
        message: warning ?? (snapshot.mode === 'disabled'
          ? 'Local Edge 已由 release flag 禁用，当前使用 network baseline。'
          : 'Local Edge 已激活，但还没有可用 release。'),
      })
      return
    }
    if (!snapshot.release) {
      publishSettled({
        ...restState, updateAvailable: false, availableReleaseId: undefined,
        message: warning ?? 'Local Edge 已激活，但还没有可用 release。',
      })
      return
    }
    const activeReleaseId = snapshot.release.releaseId
    if (!restState.releaseId) {
      publishSettled({
        ...restState, phase: 'ready', controlled: true, releaseId: activeReleaseId,
        updateAvailable: false, availableReleaseId: undefined,
        message: warning ?? '本地 release 已提交，navigation 可以从 Cache Storage 启动。',
      })
      return
    }
    if (restState.releaseId === activeReleaseId) {
      publishSettled({
        ...restState, phase: 'ready', controlled: true,
        updateAvailable: false, availableReleaseId: undefined,
        ...(warning === undefined ? undefined : { message: warning }),
      })
      return
    }
    publishSettled({
      ...restState, phase: 'ready', controlled: true,
      availableReleaseId: activeReleaseId, updateAvailable: true,
      message: warning ?? (restState.availableReleaseId === activeReleaseId && restState.updateAvailable
        ? restState.message
        : '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。'),
    })
  }

  const applySnapshotRead = (
    read: Extract<KernelSnapshotRead, { kind: 'legacy' | 'ordered' }>,
    projection: 'startup' | 'settled',
    warning?: string,
  ): 'applied' | RevalidationObservationRejection => {
    if (read.kind === 'legacy') {
      orderedProgressEnabled = false
      lastKernelMode = read.snapshot.mode
      observationCursor = { phase: 'unknown' }
      if (projection === 'startup') publishStartupSnapshot(read.snapshot, undefined, warning)
      else publishSettledSnapshotValue(read.snapshot, undefined, warning)
      return 'applied'
    }
    orderedProgressEnabled = true
    const decision = reduceRevalidationObservation(observationCursor, {
      kind: 'snapshot', identity: read.snapshot, progress: read.snapshot.revalidation,
    })
    if (!decision.accepted) return decision.rejection ?? 'conflict'
    lastKernelMode = read.snapshot.mode
    observationCursor = decision.cursor
    const progress = cursorProgress()
    if (projection === 'startup') publishStartupSnapshot(read.snapshot, progress, warning)
    else publishSettledSnapshotValue(read.snapshot, progress, warning)
    return 'applied'
  }

  const publishSettledSnapshot = async (
    warning?: string,
  ): Promise<'published' | 'deferred'> => {
    if (explicitNetworkOpen) {
      const { revalidationProgress: _dropped, ...rest } = state
      void _dropped
      publish(warning === undefined ? rest : { ...rest, message: warning })
      return 'published'
    }
    for (let attempt = 0; attempt < maxSnapshotPullAttempts; attempt += 1) {
      const read = await fetchKernelSnapshot()
      if (read.kind === 'stale-controller') continue
      if (read.kind === 'uncontrolled') {
        publish({
          phase: 'network-only', controlled: false, revalidating: false,
          updateAvailable: false,
          message: warning ?? '页面尚未受 Local Edge 控制，继续使用 network baseline。',
        })
        return 'published'
      }
      if (read.kind === 'incompatible') throw new Error('active Service Worker does not expose the FWA kernel API')
      if (read.kind === 'unavailable') throw read.error
      const application = applySnapshotRead(read, 'settled', warning)
      if (application === 'applied') {
        return 'published'
      }
      if (application !== 'superseded') {
        // A conflict has already consumed this recovery read. Preserve the
        // established cursor rather than repeating a deterministic snapshot.
        return 'deferred'
      }
    }
    // A newer accepted observation already superseded every fetched snapshot,
    // or the controller changed while they were in flight. Preserve that newer
    // state; a terminal event or the next scheduled pull will settle it.
    return 'deferred'
  }

  const enqueueSnapshotRead = (
    warning?: string,
    publishFailure = true,
  ) => {
    queuedSnapshotWarning = warning
    queuedSnapshotFailureVisible ||= publishFailure
    if (snapshotPullQueued) return settlePullChain
    snapshotPullQueued = true
    settlePullChain = settlePullChain.then(async () => {
      const currentWarning = queuedSnapshotWarning
      const failureVisible = queuedSnapshotFailureVisible
      queuedSnapshotWarning = undefined
      queuedSnapshotFailureVisible = false
      snapshotPullQueued = false
      try {
        await publishSettledSnapshot(currentWarning)
      } catch (error) {
        if (failureVisible) {
          publishRuntimeError(error)
        }
      }
    })
    return settlePullChain
  }

  const requestRevalidation = async (): Promise<KernelRevalidationRead> => {
    const controller = navigator.serviceWorker.controller
    const generation = controllerGeneration
    try {
      const response = await fetch(controlPaths.revalidate, {
        method: 'POST', headers: { 'X-FWA-Control': 'revalidate' },
      })
      if (generation !== controllerGeneration || controller !== navigator.serviceWorker.controller) {
        return { kind: 'stale-controller' }
      }
      if (!response.ok) return { kind: 'failed' }
      const value: unknown = await response.json()
      if (
        generation !== controllerGeneration ||
        controller !== navigator.serviceWorker.controller
      ) {
        return { kind: 'stale-controller' }
      }
      const protocolVersion = Number(response.headers.get(fwaKernelProtocolHeaderName))
      const ordered =
        response.headers.get(fwaKernelProbeHeaderName) === config.workerPath &&
        Number.isSafeInteger(protocolVersion) &&
        protocolVersion >= fwaOrderedProgressProtocolVersion
      if (ordered || orderedProgressEnabled) {
        return isOrderedRevalidationResult(value)
          ? { kind: 'ordered', result: value }
          : { kind: 'failed' }
      }
      return isLocalEdgeRevalidationResult(value)
        ? { kind: 'legacy', result: value }
        : { kind: 'failed' }
    } catch {
      return { kind: 'failed' }
    }
  }

  const applyOrderedTerminalResult = (result: OrderedLocalEdgeRevalidationResult) => {
    if (
      result.attemptId === undefined || !result.release ||
      (result.status !== 'installed' && result.status !== 'repaired' && result.status !== 'updated')
    ) return
    const decision = reduceRevalidationObservation(observationCursor, {
      kind: 'terminal', identity: result,
      attempt: { attemptId: result.attemptId, releaseId: result.release.releaseId },
    })
    if (decision.accepted) {
      observationCursor = decision.cursor
      publishCursorProgress()
    } else if (decision.rejection !== 'superseded') {
      void enqueueSnapshotRead()
    }
  }

  const awaitAuthoritativePull = async () => {
    let releasePull!: (
      outcome: 'published' | 'deferred' | 'failed',
    ) => void
    const outcome = new Promise<'published' | 'deferred' | 'failed'>((resolve) => {
      releasePull = resolve
    })
    settlePullChain = settlePullChain.then(async () => {
      try {
        releasePull(await publishSettledSnapshot())
      } catch (error) {
        if (revalidationVisible) {
          publishRuntimeError(error)
        }
        releasePull('failed')
      }
    })
    return outcome
  }

  const runRevalidation = async () => {
    const read = await requestRevalidation()
    if (read.kind === 'failed' || read.kind === 'stale-controller') {
      if (revalidationVisible) {
        await enqueueSnapshotRead('Release revalidation failed; the last committed release remains active.')
      } else if (state.revalidationProgress) {
        await enqueueSnapshotRead(undefined, false)
      }
      return 'failed' as const
    }
    const orderedResult = read.kind === 'ordered'
    if (orderedResult) {
      applyOrderedTerminalResult(read.result)
      const pullOutcome = await awaitAuthoritativePull()
      if (pullOutcome === 'failed') return 'failed' as const
    }
    const result = read.result
    if (result.status === 'updated') {
      const availableReleaseId = result.release?.releaseId
      if (availableReleaseId && availableReleaseId !== state.releaseId) {
        if (
          !orderedResult &&
          (await awaitAuthoritativePull()) === 'failed'
        ) {
          return 'failed' as const
        }
        return state.updateAvailable ? ('updated' as const) : ('current' as const)
      }
    }
    if (result.status === 'disabled-current') {
      return 'disabled' as const
    }
    if (result.status === 'disabled') {
      if (
        !orderedResult &&
        (await awaitAuthoritativePull()) === 'failed'
      ) {
        return 'failed' as const
      }
      if (lastKernelMode !== 'disabled') return 'current' as const
      if (revalidationVisible) window.location.reload()
      return 'disabled' as const
    }
    if (
      !orderedResult &&
      !revalidationVisible &&
      (result.status === 'installed' || result.status === 'enabled' || result.status === 'repaired') &&
      result.release
    ) {
      await enqueueSnapshotRead(undefined, false)
    } else if (!orderedResult && result.status !== 'current' && revalidationVisible) {
      await enqueueSnapshotRead()
    } else if (!orderedResult && result.status === 'current' && state.revalidationProgress) {
      await enqueueSnapshotRead(undefined, revalidationVisible)
    }
    return 'current' as const
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
    if (stopped) {
      return
    }
    publish({
      phase: 'error',
      controlled: Boolean(navigator.serviceWorker?.controller),
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
      explicitNetworkOpen = true
      publish({
        phase: 'network-only',
        controlled: Boolean(navigator.serviceWorker?.controller),
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
      let snapshotPublished = false
      let startupError: unknown
      await (settlePullChain = settlePullChain.then(async () => {
        try {
          let read = await fetchKernelSnapshot()
          if (read.kind === 'stale-controller') {
            read = await fetchKernelSnapshot()
          }
          if (read.kind === 'incompatible') {
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
          if (read.kind === 'unavailable') {
            throw read.error
          }
          if (read.kind === 'uncontrolled' || read.kind === 'stale-controller') {
            throw new Error('Service Worker controller changed during startup')
          }
          clearTakeoverAttempt(config.workerPath)
          let application = applySnapshotRead(read, 'startup')
          snapshotPublished = application === 'applied'
          let startupReadWasOvertaken = application === 'superseded'
          if (!snapshotPublished) {
            const fresh = await fetchKernelSnapshot()
            startupReadWasOvertaken = false
            if (fresh.kind === 'legacy' || fresh.kind === 'ordered') {
              application = applySnapshotRead(fresh, 'startup')
              snapshotPublished = application === 'applied'
              startupReadWasOvertaken = application === 'superseded'
            } else if (fresh.kind === 'unavailable') {
              throw fresh.error
            } else if (fresh.kind === 'incompatible') {
              throw new Error('active Service Worker does not expose the FWA kernel API')
            } else {
              throw new Error('Service Worker controller changed during startup')
            }
          }
          if (!snapshotPublished && startupReadWasOvertaken) {
            // A current-controller message already supplied a newer kernel
            // observation. Continue startup so revalidation and scheduling can
            // recover the release projection without a finite retry race.
            snapshotPublished = true
          }
          if (!snapshotPublished) {
            throw new Error('FWA kernel observations did not converge')
          }
        } catch (error) {
          startupError = error
        }
      }))
      if (startupError !== undefined) {
        throw startupError
      }
      if (!snapshotPublished) {
        return
      }
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
    controllerGeneration += 1
    observationCursor = { phase: 'unknown' }
    orderedProgressEnabled = false
    lastKernelMode = undefined
    const { revalidationProgress: _dropped, ...rest } = state
    void _dropped
    publish(rest)
    void enqueueSnapshotRead()
  }

  const handleKernelMessage = (event: MessageEvent) => {
    const controller = navigator.serviceWorker?.controller
    if (!controller || event.source !== controller || explicitNetworkOpen) {
      return
    }
    if (typeof event.data !== 'object' || event.data === null) {
      return
    }

    const payload = event.data as Record<string, unknown>
    if (payload.type === fwaRevalidationProgressMessageType) {
      if (!isKernelRevalidationProgress(payload)) {
        void enqueueSnapshotRead()
        return
      }
      const decision = reduceRevalidationObservation(observationCursor, {
        kind: 'progress',
        identity: payload,
        attempt: {
          attemptId: payload.attemptId,
          releaseId: payload.releaseId,
          totalAssets: payload.totalAssets,
        },
        completedAssets: payload.completedAssets,
      })
      if (!decision.accepted) {
        if (decision.rejection !== 'superseded') {
          void enqueueSnapshotRead()
        }
        return
      }
      orderedProgressEnabled = true
      observationCursor = decision.cursor
      publishCursorProgress()
      return
    }
    if (
      payload.type === fwaRevalidationCommittedMessageType ||
      payload.type === fwaRevalidationFailedMessageType
    ) {
      const terminal = terminalObservationFromMessage(payload)
      if (!terminal) {
        void enqueueSnapshotRead()
        return
      }
      const decision = reduceRevalidationObservation(
        observationCursor,
        terminal,
      )
      if (decision.accepted) {
        orderedProgressEnabled = true
        observationCursor = decision.cursor
        publishCursorProgress()
      }
      if (decision.accepted || decision.rejection !== 'superseded') {
        void enqueueSnapshotRead()
      }
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
    void startRuntime().catch((error) => {
      publishRuntimeError(error)
      startScheduledChecks()
    })
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
    getState: () => exposeState(state),
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

function terminalObservationFromMessage(
  payload: Record<string, unknown>,
): Extract<RevalidationObservation, { kind: 'terminal' }> | undefined {
  if (
    !isKernelObservationIdentity(payload) ||
    !Number.isSafeInteger(payload.attemptId) ||
    (payload.attemptId as number) < 1 ||
    (payload.attemptId as number) > payload.observationRevision ||
    typeof payload.releaseId !== 'string' ||
    payload.releaseId.length === 0
  ) {
    return undefined
  }
  return {
    kind: 'terminal',
    identity: payload,
    attempt: {
      attemptId: payload.attemptId as number,
      releaseId: payload.releaseId,
    },
  }
}

function isLocalEdgeRevalidationResult(
  value: unknown,
): value is LocalEdgeRevalidationResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const result = value as Record<string, unknown>
  return (
    typeof result.localEdgeEnabled === 'boolean' &&
    (result.status === 'current' ||
      result.status === 'disabled' ||
      result.status === 'disabled-current' ||
      result.status === 'enabled' ||
      result.status === 'installed' ||
      result.status === 'repaired' ||
      result.status === 'updated') &&
    (result.release === undefined ||
      (typeof result.release === 'object' &&
        result.release !== null &&
        typeof (result.release as { releaseId?: unknown }).releaseId === 'string'))
  )
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

function exposeState(value: LocalEdgeClientState): LocalEdgeClientState {
  // The nested progress object must never be shared with subscribers by
  // reference: a mutating consumer would corrupt the runtime's own state
  // and with it the monotonic-progress guard.
  return value.revalidationProgress
    ? { ...value, revalidationProgress: { ...value.revalidationProgress } }
    : { ...value }
}

function publishToListener(
  listener: LocalEdgeStateListener,
  state: LocalEdgeClientState,
) {
  try {
    listener(exposeState(state))
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
