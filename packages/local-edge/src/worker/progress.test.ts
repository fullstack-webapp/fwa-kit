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

    state = recordCompletedAsset(state, 0)
    expect(state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 1,
      totalAssets: 5,
    })
    expect(state.lastBroadcastAtMs).toBe(0)

    state = recordCompletedAsset(state, 100)
    expect(state.progress?.completedAssets).toBe(2)
    expect(state.lastBroadcastAtMs).toBe(0)

    state = recordCompletedAsset(state, 250)
    expect(state.progress?.completedAssets).toBe(3)
    expect(state.lastBroadcastAtMs).toBe(250)

    state = recordCompletedAsset(state, 260)
    expect(state.progress?.completedAssets).toBe(4)
    expect(state.lastBroadcastAtMs).toBe(250)

    state = recordCompletedAsset(state, 260)
    expect(state.progress).toEqual({
      releaseId: 'release-x',
      completedAssets: 5,
      totalAssets: 5,
    })
    expect(state.lastBroadcastAtMs).toBe(260)
  })
})
