import { describe, expect, it, vi } from 'vitest'
import { applyQueuedUrlWriters, dispatchCommand } from './command-dispatch.ts'

function facade() {
  return {
    debug: { setUrlWriter: vi.fn(), setEnabled: vi.fn() },
  } as never as Parameters<typeof dispatchCommand>[0] & {
    debug: { setUrlWriter: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> }
  }
}

describe('queued debug.setUrlWriter', () => {
  it('registers a function and clears with null', () => {
    const api = facade()
    const writer = () => undefined
    dispatchCommand(api, ['debug.setUrlWriter', writer])
    dispatchCommand(api, ['debug.setUrlWriter', null])
    expect(api.debug.setUrlWriter.mock.calls).toEqual([[writer], [null]])
  })

  it('ignores any other argument', () => {
    const api = facade()
    dispatchCommand(api, ['debug.setUrlWriter', undefined])
    dispatchCommand(api, ['debug.setUrlWriter', 'replace'])
    dispatchCommand(api, ['debug.setUrlWriter'])
    expect(api.debug.setUrlWriter).not.toHaveBeenCalled()
  })
})

describe('applyQueuedUrlWriters', () => {
  it('applies queued writers in order before startup and ignores everything else', () => {
    const setUrlWriter = vi.fn()
    const first = () => undefined
    const second = () => undefined
    applyQueuedUrlWriters(
      [
        ['debug.setEnabled', true],
        ['debug.setUrlWriter', first],
        ['debug.setUrlWriter', 'replace'],
        'not-a-command',
        ['debug.setUrlWriter', second],
      ],
      { setUrlWriter } as never,
    )
    expect(setUrlWriter.mock.calls).toEqual([[first], [second]])
  })
})
