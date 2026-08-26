import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commitDocumentShellRuntime,
  documentShellReadyAttribute,
  documentShellRuntimeStylesheetId,
} from '../src/client.ts'

function installDocument(stylesheetState?: 'loaded' | 'error' | 'timeout') {
  const attributes = new Map<string, string>()
  const frames: FrameRequestCallback[] = []
  const timers: TimerHandler[] = []
  const clearedTimers: number[] = []
  let removed = 0
  const stylesheet = Object.assign(new EventTarget(), {
    dataset: {
      ...(stylesheetState === 'loaded' ? { loaded: 'true' } : {}),
      ...(stylesheetState === 'error' || stylesheetState === 'timeout'
        ? { failure: stylesheetState }
        : {}),
      failureDeadline: String(Date.now() + 3_000),
    },
  }) as unknown as HTMLLinkElement
  const fakeDocument = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
    },
    getElementById(id: string) {
      return id === documentShellRuntimeStylesheetId ? stylesheet : null
    },
    querySelector() {
      return {
        remove() {
          removed += 1
        },
      }
    },
  } as unknown as Document
  const fakeWindow = {
    cancelAnimationFrame() {},
    clearTimeout(timer: number) {
      clearedTimers.push(timer)
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.push(callback)
      return frames.length
    },
    setTimeout(callback: TimerHandler) {
      timers.push(callback)
      return timers.length
    },
  } as unknown as Window & typeof globalThis
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })

  return {
    attributes,
    clearedTimers,
    frames,
    removed: () => removed,
    stylesheet,
    timers,
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
  runtime.frames.shift()?.(0)

  assert.deepEqual(await first, { status: 'revealed', stylesheet: 'loaded' })
  assert.equal(runtime.attributes.get(documentShellReadyAttribute), 'true')
  assert.equal(runtime.removed(), 1)
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
