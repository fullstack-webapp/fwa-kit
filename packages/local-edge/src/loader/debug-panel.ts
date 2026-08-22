import {
  releaseAssetPaths,
  type AppRelease,
  type LocalEdgeSnapshot,
} from '../release.ts'
import {
  pathWithLocalEdgeNavigationMode,
  pathWithoutLocalEdgeNavigationMode,
  localEdgeNavigationModeFor,
} from '../config-contract.ts'
import {
  deriveDebugInstallation,
  provisionalDebugInstallation,
  type DebugInstallationDiagnostic,
} from './debug-installation.ts'
import {
  fwaDebugTriggerDefaultBottomOffset,
  fwaDebugTriggerSize,
  fwaDebugTriggerViewportInset,
} from './debug-position.ts'
import { installFwaDebugTrigger } from './debug-trigger.ts'
import type { FwaLocalEdgeApi, LocalEdgeClientState } from './loader-contract.ts'

const debugHostId = '__fwa-debug-root'
const releaseCacheMarker = ':release:'
const releaseCachePrefix = 'fwa-local-edge:'
const cachePathSampleLimit = 12
const idleCheckMessage = '仅检查最新 release，不影响当前缓存与会话。'

interface ReleaseDiagnostic {
  appId: string
  assetCount: number
  releaseId: string
  schemaVersion: number
  sizeBytes?: number
}

interface KernelDiagnostic {
  activeRelease?: ReleaseDiagnostic
  localEdgeEnabled: boolean
  mode: LocalEdgeSnapshot['mode']
  retainedReleases: ReleaseDiagnostic[]
}

interface ServiceWorkerDiagnostic {
  active?: string
  controller?: string
  installing?: string
  scope?: string
  supported: boolean
  waiting?: string
}

interface CacheDiagnostic {
  complete?: boolean
  entryCount: number
  expectedAssetCount?: number
  missingAssetCount?: number
  name: string
  pathSample: string[]
  releaseId?: string
}

interface FwaDebugReport {
  cacheStorage: CacheDiagnostic[]
  collectedAt: string
  errors: string[]
  installation: DebugInstallationDiagnostic
  kernel?: KernelDiagnostic
  loaderPaths: FwaLocalEdgeApi['paths']
  pathname: string
  serviceWorker: ServiceWorkerDiagnostic
  localEdge: LocalEdgeClientState
}

interface DebugReportElements {
  errors: HTMLUListElement
  rawReport: HTMLPreElement
  status: HTMLDivElement
  summary: HTMLDListElement
  trigger: HTMLButtonElement
}

export function installFwaDebugPanel(
  localEdge: FwaLocalEdgeApi,
  onHide: () => void,
) {
  if (document.getElementById(debugHostId)) {
    return () => undefined
  }

  const host = document.createElement('div')
  host.id = debugHostId
  host.dataset.fwaDebugRoot = ''
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = debugPanelStyles

  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  backdrop.hidden = true
  backdrop.setAttribute('aria-hidden', 'true')

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'trigger'
  trigger.textContent = 'FWA'
  trigger.setAttribute('aria-label', 'Open FWA diagnostics')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('title', 'Drag to move · click for diagnostics')

  const panel = document.createElement('section')
  panel.className = 'panel'
  panel.hidden = true
  panel.setAttribute('aria-label', 'FWA diagnostics')
  panel.setAttribute('role', 'dialog')

  const header = document.createElement('header')
  const headingGroup = document.createElement('div')
  const heading = document.createElement('strong')
  heading.textContent = 'FWA diagnostics'
  const scope = document.createElement('span')
  scope.className = 'muted'
  scope.textContent = `Local Edge · ${localEdge.paths.scopePath}`
  headingGroup.append(heading, scope)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'icon-button'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', 'Close FWA diagnostics')
  header.append(headingGroup, closeButton)

  const status = document.createElement('div')
  status.className = 'status'
  status.textContent = 'Collecting diagnostics'

  const summary = document.createElement('dl')
  summary.className = 'summary'

  const message = document.createElement('p')
  message.className = 'message'
  message.dataset.tone = 'info'
  message.textContent = idleCheckMessage
  message.setAttribute('aria-live', 'polite')

  const errors = document.createElement('ul')
  errors.className = 'errors'
  errors.hidden = true

  const details = document.createElement('details')
  const detailsSummary = document.createElement('summary')
  detailsSummary.textContent = 'Raw report'
  const rawReport = document.createElement('pre')
  details.append(detailsSummary, rawReport)

  const content = document.createElement('div')
  content.className = 'content'
  content.append(status, summary, message, errors, details)

  const footer = document.createElement('footer')
  const reloadButton = document.createElement('button')
  reloadButton.type = 'button'
  reloadButton.className = 'action reload'
  reloadButton.textContent = 'Reload'

  const checkButton = document.createElement('button')
  checkButton.type = 'button'
  checkButton.className = 'action primary check'
  checkButton.textContent = 'Check again'

  const networkButton = document.createElement('button')
  networkButton.type = 'button'
  networkButton.className = 'action'

  const hideButton = document.createElement('button')
  hideButton.type = 'button'
  hideButton.className = 'action'
  hideButton.textContent = 'Hide'
  hideButton.title = 'Clear the saved debug preference'

  const resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.className = 'action danger'
  resetButton.textContent = 'Reset'
  resetButton.title = 'Open the Local Edge reset confirmation'

  const primaryActions = document.createElement('div')
  primaryActions.className = 'action-row primary-actions'
  primaryActions.append(checkButton, networkButton)

  const secondaryActions = document.createElement('div')
  secondaryActions.className = 'action-row secondary-actions'
  secondaryActions.append(reloadButton, hideButton, resetButton)

  footer.append(primaryActions, secondaryActions)

  const reloadConfirmation = document.createElement('div')
  reloadConfirmation.className = 'confirmation-backdrop'
  reloadConfirmation.hidden = true

  const reloadDialog = document.createElement('section')
  reloadDialog.className = 'confirmation'
  reloadDialog.setAttribute('aria-label', 'Reload FWA app')
  reloadDialog.setAttribute('aria-modal', 'true')
  reloadDialog.setAttribute('role', 'alertdialog')

  const reloadHeading = document.createElement('strong')
  const reloadDescription = document.createElement('p')
  const reloadActions = document.createElement('div')
  reloadActions.className = 'confirmation-actions'

  const cancelReloadButton = document.createElement('button')
  cancelReloadButton.type = 'button'
  cancelReloadButton.className = 'action'
  cancelReloadButton.textContent = 'Cancel'

  const confirmReloadButton = document.createElement('button')
  confirmReloadButton.type = 'button'
  confirmReloadButton.className = 'action primary'

  reloadActions.append(cancelReloadButton, confirmReloadButton)
  reloadDialog.append(reloadHeading, reloadDescription, reloadActions)
  reloadConfirmation.append(reloadDialog)

  panel.append(header, content, footer)
  shadow.append(style, backdrop, trigger, panel, reloadConfirmation)
  document.documentElement.append(host)

  let refreshSequence = 0
  let checkSequence = 0
  let destroyed = false
  let unsubscribe: () => void = () => undefined
  const triggerPlacement = installFwaDebugTrigger(host, trigger, panel)
  const realignPanel = () => triggerPlacement.alignPanel()
  details.addEventListener('toggle', realignPanel)

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    refreshSequence += 1
    checkSequence += 1
    unsubscribe()
    details.removeEventListener('toggle', realignPanel)
    triggerPlacement.destroy()
    host.remove()
  }

  const syncNetworkButton = () => {
    networkButton.textContent =
      localEdgeNavigationModeFor(new URL(window.location.href)) === 'network'
        ? 'Use Local Edge'
        : 'Use network'
  }

  const closeReloadConfirmation = (restoreFocus = true) => {
    if (reloadConfirmation.hidden) return
    reloadConfirmation.hidden = true
    if (restoreFocus) reloadButton.focus()
  }

  const close = () => {
    closeReloadConfirmation(false)
    backdrop.hidden = true
    panel.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.focus()
  }

  const refreshReport = async () => {
    const sequence = ++refreshSequence
    const report = await collectDebugReport(localEdge)
    if (sequence !== refreshSequence) {
      return
    }
    renderDebugReport(report, {
      errors,
      rawReport,
      status,
      summary,
      trigger,
    })
    syncNetworkButton()
  }

  const setFeedback = (
    text: string,
    tone: 'info' | 'success' | 'warning',
  ) => {
    message.dataset.tone = tone
    message.textContent = text
  }

  const checkForUpdates = async () => {
    const sequence = ++checkSequence
    checkButton.disabled = true
    checkButton.textContent = 'Checking'
    setFeedback(
      '正在检查并按需缓存最新 release；当前缓存与会话保持可用。',
      'info',
    )

    try {
      const outcome = await localEdge.revalidate()
      if (destroyed || sequence !== checkSequence) return

      const state = localEdge.getState()
      if (state.updateAvailable && state.availableReleaseId) {
        setFeedback(
          '新 release 已完整缓存。当前会话继续运行原版本；点击 Reload 后启用。',
          'info',
        )
      } else if (outcome === 'failed') {
        setFeedback(
          '无法检查最新 release；当前缓存与会话保持可用。',
          'warning',
        )
      } else if (outcome === 'disabled') {
        setFeedback(
          'Local Edge 已由 release flag 禁用，当前使用 network baseline。',
          'info',
        )
      } else {
        setFeedback(
          '当前 release 已是最新版；当前缓存与会话保持可用。',
          'success',
        )
      }
    } catch {
      if (destroyed || sequence !== checkSequence) return
      setFeedback(
        '无法检查最新 release；当前缓存与会话保持可用。',
        'warning',
      )
    } finally {
      if (!destroyed && sequence === checkSequence) {
        checkButton.disabled = false
        checkButton.textContent = 'Check again'
        await refreshReport()
      }
    }
  }

  const openReloadConfirmation = () => {
    const state = localEdge.getState()
    const updateReady = state.updateAvailable && state.availableReleaseId
    reloadHeading.textContent = updateReady
      ? 'Reload to use the update?'
      : 'Reload the app?'
    reloadDescription.textContent = updateReady
      ? `Release ${state.availableReleaseId} is ready. Reloading replaces the current in-memory session.`
      : 'Reloading restarts the current app and discards any unsaved in-memory session state.'
    confirmReloadButton.textContent = updateReady ? 'Reload to update' : 'Reload'
    reloadConfirmation.hidden = false
    confirmReloadButton.focus()
  }

  const open = () => {
    backdrop.hidden = false
    panel.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    triggerPlacement.alignPanel()
    closeButton.focus()
    void refreshReport()
  }

  trigger.addEventListener('click', (event) => {
    if (triggerPlacement.consumeSuppressedClick()) {
      event.preventDefault()
      return
    }
    if (panel.hidden) {
      open()
    } else {
      close()
    }
  })
  backdrop.addEventListener('click', close)
  closeButton.addEventListener('click', close)
  checkButton.addEventListener('click', () => void checkForUpdates())
  reloadButton.addEventListener('click', openReloadConfirmation)
  cancelReloadButton.addEventListener('click', () =>
    closeReloadConfirmation(),
  )
  confirmReloadButton.addEventListener('click', () => {
    if (!localEdge.applyUpdate()) window.location.reload()
  })
  reloadConfirmation.addEventListener('click', (event) => {
    if (event.target === reloadConfirmation) closeReloadConfirmation()
  })
  reloadConfirmation.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeReloadConfirmation()
    } else if (event.key === 'Tab') {
      const movingBackward = event.shiftKey
      if (
        (movingBackward && shadow.activeElement === cancelReloadButton) ||
        (!movingBackward && shadow.activeElement === confirmReloadButton)
      ) {
        event.preventDefault()
        const wrappedTarget = movingBackward
          ? confirmReloadButton
          : cancelReloadButton
        wrappedTarget.focus()
      }
    }
  })
  networkButton.addEventListener('click', () => {
    const currentUrl = new URL(window.location.href)
    window.location.assign(
      localEdgeNavigationModeFor(currentUrl) === 'network'
        ? pathWithoutLocalEdgeNavigationMode(currentUrl)
        : localEdge.networkUrl(),
    )
  })
  resetButton.addEventListener('click', () => {
    window.location.assign(
      pathWithLocalEdgeNavigationMode(new URL(window.location.href), 'reset'),
    )
  })
  hideButton.addEventListener('click', () => {
    onHide()
  })
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close()
    }
  })
  syncNetworkButton()
  unsubscribe = localEdge.subscribe((state) => {
    updateTrigger(trigger, state)
    reloadButton.classList.toggle(
      'primary',
      Boolean(state.updateAvailable && state.availableReleaseId),
    )
    if (state.updateAvailable && state.availableReleaseId) {
      setFeedback(
        '新 release 已完整缓存。当前会话继续运行原版本；点击 Reload 后启用。',
        'info',
      )
    }
    void refreshReport()
  })
  return destroy
}

async function collectDebugReport(localEdge: FwaLocalEdgeApi): Promise<FwaDebugReport> {
  const errors: string[] = []
  const localEdgeState = localEdge.getState()
  const kernelSnapshot = await readKernelSnapshot(localEdge, localEdgeState, errors)
  const serviceWorker = await readServiceWorkerDiagnostic(localEdge, errors)
  const cacheStorage = await readCacheDiagnostics(kernelSnapshot, errors)

  const evidence: Omit<FwaDebugReport, 'installation'> = {
    cacheStorage,
    collectedAt: new Date().toISOString(),
    errors,
    kernel: kernelSnapshot ? summarizeKernel(kernelSnapshot) : undefined,
    loaderPaths: localEdge.paths,
    pathname: window.location.pathname,
    serviceWorker,
    localEdge: localEdgeState,
  }
  return {
    ...evidence,
    installation: deriveDebugInstallation({
      activeRelease: evidence.kernel?.activeRelease,
      caches: evidence.cacheStorage,
      hasErrors: evidence.errors.length > 0,
      kernel: evidence.kernel,
      revalidating: evidence.localEdge.revalidating,
      serviceWorker: evidence.serviceWorker,
      localEdgePhase: evidence.localEdge.phase,
    }),
  }
}

async function readKernelSnapshot(
  localEdge: FwaLocalEdgeApi,
  localEdgeState: LocalEdgeClientState,
  errors: string[],
) {
  if (
    localEdgeState.phase === 'network-only' &&
    navigator.serviceWorker.controller === null
  ) {
    return undefined
  }
  try {
    const response = await fetch(localEdge.paths.statePath, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`state returned ${response.status}`)
    }
    return (await response.json()) as LocalEdgeSnapshot
  } catch (error) {
    errors.push(`Kernel state: ${errorMessage(error)}`)
    return undefined
  }
}

async function readServiceWorkerDiagnostic(
  localEdge: FwaLocalEdgeApi,
  errors: string[],
): Promise<ServiceWorkerDiagnostic> {
  if (!('serviceWorker' in navigator)) {
    return { supported: false }
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration(
      localEdge.paths.scopePath,
    )
    return {
      active: workerPath(registration?.active),
      controller: workerPath(navigator.serviceWorker.controller),
      installing: workerPath(registration?.installing),
      scope: registration?.scope
        ? new URL(registration.scope).pathname
        : undefined,
      supported: true,
      waiting: workerPath(registration?.waiting),
    }
  } catch (error) {
    errors.push(`Service Worker: ${errorMessage(error)}`)
    return {
      controller: workerPath(navigator.serviceWorker.controller),
      supported: true,
    }
  }
}

async function readCacheDiagnostics(
  snapshot: LocalEdgeSnapshot | undefined,
  errors: string[],
): Promise<CacheDiagnostic[]> {
  if (!('caches' in window)) {
    return []
  }

  try {
    const releases = [
      snapshot?.release,
      ...(snapshot?.retainedReleases ?? []),
    ].filter((release): release is AppRelease => Boolean(release))
    const releasesById = new Map(
      releases.map((release) => [release.releaseId, release]),
    )
    const cacheNames = (await caches.keys()).filter((cacheName) =>
      cacheName.startsWith(releaseCachePrefix),
    )

    return Promise.all(
      cacheNames.map(async (cacheName) => {
        const cache = await caches.open(cacheName)
        const paths = (await cache.keys())
          .map((request) => new URL(request.url).pathname)
          .sort()
        const releaseId = releaseIdFromCacheName(cacheName)
        const release = releaseId ? releasesById.get(releaseId) : undefined
        const expectedPaths = release ? releaseAssetPaths(release) : undefined
        const cachedPaths = new Set(paths)
        const missingAssetCount = expectedPaths?.filter(
          (path) => !cachedPaths.has(path),
        ).length

        return {
          complete:
            missingAssetCount === undefined
              ? undefined
              : missingAssetCount === 0,
          entryCount: paths.length,
          expectedAssetCount: expectedPaths?.length,
          missingAssetCount,
          name: cacheName,
          pathSample: paths.slice(0, cachePathSampleLimit),
          releaseId,
        }
      }),
    )
  } catch (error) {
    errors.push(`Cache Storage: ${errorMessage(error)}`)
    return []
  }
}

function summarizeKernel(snapshot: LocalEdgeSnapshot): KernelDiagnostic {
  return {
    activeRelease: summarizeRelease(snapshot.release),
    localEdgeEnabled: snapshot.localEdgeEnabled,
    mode: snapshot.mode,
    retainedReleases: snapshot.retainedReleases
      ?.map(summarizeRelease)
      .filter((release): release is ReleaseDiagnostic => Boolean(release)) ?? [],
  }
}

function summarizeRelease(
  release: AppRelease | undefined,
): ReleaseDiagnostic | undefined {
  if (!release) {
    return undefined
  }
  return {
    appId: release.appId,
    assetCount: releaseAssetPaths(release).length,
    releaseId: release.releaseId,
    schemaVersion: release.schemaVersion,
    sizeBytes:
      release.schemaVersion === 2
        ? release.assets.reduce((sum, asset) => sum + asset.size, 0)
        : undefined,
  }
}

function renderDebugReport(
  report: FwaDebugReport,
  elements: DebugReportElements,
) {
  const activeRelease = report.kernel?.activeRelease
  const knownCaches = report.cacheStorage.filter(
    (cache) => cache.expectedAssetCount !== undefined,
  )
  const cachesComplete =
    knownCaches.length > 0 && knownCaches.every((cache) => cache.complete)

  updateTrigger(elements.trigger, report.localEdge, report.installation)
  elements.status.dataset.phase = report.localEdge.phase
  elements.status.textContent = `${report.localEdge.phase} · ${
    report.localEdge.controlled ? 'controlled' : 'uncontrolled'
  }`
  elements.summary.replaceChildren(
    summaryRow(
      'Install',
      `${report.installation.label} · ${report.installation.detail}`,
    ),
    summaryRow('Kernel', report.kernel?.mode ?? 'unavailable'),
    summaryRow('Current release', report.localEdge.releaseId ?? 'none'),
    summaryRow(
      'Available release',
      report.localEdge.availableReleaseId ?? 'none',
    ),
    summaryRow('Kernel active', activeRelease?.releaseId ?? 'none'),
    summaryRow(
      'Retained releases',
      String(report.kernel?.retainedReleases.length ?? 0),
    ),
    summaryRow(
      'Assets',
      activeRelease
        ? `${activeRelease.assetCount} · ${formatBytes(activeRelease.sizeBytes)}`
        : 'none',
    ),
    summaryRow(
      'Cache',
      report.cacheStorage.length === 0
        ? 'none'
        : `${report.cacheStorage.length} release cache${
            report.cacheStorage.length === 1 ? '' : 's'
          } · ${cachesComplete ? 'complete' : 'check report'}`,
    ),
    summaryRow(
      'Worker',
      report.serviceWorker.controller ??
        report.serviceWorker.active ??
        'none',
    ),
  )
  elements.errors.replaceChildren(
    ...report.errors.map((error) => {
      const item = document.createElement('li')
      item.textContent = error
      return item
    }),
  )
  elements.errors.hidden = report.errors.length === 0
  elements.rawReport.textContent = JSON.stringify(report, null, 2)
}

function summaryRow(label: string, value: string) {
  const wrapper = document.createElement('div')
  const term = document.createElement('dt')
  term.textContent = label
  const description = document.createElement('dd')
  description.textContent = value
  wrapper.append(term, description)
  return wrapper
}

function updateTrigger(
  trigger: HTMLButtonElement,
  state: LocalEdgeClientState,
  installation = provisionalDebugInstallation(state),
) {
  trigger.dataset.phase = state.phase
  trigger.dataset.installation = installation.state
  if (state.updateAvailable && state.availableReleaseId) {
    trigger.dataset.notice = 'update'
  } else {
    delete trigger.dataset.notice
  }
  const updateLabel = state.updateAvailable ? ' · update ready' : ''
  trigger.title = `FWA: ${installation.label} · ${state.phase}${updateLabel} · drag to move`
  trigger.setAttribute(
    'aria-label',
    `Open FWA diagnostics (${installation.label.toLowerCase()}${
      state.updateAvailable ? ', update ready' : ''
    })`,
  )
}

function releaseIdFromCacheName(cacheName: string) {
  const markerIndex = cacheName.lastIndexOf(releaseCacheMarker)
  return markerIndex === -1
    ? undefined
    : cacheName.slice(markerIndex + releaseCacheMarker.length)
}

function workerPath(worker: ServiceWorker | null | undefined) {
  return worker ? new URL(worker.scriptURL).pathname : undefined
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(sizeBytes: number | undefined) {
  if (sizeBytes === undefined) {
    return 'size unavailable'
  }
  if (sizeBytes < 1000) {
    return `${sizeBytes} B`
  }
  if (sizeBytes < 1_000_000) {
    return `${(sizeBytes / 1000).toFixed(1)} KB`
  }
  return `${(sizeBytes / 1_000_000).toFixed(2)} MB`
}

const debugPanelStyles = `
  :host {
    all: initial;
    color-scheme: light dark;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    position: fixed;
    right: max(${fwaDebugTriggerViewportInset}px, env(safe-area-inset-right));
    bottom: calc(max(${fwaDebugTriggerViewportInset}px, env(safe-area-inset-bottom)) + ${fwaDebugTriggerDefaultBottomOffset}px);
    z-index: 2147483000;
  }
  *, *::before, *::after { box-sizing: border-box; }
  button, summary { cursor: pointer; font: inherit; }
  button:disabled { cursor: default; opacity: 0.62; }
  .backdrop {
    position: fixed;
    z-index: 0;
    inset: 0;
    background: transparent;
    cursor: default;
  }
  .backdrop[hidden] { display: none; }
  .trigger {
    --fwa-debug-ring: #8794a5;
    --fwa-debug-fill: #343c47;
    --fwa-debug-ink: #e6ebf1;
    --fwa-debug-activity: #d69a31;
    --fwa-debug-halo: rgba(135, 148, 165, 0.16);
    position: relative;
    z-index: 1;
    width: ${fwaDebugTriggerSize}px;
    height: ${fwaDebugTriggerSize}px;
    border: 1px solid var(--fwa-debug-ring);
    border-radius: 999px;
    background: var(--fwa-debug-fill);
    color: var(--fwa-debug-ink);
    box-shadow: 0 0 0 2px var(--fwa-debug-halo), 0 8px 19px rgba(15, 23, 35, 0.19);
    font-size: 8px;
    font-weight: 800;
    letter-spacing: 0.09em;
    cursor: grab;
    touch-action: none;
    user-select: none;
    will-change: transform;
    transition:
      background-color 160ms ease,
      box-shadow 180ms ease,
      border-color 180ms ease,
      color 160ms ease,
      filter 160ms ease,
      transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .trigger::before {
    position: absolute;
    inset: -3px;
    border-radius: inherit;
    content: "";
    pointer-events: none;
  }
  .trigger[data-notice="update"]::after {
    position: absolute;
    top: 0.5px;
    right: 0.5px;
    width: 8px;
    height: 8px;
    border: 2px solid #111827;
    border-radius: 50%;
    background: #4f9ae8;
    box-shadow: 0 0 0 2px rgba(79, 154, 232, 0.14);
    content: "";
    pointer-events: none;
  }
  @media (hover: hover) and (pointer: fine) {
    .trigger:hover { filter: brightness(1.06); transform: translateY(-1px) scale(1.025); }
  }
  .trigger:active { filter: brightness(0.96); transform: translateY(1px) scale(0.965); transition-duration: 80ms; }
  .trigger.dragging { cursor: grabbing; filter: brightness(0.98); transform: scale(0.98); transition-duration: 80ms; }
  .trigger:focus { outline: none; }
  .trigger:focus-visible {
    outline: 1px solid rgba(147, 197, 253, 0.48);
    outline-offset: 2px;
  }
  .trigger[data-installation="installed"] {
    --fwa-debug-ring: #35b681;
    --fwa-debug-fill: #153a30;
    --fwa-debug-ink: #d9fff0;
    --fwa-debug-activity: #4f9ae8;
    --fwa-debug-halo: rgba(53, 182, 129, 0.18);
  }
  .trigger[data-installation="bypassed"] {
    --fwa-debug-ring: #4f9ae8;
    --fwa-debug-fill: #193353;
    --fwa-debug-ink: #dcecff;
    --fwa-debug-activity: #75afe9;
    --fwa-debug-halo: rgba(79, 154, 232, 0.18);
  }
  .trigger[data-installation="installing"] {
    --fwa-debug-activity: #d69a31;
  }
  .trigger[data-installation="updating"] {
    --fwa-debug-ring: #35b681;
    --fwa-debug-fill: #153a30;
    --fwa-debug-ink: #d9fff0;
    --fwa-debug-activity: #4f9ae8;
    --fwa-debug-halo: rgba(53, 182, 129, 0.18);
  }
  .trigger[data-installation="checking"]::before,
  .trigger[data-installation="installing"]::before,
  .trigger[data-installation="updating"]::before {
    background: conic-gradient(
      from 25deg,
      transparent 0 53%,
      var(--fwa-debug-activity) 63% 78%,
      transparent 88% 100%
    );
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
    animation: fwa-debug-orbit 1.25s linear infinite;
  }
  .trigger[data-installation="not-installed"],
  .trigger[data-installation="unsupported"] {
    opacity: 0.72;
    box-shadow: 0 8px 19px rgba(15, 23, 35, 0.12);
  }
  .trigger[data-installation="incomplete"] {
    --fwa-debug-ring: #df6969;
    --fwa-debug-fill: #482729;
    --fwa-debug-ink: #ffe5e5;
    --fwa-debug-activity: #e39d49;
    --fwa-debug-halo: rgba(223, 105, 105, 0.2);
  }
  .trigger[data-installation="unavailable"] {
    --fwa-debug-ring: #bb6262;
    --fwa-debug-fill: #343038;
    --fwa-debug-ink: #f2dede;
    --fwa-debug-activity: #c37b7b;
    --fwa-debug-halo: rgba(187, 98, 98, 0.18);
    opacity: 0.9;
  }
  @keyframes fwa-debug-orbit {
    to { transform: rotate(1turn); }
  }
  .panel {
    position: fixed;
    z-index: 2;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    width: min(390px, calc(100vw - 24px));
    max-height: min(620px, calc(100dvh - 92px));
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, 0.3);
    border-radius: 16px;
    background: #111827;
    color: #f9fafb;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.34);
  }
  .panel[hidden] { display: none; }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid rgba(148, 163, 184, 0.22);
    padding: 14px 16px 12px;
  }
  header > div { display: grid; gap: 2px; }
  header strong { font-size: 15px; }
  .muted { color: #94a3b8; font-size: 12px; }
  .icon-button, .action {
    border: 1px solid rgba(148, 163, 184, 0.32);
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
  }
  .icon-button {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    font-size: 22px;
    line-height: 1;
  }
  .action { border-radius: 9px; padding: 7px 12px; font-size: 12px; }
  .action:hover { background: rgba(255, 255, 255, 0.11); }
  .action.primary {
    border-color: rgba(96, 165, 250, 0.5);
    background: rgba(59, 130, 246, 0.14);
    color: #dbeafe;
  }
  .action.danger { color: #fca5a5; }
  .content {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding: 0 16px 14px;
  }
  .status {
    display: inline-flex;
    margin-top: 14px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.16);
    padding: 5px 9px;
    color: #cbd5e1;
    font: 650 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .status[data-phase="ready"] {
    background: rgba(16, 185, 129, 0.18);
    color: #a7f3d0;
  }
  .status[data-phase="error"] {
    background: rgba(239, 68, 68, 0.2);
    color: #fecaca;
  }
  .summary {
    display: grid;
    gap: 1px;
    margin: 14px 0;
    overflow: hidden;
    border-radius: 10px;
    background: rgba(148, 163, 184, 0.18);
  }
  .summary > div {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 12px;
    background: #111827;
    padding: 8px 10px;
  }
  dt { color: #94a3b8; font-size: 12px; }
  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: #e2e8f0;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .message {
    min-height: 36px;
    margin: 0 0 12px;
    border-radius: 10px;
    background: rgba(148, 163, 184, 0.1);
    padding: 9px 10px;
    color: #cbd5e1;
    font-size: 12px;
    line-height: 1.5;
  }
  .message[data-tone="info"] {
    background: rgba(59, 130, 246, 0.12);
    color: #bfdbfe;
  }
  .message[data-tone="success"] {
    background: rgba(16, 185, 129, 0.11);
    color: #bbf7d0;
  }
  .message[data-tone="warning"] {
    background: rgba(245, 158, 11, 0.12);
    color: #fde68a;
  }
  .errors {
    margin: 0 0 12px;
    padding-left: 18px;
    color: #fecaca;
    font-size: 12px;
    line-height: 1.5;
  }
  details {
    border-top: 1px solid rgba(148, 163, 184, 0.22);
    padding-top: 10px;
  }
  summary { color: #cbd5e1; font-size: 12px; }
  pre {
    max-height: 260px;
    overflow: auto;
    margin: 10px 0 0;
    border-radius: 10px;
    background: #030712;
    padding: 10px;
    color: #cbd5e1;
    font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  footer {
    display: grid;
    gap: 8px;
    border-top: 1px solid rgba(148, 163, 184, 0.22);
    background: #111827;
    padding: 12px 16px 14px;
  }
  .action-row { display: grid; gap: 7px; }
  .primary-actions { grid-template-columns: minmax(0, 1fr) auto; }
  .secondary-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .action-row .action { width: 100%; }
  .confirmation-backdrop {
    position: fixed;
    z-index: 3;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(3, 7, 18, 0.42);
    padding: 16px;
  }
  .confirmation-backdrop[hidden] { display: none; }
  .confirmation {
    display: grid;
    width: min(340px, calc(100vw - 32px));
    gap: 10px;
    border: 1px solid rgba(148, 163, 184, 0.32);
    border-radius: 14px;
    background: #111827;
    padding: 16px;
    color: #f9fafb;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.38);
  }
  .confirmation strong { font-size: 15px; }
  .confirmation p {
    margin: 0;
    color: #cbd5e1;
    font-size: 12px;
    line-height: 1.5;
  }
  .confirmation-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  @media (prefers-reduced-motion: reduce) {
    .trigger { transition: none; }
    .trigger::before { animation: none !important; }
  }
  @media (max-width: 480px) {
    header { padding-inline: 14px; }
    .content { padding-inline: 14px; }
    footer { gap: 10px; padding-inline: 14px; }
  }
`
