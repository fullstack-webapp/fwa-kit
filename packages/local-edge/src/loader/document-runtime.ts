import type {
  LocalEdgeRevalidationProgress,
  LocalEdgeRevalidationResult,
  LocalEdgeSnapshot,
} from '../release.ts'
import {
  defaultUpdateCheckIntervalMinutes,
  fwaRevalidationCommittedMessageType,
  fwaRevalidationFailedMessageType,
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
  let explicitNetworkOpen = false
  let settlePullChain: Promise<void> = Promise.resolve()
  // Progress fetched from the kernel is void for a release whose install
  // settled after the fetch began: a snapshot read that predates the settle
  // can still carry the settled attempt's counts, and publishing it would
  // resurrect progress that the terminal message already dropped. Terminal
  // messages mark their release with the current sequence number; fetch
  // publishers capture the sequence before awaiting and discard fetched
  // progress for any release marked later than that.
  let kernelEventSeq = 0
  const settledAtSeq = new Map<string, number>()
  // Progress published by a broadcast after an unscoped clear-read began is
  // newer than that read's kernel view: the unscoped pull drops only the
  // suspected-stale value it was asked to clear, never progress that
  // arrived while its fetch was in flight.
  let progressEventSeq = 0
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
  const progressSettledDuringFetch = (
    progress: LocalEdgeRevalidationProgress,
    startedAtSeq: number,
  ) => {
    const settledSeq = settledAtSeq.get(progress.releaseId)
    return settledSeq !== undefined && settledSeq > startedAtSeq
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

  const publishSnapshot = (
    snapshot: LocalEdgeSnapshot,
    startedAtSeq: number,
    warning?: string,
  ) => {
    // A progress message can land while the fetch is in flight (the message
    // channel is not serialized on the read chain): publish the freshest
    // count, never a stale snapshot's regression. A snapshot read that
    // predates its release's settle does not resurrect the counts the
    // terminal message already dropped.
    const fetchedProgress =
      snapshot.revalidation &&
      !progressSettledDuringFetch(snapshot.revalidation, startedAtSeq)
        ? snapshot.revalidation
        : undefined
    const currentProgress = state.revalidationProgress
    const revalidationProgress = fetchedProgress
      ? !currentProgress ||
        currentProgress.releaseId !== fetchedProgress.releaseId ||
        currentProgress.completedAssets <= fetchedProgress.completedAssets
        ? fetchedProgress
        : currentProgress
      : currentProgress
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

  // All kernel-observation reads run on one ordered chain so an older
  // fetch can never overwrite a newer observation: startup reads,
  // controller-change reads, response-driven pulls, and terminal-message
  // pulls share the same serialization.
  const enqueueSnapshotRead = (warning?: string) => {
    settlePullChain = settlePullChain.then(() =>
      publishSettledSnapshot({
        warning,
      }).catch(publishRuntimeError),
    )
    return settlePullChain
  }

  // A kernel settle broadcast (commit or failure) reaches every controlled
  // window client, including the document whose own revalidate just settled.
  // The pull must not relabel the running document: keep the loaded releaseId
  // and only surface a kernel active release that differs from it as an
  // available update. Settle publishes never touch the document-owned
  // `revalidating` flag and re-read the current state after the await, so a
  // revalidate() that started while the pull was in flight keeps its
  // activity. When the caller already dropped the settled attempt's baseline
  // synchronously (a terminal message, or an own-install response), progress
  // present at pull time belongs to a newer attempt — including a same-
  // release retry — and survives even when the fetched snapshot raced the
  // retry's registration. Otherwise progress for the settled release is
  // dropped; progress for an install that is still running — or reported by
  // the fetched snapshot — survives the settle. A document opened through an
  // explicit network open (?__fwa=network) stays on the network baseline by
  // contract and drops progress without pulling the kernel.
  const publishSettledSnapshot = async ({
    settledReleaseId,
    baselineDropped,
    warning,
  }: {
    settledReleaseId?: string
    baselineDropped?: boolean
    warning?: string
  }) => {
    if (explicitNetworkOpen) {
      const { revalidationProgress: _dropped, ...rest } = state
      void _dropped
      publish(
        warning === undefined
          ? rest
          : { ...rest, message: warning },
      )
      return
    }
    const startedAtSeq = kernelEventSeq
    const progressSeqAtStart = progressEventSeq
    const snapshot = await fetchKernelSnapshot()
    if (!snapshot) {
      publish({
        phase: 'network-only',
        controlled: false,
        revalidating: false,
        updateAvailable: false,
        message:
          warning ??
          '页面尚未受 Local Edge 控制，继续使用 network baseline。',
      })
      return
    }

    // The settled release's progress is stale and must go; a newer
    // install's progress belongs to a kernel-level install that may still
    // be running and stays. When the fetched snapshot itself reports a
    // running install, its value is the freshest kernel observation and
    // wins (never regressing below what the document already shows). A
    // snapshot read that predates its release's settle does not resurrect
    // the counts the terminal message already dropped.
    const currentProgress = state.revalidationProgress
    const settledProgress =
      snapshot.revalidation &&
      !progressSettledDuringFetch(snapshot.revalidation, startedAtSeq)
        ? snapshot.revalidation
        : undefined
    const mergedProgress = settledProgress
      ? (!currentProgress ||
          currentProgress.releaseId !== settledProgress.releaseId ||
          currentProgress.completedAssets <= settledProgress.completedAssets)
        ? settledProgress
        : currentProgress
      : baselineDropped
        ? currentProgress
        : currentProgress && progressEventSeq !== progressSeqAtStart
          ? currentProgress
          : currentProgress &&
              settledReleaseId &&
              currentProgress.releaseId !== settledReleaseId
            ? currentProgress
            : undefined
    const { revalidationProgress: _merged, ...restState } = state
    void _merged
    const publishSettled = (value: LocalEdgeClientState) => {
      publish({
        ...value,
        ...(mergedProgress ? { revalidationProgress: mergedProgress } : undefined),
      })
    }

    if (snapshot.mode !== 'active') {
      const { releaseId: _droppedReleaseId, ...restWithoutReleaseId } = restState
      void _droppedReleaseId
      publishSettled({
        ...restWithoutReleaseId,
        phase: 'network-only',
        controlled: true,
        updateAvailable: false,
        availableReleaseId: undefined,
        message:
          warning ??
          (snapshot.mode === 'disabled'
            ? 'Local Edge 已由 release flag 禁用，当前使用 network baseline。'
            : 'Local Edge 已激活，但还没有可用 release。'),
      })
      return
    }
    if (!snapshot.release) {
      publishSettled({
        ...restState,
        updateAvailable: false,
        availableReleaseId: undefined,
        message: warning ?? 'Local Edge 已激活，但还没有可用 release。',
      })
      return
    }

    const activeReleaseId = snapshot.release.releaseId
    if (!restState.releaseId) {
      publishSettled({
        ...restState,
        phase: 'ready',
        controlled: true,
        releaseId: activeReleaseId,
        updateAvailable: false,
        availableReleaseId: undefined,
        message:
          warning ?? '本地 release 已提交，navigation 可以从 Cache Storage 启动。',
      })
      return
    }
    if (restState.releaseId === activeReleaseId) {
      // A successful pull proves the kernel still serves the loaded release:
      // recover the phase for a document sitting in a transient error state.
      publishSettled({
        ...restState,
        phase: 'ready',
        controlled: true,
        updateAvailable: false,
        availableReleaseId: undefined,
        ...(warning === undefined ? undefined : { message: warning }),
      })
      return
    }

    publishSettled({
      ...restState,
      phase: 'ready',
      controlled: true,
      availableReleaseId: activeReleaseId,
      updateAvailable: true,
      message:
        warning ??
        (restState.availableReleaseId === activeReleaseId &&
        restState.updateAvailable
          ? restState.message
          : '新 release 已完整缓存；当前会话继续运行原版本，下次打开或显式应用更新时启用。'),
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
        await enqueueSnapshotRead(
          'Release revalidation failed; the last committed release remains active.',
        )
      } else if (state.revalidationProgress) {
        // A lost terminal broadcast leaves stale progress with no later
        // event to clear it; re-sync from the kernel on the next check.
        await enqueueSnapshotRead()
      }
      return 'failed' as const
    }
    if (result.status === 'updated') {
      const availableReleaseId = result.release?.releaseId
      if (availableReleaseId && availableReleaseId !== state.releaseId) {
        // Announce from a fresh, ordered kernel observation rather than from
        // the response payload: a commit that landed in another tab while
        // this response was pending must not be overwritten by the older
        // release this result carries. The public promise keeps its state
        // semantics: the announcement is visible once await revalidate()
        // resolves. The own install's progress baseline is dropped here,
        // before the pull, so the pull keeps only newer attempts' progress.
        if (state.revalidationProgress?.releaseId === availableReleaseId) {
          publish({ ...state, revalidationProgress: undefined })
        }
        let releasePull!: () => void
        settlePullChain = settlePullChain.then(async () => {
          try {
            await publishSettledSnapshot({
              settledReleaseId: availableReleaseId,
              baselineDropped: true,
            })
          } catch (error) {
            publishRuntimeError(error)
          } finally {
            releasePull()
          }
        })
        await new Promise<void>((resolve) => {
          releasePull = resolve
        })
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
      // The first-install claim comes from an ordered fresh snapshot read,
      // not from the response payload: a cross-tab commit that landed while
      // this response was pending must not be overwritten by the older
      // release the result carries.
      await enqueueSnapshotRead()
    } else if (result.status !== 'current' && revalidationVisible) {
      await enqueueSnapshotRead()
    } else if (result.status === 'current' && state.revalidationProgress) {
      // 'current' proves no install was in flight at response time: stale
      // progress (a lost terminal broadcast) re-syncs from the kernel; a
      // cross-tab install's live progress re-publishes unchanged.
      await enqueueSnapshotRead()
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
      explicitNetworkOpen = true
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
      // The startup read runs as the first task on the ordered observation
      // chain: a commit that lands while this read is in flight enqueues
      // its terminal pull behind it, so the older startup snapshot can
      // never overwrite a newer observation.
      let snapshotPublished = false
      let startupError: unknown
      await (settlePullChain = settlePullChain.then(async () => {
        try {
          let snapshot: LocalEdgeSnapshot | undefined
          const startedAtSeq = kernelEventSeq
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
          publishSnapshot(snapshot, startedAtSeq)
          snapshotPublished = true
        } catch (error) {
          startupError = error
        }
      }))
      if (startupError !== undefined) {
        throw startupError
      }
      if (!snapshotPublished) {
        // Takeover reload in progress; startup does not continue.
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
    void enqueueSnapshotRead()
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
      const current = state.revalidationProgress
      if (
        current?.releaseId === progress.releaseId &&
        current.completedAssets > progress.completedAssets
      ) {
        // An out-of-order broadcast must not regress the visible count.
        return
      }
      publish({
        ...state,
        revalidationProgress: progress,
      })
      progressEventSeq += 1
      return
    }
    if (
      payload.type === fwaRevalidationCommittedMessageType ||
      payload.type === fwaRevalidationFailedMessageType
    ) {
      const settledReleaseId =
        typeof payload.releaseId === 'string' ? payload.releaseId : undefined
      // A retry or repair of the same release restarts from zero: drop the
      // settled attempt's baseline synchronously, before the ordered pull
      // runs, so the monotonic guard does not reject the retry's early
      // counts while the pull is still pending. The settle is also marked
      // with the current sequence number so in-flight snapshot reads cannot
      // resurrect this attempt's counts after they were dropped.
      kernelEventSeq += 1
      if (settledReleaseId) {
        settledAtSeq.set(settledReleaseId, kernelEventSeq)
      }
      if (
        settledReleaseId &&
        state.revalidationProgress?.releaseId === settledReleaseId
      ) {
        publish({ ...state, revalidationProgress: undefined })
      }
      // Terminal pulls are serialized: an earlier settle response can never
      // overwrite the result of a later terminal message. The settled release
      // id lets the pull drop only that release's progress and keep the
      // progress of an install that is still running.
      settlePullChain = settlePullChain.then(() =>
        publishSettledSnapshot({
          settledReleaseId,
          baselineDropped: settledReleaseId !== undefined,
        }).catch(publishRuntimeError),
      )
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
