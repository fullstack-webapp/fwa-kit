import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

import { createSafeAreaBridge, type SafeAreaDomEffect } from '../src/document-shell.ts'
import { createReferenceSafeAreaBridge } from '../src/reference.ts'

const domEffect: SafeAreaDomEffect = {
  reserveBottomCssVariable: '--consumer-safe-area-bottom',
  profileAttribute: 'data-consumer-safe-area-profile',
  orientationAttribute: 'data-consumer-safe-area-orientation',
  reserveAttribute: 'data-consumer-safe-area-reserve',
  windowStateProperty: '__lastSafeAreaUpdate',
  resultStateProperty: '__lastSafeAreaResult',
}

declare global {
  // Test-only property name projected through the declarative DOM effect.
  var __lastSafeAreaUpdate: unknown
}

function runBridge(
  projection: ReturnType<typeof createReferenceSafeAreaBridge>,
  nativeBottoms: number[],
) {
  const attributes = new Map<string, string>()
  const properties = new Map<string, string>()
  const frames: Array<(timestamp: number) => void> = []
  const timers: Array<() => void> = []
  const listeners = new Map<string, Set<() => void>>()
  let portrait = true
  const root = {
    setAttribute(name: string, value: string) {
      attributes.set(name, value)
    },
    removeAttribute(name: string) {
      attributes.delete(name)
    },
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value)
      },
      removeProperty(name: string) {
        properties.delete(name)
      },
    },
  }
  const document = {
    documentElement: root,
    visibilityState: 'visible',
    querySelector(selector: string) {
      return selector === '[data-document-shell-native-safe-area]' ? {} : null
    },
  }
  const window: Record<string, unknown> = {
    addEventListener(event: string, listener: () => void) {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    removeEventListener(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener)
    },
    visualViewport: { width: 402, height: 874, offsetTop: 0 },
  }
  runInNewContext(projection.beforePaint, {
    URL,
    clearTimeout() {},
    devicePixelRatio: 3,
    document,
    getComputedStyle() {
      return { paddingBottom: `${nativeBottoms.shift() ?? 0}px` }
    },
    innerHeight: 874,
    innerWidth: 402,
    location: { href: 'https://example.test/' },
    matchMedia(query: string) {
      return {
        matches: query === '(display-mode: standalone)' ||
          (query === '(orientation: portrait)' && portrait),
      }
    },
    navigator: {
      standalone: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1',
    },
    requestAnimationFrame(callback: (timestamp: number) => void) {
      frames.push(callback)
      return frames.length
    },
    screen: { width: 402, height: 874 },
    setTimeout(callback: () => void) {
      timers.push(callback)
      return timers.length
    },
    window,
  })
  return {
    attributes,
    properties,
    runFrame() {
      const frame = frames.shift()
      assert.ok(frame, 'bridge scheduled an animation frame')
      frame(0)
    },
    runTimeout() {
      const timer = timers.shift()
      assert.ok(timer, 'bridge scheduled a timeout')
      timer()
    },
    setPortrait(value: boolean) {
      portrait = value
      for (const listener of listeners.get('resize') ?? []) listener()
    },
    setVisibility(value: string) {
      document.visibilityState = value
    },
    window,
  }
}

test('projects only the verified shared-default profile through the root entry', () => {
  const projection = createSafeAreaBridge({ domEffect })

  assert.doesNotMatch(projection.beforePaint, /ios-375x812-3x-portrait-standalone/)
  assert.doesNotMatch(projection.beforePaint, /ios-393x852-3x-portrait-standalone/)
  assert.match(projection.beforePaint, /ios-402x874-3x-portrait-standalone/)
  assert.doesNotMatch(projection.beforePaint, /ios-430x932-3x-portrait-standalone/)
  assert.doesNotMatch(projection.beforePaint, /"maturity":/)
  assert.doesNotMatch(projection.beforePaint, /"rollout":/)
})

test('applies the verified shared-default reserve before native inset stability', () => {
  const runtime = runBridge(createSafeAreaBridge({ domEffect }), [])

  assert.equal(runtime.properties.get('--consumer-safe-area-bottom'), '34px')
  assert.equal(
    runtime.attributes.get('data-consumer-safe-area-profile'),
    'ios-402x874-3x-portrait-standalone',
  )
})

test('projects reference profiles and a bounded release sampler through the reference entry', () => {
  const projection = createReferenceSafeAreaBridge({ domEffect })

  assert.match(projection.beforePaint, /ios-375x812-3x-portrait-standalone/)
  assert.match(projection.beforePaint, /ios-393x852-3x-portrait-standalone/)
  assert.match(projection.beforePaint, /ios-402x874-3x-portrait-standalone/)
  assert.match(projection.beforePaint, /ios-430x932-3x-portrait-standalone/)
  assert.doesNotMatch(projection.beforePaint, /"maturity":/)
  assert.doesNotMatch(projection.beforePaint, /"rollout":/)
  assert.doesNotMatch(projection.beforePaint, /diagnosticOverride/)
  assert.match(projection.beforePaint, /minimumRuntimeVersion/)
  assert.doesNotMatch(projection.beforePaint, /maximumExclusive/)
  assert.match(projection.beforePaint, /Version\[\/\]/)
  assert.doesNotMatch(projection.beforePaint, /CPU \(\?:iPhone /)
  assert.match(projection.beforePaint, /--consumer-safe-area-bottom/)
  assert.match(projection.beforePaint, /data-consumer-safe-area-reserve/)
  assert.match(projection.beforePaint, /stableViewportFrames >= 2/)
  assert.match(projection.beforePaint, /document\.visibilityState !== 'visible'/)
  assert.match(projection.beforePaint, /\[nativeBottom, innerWidth/)
  assert.match(projection.beforePaint, /reason: 'orientation-changed'/)
  assert.match(projection.beforePaint, /setTimeout\(\(\) =>/)
  assert.match(projection.beforePaint, /clearTimeout\(timeoutHandle\)/)
  assert.match(projection.beforePaint, /}, 3000\)/)
  assert.match(projection.probeHtml, /padding-bottom:env\(safe-area-inset-bottom\)/)
  assert.doesNotMatch(projection.probeHtml, /compact-tabbar|document-shell-safe-area-reserve/)
})

test('projects a diagnostic DOM gate without serializing consumer callbacks', () => {
  const projection = createReferenceSafeAreaBridge({
    domEffect,
    diagnosticOverride: {
      enabledAttribute: 'data-consumer-probe-enabled',
      queryParameter: 'safeAreaReserve',
      bottom: 34,
    },
  })

  assert.match(projection.beforePaint, /data-consumer-probe-enabled/)
  assert.doesNotMatch(projection.beforePaint, /toString\(\)/)
})

test('waits for two stable raw inset frames before releasing the reserve', () => {
  const runtime = runBridge(createReferenceSafeAreaBridge({ domEffect }), [0, 34, 34])

  runtime.runFrame()
  runtime.runFrame()
  assert.equal(runtime.properties.get('--consumer-safe-area-bottom'), '34px')
  runtime.runFrame()
  assert.equal(runtime.properties.has('--consumer-safe-area-bottom'), false)
})

test('releases the reserve from the DOM when orientation changes', () => {
  const runtime = runBridge(createReferenceSafeAreaBridge({ domEffect }), [])

  runtime.setPortrait(false)
  runtime.runFrame()

  assert.equal(runtime.properties.has('--consumer-safe-area-bottom'), false)
  assert.equal(runtime.attributes.has('data-consumer-safe-area-reserve'), false)
  assert.equal(runtime.attributes.has('data-consumer-safe-area-profile'), false)
  assert.equal(runtime.attributes.has('data-consumer-safe-area-orientation'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.__lastSafeAreaResult)), {
    profile: 'ios-402x874-3x-portrait-standalone',
    status: 'released',
    reason: 'orientation-changed',
    nativeBottom: 0,
    bottom: 34,
  })
})

test('does not count hidden animation frames toward native stability', () => {
  const runtime = runBridge(createReferenceSafeAreaBridge({ domEffect }), [34, 34])

  runtime.setVisibility('hidden')
  runtime.runFrame()
  runtime.setVisibility('visible')
  runtime.runFrame()
  assert.equal(runtime.properties.get('--consumer-safe-area-bottom'), '34px')
  runtime.runFrame()
  assert.equal(runtime.properties.has('--consumer-safe-area-bottom'), false)
})

test('stops at the deadline without releasing an unresolved reserve', () => {
  const runtime = runBridge(createReferenceSafeAreaBridge({ domEffect }), [])

  runtime.runTimeout()

  assert.equal(runtime.properties.get('--consumer-safe-area-bottom'), '34px')
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.__lastSafeAreaResult)), {
    profile: 'ios-402x874-3x-portrait-standalone',
    status: 'unresolved',
    reason: 'timeout',
    nativeBottom: 0,
    bottom: 34,
  })
})

test('keeps only the orientation release active after the sampling deadline', () => {
  const runtime = runBridge(createReferenceSafeAreaBridge({ domEffect }), [])

  runtime.runTimeout()
  runtime.setPortrait(false)

  assert.equal(runtime.properties.has('--consumer-safe-area-bottom'), false)
  assert.equal(runtime.attributes.has('data-consumer-safe-area-reserve'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.window.__lastSafeAreaResult)), {
    profile: 'ios-402x874-3x-portrait-standalone',
    status: 'released',
    reason: 'orientation-changed',
    nativeBottom: 0,
    bottom: 34,
  })
})

test('rejects invalid DOM effects before emitting a bootstrap', () => {
  assert.throws(
    () => createSafeAreaBridge({
      domEffect: { ...domEffect, windowStateProperty: 'location' },
    }),
    /reserve state property must use a private __name/,
  )
})
