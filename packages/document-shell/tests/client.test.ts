import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import {
  commitDocumentShellRuntime,
  documentShellReadyAttribute,
  documentShellRevealNotBeforeAttribute,
  documentShellRuntimeStylesheetId,
  documentShellStaticAttribute,
} from '../src/client.ts'

type StylesheetFixtureState = 'loaded' | 'error' | 'timeout' | 'absent' | 'pending'

const realDateNow = Date.now

after(() => {
  Date.now = realDateNow
})

function installDocument(stylesheetState: StylesheetFixtureState = 'pending') {
  // Deterministic clock: hold timers fire at the fixture's discretion, so the
  // client re-reads `Date.now()` to decide whether a held deadline elapsed.
  let now = realDateNow()
  Date.now = () => now
  const attributes = new Map<string, string>()
  const projectionAttributes = new Map<string, string>()
  const frames: FrameRequestCallback[] = []
  const timers = new Map<number, TimerHandler>()
  const clearedTimers: number[] = []
  let nextTimerId = 0
  let removed = 0
  const projection = {
    getAttribute(name: string) {
      return projectionAttributes.get(name) ?? null
    },
    setAttribute(name: string, value: string) {
      projectionAttributes.set(name, value)
    },
    remove() {
      removed += 1
    },
  }
  const stylesheet = Object.assign(new EventTarget(), {
    dataset: {
      ...(stylesheetState === 'loaded' ? { loaded: 'true' } : {}),
      ...(stylesheetState === 'error' || stylesheetState === 'timeout'
        ? { failure: stylesheetState }
        : {}),
      failureDeadline: String(now + 3_000),
    },
  }) as unknown as HTMLLinkElement
  const fakeDocument = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
    },
    getElementById(id: string) {
      return id === documentShellRuntimeStylesheetId && stylesheetState !== 'absent'
        ? stylesheet
        : null
    },
    querySelector(selector: string) {
      if (selector === `[${documentShellStaticAttribute}]`) return projection
      return null
    },
  } as unknown as Document
  const fakeWindow = {
    cancelAnimationFrame() {},
    clearTimeout(timer: number) {
      clearedTimers.push(timer)
      timers.delete(timer)
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.push(callback)
      return frames.length
    },
    setTimeout(callback: TimerHandler) {
      nextTimerId += 1
      timers.set(nextTimerId, callback)
      return nextTimerId
    },
  } as unknown as Window & typeof globalThis
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })

  return {
    advance(milliseconds: number) {
      now += milliseconds
    },
    attributes,
    clearedTimers,
    fireFrame: () => frames.shift()?.(0),
    fireTimer(id: number) {
      const callback = timers.get(id)
      timers.delete(id)
      if (typeof callback === 'function') callback()
    },
    frames,
    now: () => now,
    projection,
    removed: () => removed,
    setDeadline(deadline: number) {
      projection.setAttribute(documentShellRevealNotBeforeAttribute, String(deadline))
    },
    stylesheet,
    timerCount: () => timers.size,
  }
}

test('waits for stylesheet application and commits a document-level handoff once', async () => {
  const runtime = installDocument()
  const first = commitDocumentShellRuntime()
  const repeated = commitDocumentShellRuntime()

  assert.equal(first, repeated)
  assert.equal(runtime.attributes.has(documentShellReadyAttribute), false)
  runtime.stylesheet.dispatchEvent(new Event('load'))
  assert.equal(runtime.attributes.has(documentShellReadyAttribute), false)
  assert.equal(runtime.frames.length, 1)
  assert.deepEqual(runtime.clearedTimers, [1])
  runtime.fireFrame()

  assert.deepEqual(await first, { status: 'revealed', stylesheet: 'loaded' })
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
})

test('holds a loaded reveal until a declared future deadline and reveals once', async () => {
  const runtime = installDocument()
  const handoff = commitDocumentShellRuntime()

  // The skeleton becomes visible while the stylesheet is still loading and the
  // parser startup effect declares a reveal-not-before deadline inside the
  // runtime stylesheet gate.
  const deadline = runtime.now() + 800
  runtime.setDeadline(deadline)
  runtime.stylesheet.dispatchEvent(new Event('load'))
  assert.equal(runtime.frames.length, 1)
  runtime.fireFrame()

  // The loaded gate completed before the deadline: no readiness and no
  // projection removal until the deadline.
  assert.equal(runtime.attributes.has(documentShellReadyAttribute), false)
  assert.equal(runtime.removed(), 0)
  assert.equal(runtime.timerCount(), 1)

  // Repeating the commit while the hold is pending returns the same promise
  // and does not create a second timer.
  assert.equal(commitDocumentShellRuntime(), handoff)
  assert.equal(runtime.timerCount(), 1)

  // The deadline is still in the future when its timer fires early: the hold
  // reschedules instead of revealing early or dropping the handoff.
  runtime.fireTimer(2)
  assert.equal(runtime.attributes.has(documentShellReadyAttribute), false)
  assert.equal(runtime.timerCount(), 1)

  // Advancing past the deadline reveals exactly once.
  runtime.advance(801)
  runtime.fireTimer(3)
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
  assert.equal(runtime.timerCount(), 0)
  assert.deepEqual(await handoff, { status: 'revealed', stylesheet: 'loaded' })
  assert.equal(commitDocumentShellRuntime(), handoff)
  assert.equal(runtime.removed(), 1)
})

test('honors a deadline declared after load but before the apply frame', async () => {
  const runtime = installDocument()
  const handoff = commitDocumentShellRuntime()

  // The stylesheet load completes before the declaration lands; the deadline
  // is sampled when the loaded reveal is about to run, so the frame gate
  // still defers past the newly declared future deadline.
  runtime.stylesheet.dispatchEvent(new Event('load'))
  runtime.setDeadline(runtime.now() + 400)
  runtime.fireFrame()

  assert.equal(runtime.attributes.has(documentShellReadyAttribute), false)
  assert.equal(runtime.removed(), 0)
  runtime.advance(401)
  runtime.fireTimer(2)
  assert.deepEqual(await handoff, { status: 'revealed', stylesheet: 'loaded' })
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
})

test('reveals immediately when the loaded deadline is absent, invalid, or expired', async () => {
  const scenarios: Array<{ name: string; rawAttribute?: string }> = [
    { name: 'absent' },
    { name: 'non-numeric', rawAttribute: 'not-a-deadline' },
    { name: 'empty string', rawAttribute: '' },
    { name: 'infinity', rawAttribute: 'Infinity' },
    { name: 'zero', rawAttribute: '0' },
    { name: 'negative', rawAttribute: '-5' },
  ]
  for (const scenario of scenarios) {
    const runtime = installDocument('loaded')
    if (scenario.rawAttribute !== undefined) {
      runtime.projection.setAttribute(
        documentShellRevealNotBeforeAttribute,
        scenario.rawAttribute,
      )
    }
    const handoff = commitDocumentShellRuntime()
    assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true', scenario.name)
    assert.equal(runtime.removed(), 1, scenario.name)
    assert.equal(runtime.timerCount(), 0, scenario.name)
    assert.deepEqual(await handoff, { status: 'revealed', stylesheet: 'loaded' }, scenario.name)
  }

  const expired = installDocument('loaded')
  expired.projection.setAttribute(
    documentShellRevealNotBeforeAttribute,
    String(expired.now() - 1),
  )
  const expiredHandoff = commitDocumentShellRuntime()
  assert.equal(expired.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(expired.removed(), 1)
  assert.equal(expired.timerCount(), 0)
  assert.deepEqual(await expiredHandoff, { status: 'revealed', stylesheet: 'loaded' })
})

test('ignores a loaded deadline beyond the runtime stylesheet fail-open gate', async () => {
  const runtime = installDocument('loaded')
  runtime.setDeadline(runtime.now() + 60_000)
  const handoff = commitDocumentShellRuntime()

  // A far-future declaration cannot pin the inert projection: it lies outside
  // the stylesheet gate's recorded fail-open deadline, so the loaded handoff
  // treats it as expired and reveals immediately.
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
  assert.equal(runtime.timerCount(), 0)
  assert.deepEqual(await handoff, { status: 'revealed', stylesheet: 'loaded' })
})

test('fails open if the stylesheet errors while a loaded reveal hold is pending', async () => {
  const runtime = installDocument()
  const handoff = commitDocumentShellRuntime()

  runtime.setDeadline(runtime.now() + 800)
  runtime.stylesheet.dispatchEvent(new Event('load'))
  runtime.fireFrame()
  assert.equal(runtime.timerCount(), 1)

  runtime.stylesheet.dispatchEvent(new Event('error'))

  assert.deepEqual(await handoff, { status: 'revealed', stylesheet: 'error' })
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
  assert.equal(runtime.timerCount(), 0)
})

test('declared deadlines never block error, timeout, or absent fail-open reveals', async () => {
  const deadline = 60_000

  const failed = installDocument('error')
  failed.setDeadline(failed.now() + deadline)
  assert.deepEqual(await commitDocumentShellRuntime(), {
    status: 'revealed',
    stylesheet: 'error',
  })
  assert.equal(failed.removed(), 1)

  const timedOut = installDocument('timeout')
  timedOut.setDeadline(timedOut.now() + deadline)
  assert.deepEqual(await commitDocumentShellRuntime(), {
    status: 'revealed',
    stylesheet: 'timeout',
  })
  assert.equal(timedOut.removed(), 1)

  const absent = installDocument('absent')
  absent.setDeadline(absent.now() + deadline)
  assert.deepEqual(await commitDocumentShellRuntime(), {
    status: 'revealed',
    stylesheet: 'absent',
  })
  assert.equal(absent.removed(), 1)
})

test('treats stylesheet failure and timeout as non-throwing terminal results', async () => {
  const failed = installDocument('error')
  assert.deepEqual(await commitDocumentShellRuntime(), {
    status: 'revealed',
    stylesheet: 'error',
  })
  assert.equal(failed.removed(), 1)

  const timedOut = installDocument('timeout')
  assert.deepEqual(await commitDocumentShellRuntime(), {
    status: 'revealed',
    stylesheet: 'timeout',
  })
  assert.equal(timedOut.removed(), 1)
})
