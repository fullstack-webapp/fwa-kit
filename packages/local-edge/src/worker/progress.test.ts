import { describe, expect, it } from 'vitest'
import {
  beginRevalidationInstall,
  recordCompletedAsset,
  revalidationProgressBroadcastIntervalMs,
  shouldBroadcastRevalidationProgress,
} from './progress.ts'

describe('shouldBroadcastRevalidationProgress', () => {
  it('passes the first progress message without a prior broadcast', () => {
    expect(
      shouldBroadcastRevalidationProgress(1000, undefined, 1, 10),
    ).toBe(true)
  })

  it('suppresses messages inside the broadcast interval', () => {
    expect(shouldBroadcastRevalidationProgress(1000, 900, 2, 10)).toBe(false)
    expect(
      shouldBroadcastRevalidationProgress(
        1000 + revalidationProgressBroadcastIntervalMs - 1,
        1000,
        3,
        10,
      ),
    ).toBe(false)
  })

  it('passes messages at or after the broadcast interval', () => {
    expect(
      shouldBroadcastRevalidationProgress(
        1000 + revalidationProgressBroadcastIntervalMs,
        1000,
        4,
        10,
      ),
    ).toBe(true)
  })

  it('always passes the final progress message regardless of the interval', () => {
    expect(shouldBroadcastRevalidationProgress(1000, 1000, 10, 10)).toBe(true)
    expect(shouldBroadcastRevalidationProgress(500, 1, 3, 3)).toBe(true)
  })

  it('never broadcasts an empty or invalid install', () => {
    expect(shouldBroadcastRevalidationProgress(0, undefined, 0, 0)).toBe(false)
    expect(shouldBroadcastRevalidationProgress(0, undefined, 1, 0)).toBe(false)
  })
})

describe('revalidation install bookkeeping', () => {
  it('yields a monotonic completed sequence with interval throttling', () => {
    let state = beginRevalidationInstall('release-x', 5)
    expect(state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 0,
      totalAssets: 5,
    })

    let first = recordCompletedAsset(state, 0)
    state = first.state
    expect(state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 1,
      totalAssets: 5,
    })
    expect(state.lastBroadcastAtMs).toBe(0)
    expect(first.shouldBroadcast).toBe(true)

    let throttled = recordCompletedAsset(state, 100)
    state = throttled.state
    expect(state.progress?.completedAssets).toBe(2)
    expect(state.lastBroadcastAtMs).toBe(0)
    expect(throttled.shouldBroadcast).toBe(false)

    let interval = recordCompletedAsset(state, 250)
    state = interval.state
    expect(state.progress?.completedAssets).toBe(3)
    expect(state.lastBroadcastAtMs).toBe(250)
    expect(interval.shouldBroadcast).toBe(true)

    throttled = recordCompletedAsset(state, 260)
    state = throttled.state
    expect(state.progress?.completedAssets).toBe(4)
    expect(state.lastBroadcastAtMs).toBe(250)
    expect(throttled.shouldBroadcast).toBe(false)

    first = recordCompletedAsset(state, 260)
    state = first.state
    expect(state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 5,
      totalAssets: 5,
    })
    expect(state.lastBroadcastAtMs).toBe(260)
    expect(first.shouldBroadcast).toBe(true)
  })

  it('requests the final broadcast even in the same millisecond as the previous broadcast', () => {
    let state = beginRevalidationInstall('release-x', 3)

    let step = recordCompletedAsset(state, 500)
    state = step.state
    expect(step.shouldBroadcast).toBe(true)

    step = recordCompletedAsset(state, 500)
    state = step.state
    expect(step.shouldBroadcast).toBe(false)

    step = recordCompletedAsset(state, 500)
    expect(step.state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 3,
      totalAssets: 3,
    })
    expect(step.state.lastBroadcastAtMs).toBe(500)
    expect(step.shouldBroadcast).toBe(true)
  })

  it('never requests a broadcast for an empty install', () => {
    const state = beginRevalidationInstall('release-x', 0)
    expect(
      shouldBroadcastRevalidationProgress(0, state.lastBroadcastAtMs, 1, 0),
    ).toBe(false)
  })
})
