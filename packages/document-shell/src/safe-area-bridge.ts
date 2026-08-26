import {
  safeAreaCompatibilityProfiles,
  type SafeAreaCompatibilityProfile,
} from './safe-area-profiles.ts'
import type { HtmlFragment, InlineScript } from './document-shell.ts'

export type SafeAreaDomUpdate =
  | {
      kind: 'reserve'
      profile: string
      orientation: 'portrait' | 'landscape'
      bottom: number
    }
  | {
      kind: 'release'
      profile: string
      orientation: 'portrait' | 'landscape'
      bottom: number
      reason: 'native-stable' | 'orientation-changed'
    }

export type SafeAreaDomEffect = {
  reserveBottomCssVariable: `--${string}`
  profileAttribute?: `data-${string}`
  orientationAttribute?: `data-${string}`
  reserveAttribute?: `data-${string}`
  windowStateProperty?: string
  resultStateProperty?: string
}

export type SafeAreaBridgeProjection = {
  beforePaint: InlineScript
  probeHtml: HtmlFragment
}

export type CreateSafeAreaBridgeOptions = {
  domEffect: SafeAreaDomEffect
}

export type CreateReferenceSafeAreaBridgeOptions = CreateSafeAreaBridgeOptions & {
  diagnosticOverride?: {
    enabledAttribute: `data-${string}`
    enabledValue?: string
    queryParameter: string
    bottom: number
  }
}

type SafeAreaRollout = SafeAreaCompatibilityProfile['rollout']

function assertProfiles(profiles: readonly SafeAreaCompatibilityProfile[]): void {
  const ids = new Set<string>()
  const signatures = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Duplicate safe-area profile id: ${profile.id}`)
    ids.add(profile.id)
    if (
      !Number.isInteger(profile.minimumRuntimeVersion[0]) ||
      profile.minimumRuntimeVersion[0] < 0 ||
      !Number.isInteger(profile.minimumRuntimeVersion[1]) ||
      profile.minimumRuntimeVersion[1] < 0
    ) {
      throw new Error(`Safe-area profile ${profile.id} has an invalid minimum runtime version`)
    }
    if (profile.reserve.bottom <= 0) {
      throw new Error(`Safe-area profile ${profile.id} must provide a positive bottom reserve`)
    }
    const signature = JSON.stringify({
      platform: profile.platform,
      displayMode: profile.displayMode,
      orientation: profile.orientation,
      screen: profile.screen,
      devicePixelRatio: profile.devicePixelRatio,
    })
    if (signatures.has(signature)) {
      throw new Error(`Safe-area profile ${profile.id} overlaps another runtime matcher`)
    }
    signatures.add(signature)
  }
}

function assertDomEffect(domEffect: SafeAreaDomEffect): void {
  if (!domEffect.reserveBottomCssVariable.startsWith('--')) {
    throw new Error('Safe-area DOM effect CSS variable must start with --')
  }
  for (const [label, name] of Object.entries({
    profile: domEffect.profileAttribute,
    orientation: domEffect.orientationAttribute,
    reserve: domEffect.reserveAttribute,
  })) {
    if (name !== undefined && !name.startsWith('data-')) {
      throw new Error(`Safe-area DOM effect ${label} attribute must start with data-`)
    }
  }
  for (const [label, property] of Object.entries({
    reserve: domEffect.windowStateProperty,
    result: domEffect.resultStateProperty,
  })) {
    if (property !== undefined && !/^__[A-Za-z][A-Za-z0-9_]*$/.test(property)) {
      throw new Error(`Safe-area DOM effect ${label} state property must use a private __name`)
    }
  }
}

function createSafeAreaBridgeForRollouts({
  domEffect,
  diagnosticOverride,
}: CreateReferenceSafeAreaBridgeOptions, rollouts: ReadonlySet<SafeAreaRollout>): SafeAreaBridgeProjection {
  const stableFrames = 2
  const timeoutMs = 3_000
  assertProfiles(safeAreaCompatibilityProfiles)
  assertDomEffect(domEffect)

  const runtimeProfiles = safeAreaCompatibilityProfiles
    .filter((profile) => rollouts.has(profile.rollout))
    .map((profile) => ({
      id: profile.id,
      platform: profile.platform,
      minimumRuntimeVersion: profile.minimumRuntimeVersion,
      displayMode: profile.displayMode,
      orientation: profile.orientation,
      screen: profile.screen,
      devicePixelRatio: profile.devicePixelRatio,
      reserve: profile.reserve,
    }))

  const diagnosticSelection = diagnosticOverride
    ? `const diagnosticOverride = ${JSON.stringify({
        enabledAttribute: diagnosticOverride.enabledAttribute,
        enabledValue: diagnosticOverride.enabledValue ?? 'true',
        queryParameter: diagnosticOverride.queryParameter,
        bottom: diagnosticOverride.bottom,
      })}
  const diagnosticEnabled = document.documentElement.getAttribute(diagnosticOverride.enabledAttribute) === diagnosticOverride.enabledValue
  const diagnosticBottom = Number(new URL(location.href).searchParams.get(diagnosticOverride.queryParameter))
  const selectedProfile = diagnosticEnabled && diagnosticBottom === diagnosticOverride.bottom
    ? { id: 'diagnostic-override', orientation, reserve: { bottom: diagnosticBottom } }
    : matchedProfile`
    : 'const selectedProfile = matchedProfile'

  const bootstrap = `(() => {
  const profiles = ${JSON.stringify(runtimeProfiles)}
  const domEffect = ${JSON.stringify(domEffect)}
  const applyDomUpdate = (update) => {
    const root = document.documentElement
    if (update.kind === 'reserve') {
      if (domEffect.profileAttribute) root.setAttribute(domEffect.profileAttribute, update.profile)
      if (domEffect.orientationAttribute) root.setAttribute(domEffect.orientationAttribute, update.orientation)
      if (domEffect.reserveAttribute) root.setAttribute(domEffect.reserveAttribute, String(update.bottom))
      root.style.setProperty(domEffect.reserveBottomCssVariable, update.bottom + 'px')
      if (domEffect.windowStateProperty) {
        window[domEffect.windowStateProperty] = {
          profile: update.profile,
          orientation: update.orientation,
          bottom: update.bottom,
        }
      }
      return
    }
    if (domEffect.reserveAttribute) root.removeAttribute(domEffect.reserveAttribute)
    root.style.removeProperty(domEffect.reserveBottomCssVariable)
    if (domEffect.windowStateProperty) window[domEffect.windowStateProperty] = undefined
    if (update.reason === 'orientation-changed') {
      if (domEffect.profileAttribute) root.removeAttribute(domEffect.profileAttribute)
      if (domEffect.orientationAttribute) root.removeAttribute(domEffect.orientationAttribute)
    }
  }
  const platform = /iPhone|iPad|iPod/.test(navigator.userAgent)
    ? 'ios'
    : /Android/.test(navigator.userAgent)
      ? 'android'
      : 'unknown'
  const versionMatch = platform === 'ios'
    ? navigator.userAgent.match(/Version[/](\\d+)[.](\\d+)/)
    : undefined
  const runtimeVersion = versionMatch ? [Number(versionMatch[1]), Number(versionMatch[2])] : undefined
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const orientation = matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'
  const versionAtLeast = (version, minimumVersion) => {
    if (!version) return false
    const value = version[0] * 1000 + version[1]
    const minimum = minimumVersion[0] * 1000 + minimumVersion[1]
    return value >= minimum
  }
  const matchedProfile = profiles.find((profile) =>
    profile.platform === platform &&
    versionAtLeast(runtimeVersion, profile.minimumRuntimeVersion) &&
    profile.displayMode === (standalone ? 'standalone' : 'browser') &&
    profile.orientation === orientation &&
    profile.screen.width === screen.width &&
    profile.screen.height === screen.height &&
    profile.devicePixelRatio === devicePixelRatio
  )
  ${diagnosticSelection}
  if (!selectedProfile) {
    if (domEffect.resultStateProperty) {
      window[domEffect.resultStateProperty] = { status: 'inactive' }
    }
    return
  }

  const bottom = selectedProfile.reserve.bottom
  const reserveUpdate = {
    kind: 'reserve',
    profile: selectedProfile.id,
    orientation: selectedProfile.orientation,
    bottom,
  }
  applyDomUpdate(reserveUpdate)

  let previousViewport
  let stableViewportFrames = 0
  let finished = false
  let nativeBottom = 0
  let timeoutHandle
  const reportResult = (status, reason, nativeBottom) => {
    if (!domEffect.resultStateProperty) return
    window[domEffect.resultStateProperty] = {
      profile: selectedProfile.id,
      status,
      reason,
      nativeBottom,
      bottom,
    }
  }
  const stopOrientationWatch = () => {
    window.removeEventListener('orientationchange', releaseForOrientationChange)
    window.removeEventListener('resize', releaseForOrientationChange)
  }
  const releaseForOrientationChange = () => {
    if (matchMedia('(orientation: portrait)').matches === (orientation === 'portrait')) return
    applyDomUpdate({ ...reserveUpdate, kind: 'release', reason: 'orientation-changed' })
    clearTimeout(timeoutHandle)
    finished = true
    stopOrientationWatch()
    reportResult('released', 'orientation-changed', nativeBottom)
  }
  const finish = (status, reason, nativeBottom, keepOrientationWatch = false) => {
    if (finished) return
    finished = true
    clearTimeout(timeoutHandle)
    if (!keepOrientationWatch) stopOrientationWatch()
    reportResult(status, reason, nativeBottom)
  }
  window.addEventListener('orientationchange', releaseForOrientationChange)
  window.addEventListener('resize', releaseForOrientationChange)
  timeoutHandle = setTimeout(() => {
    finish('unresolved', 'timeout', nativeBottom, true)
  }, ${timeoutMs})
  const sample = () => {
    if (finished) return
    if (matchMedia('(orientation: portrait)').matches !== (orientation === 'portrait')) {
      releaseForOrientationChange()
      return
    }
    if (document.visibilityState !== 'visible') {
      requestAnimationFrame(sample)
      return
    }
    const probe = document.querySelector('[data-document-shell-native-safe-area]')
    nativeBottom = probe ? Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0 : 0
    const viewport = [nativeBottom, innerWidth, innerHeight, window.visualViewport?.width ?? 0, window.visualViewport?.height ?? 0, window.visualViewport?.offsetTop ?? 0].join(':')
    stableViewportFrames = viewport === previousViewport ? stableViewportFrames + 1 : 1
    previousViewport = viewport
    if (nativeBottom >= bottom && stableViewportFrames >= ${stableFrames}) {
      applyDomUpdate({ ...reserveUpdate, kind: 'release', reason: 'native-stable' })
      finish('released', 'native-stable', nativeBottom)
      return
    }
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
})()`

  return {
    beforePaint: bootstrap as InlineScript,
    probeHtml:
      '    <div data-document-shell-native-safe-area aria-hidden="true" style="position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)"></div>' as HtmlFragment,
  }
}

export function createSafeAreaBridge(
  options: CreateSafeAreaBridgeOptions,
): SafeAreaBridgeProjection {
  return createSafeAreaBridgeForRollouts(options, new Set<SafeAreaRollout>(['sharedDefault']))
}

export function createReferenceSafeAreaBridge(
  options: CreateReferenceSafeAreaBridgeOptions,
): SafeAreaBridgeProjection {
  return createSafeAreaBridgeForRollouts(
    options,
    new Set<SafeAreaRollout>(['sharedDefault', 'referenceProduction']),
  )
}
