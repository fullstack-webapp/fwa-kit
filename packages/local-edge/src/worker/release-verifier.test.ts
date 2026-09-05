import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const combinedController = new AbortController()
const timeoutController = new AbortController()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('self', {
    location: { origin: 'https://app.test' },
  })
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal)
  vi.spyOn(AbortSignal, 'any').mockReturnValue(combinedController.signal)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('release fetch deadlines', () => {
  it('bounds descriptor fetches without replacing the caller signal', async () => {
    const caller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(combinedController.signal)
        throw new DOMException('timed out', 'TimeoutError')
      }),
    )
    const { fetchVerifiedReleaseDescriptor } = await import(
      './release-verifier.ts'
    )

    await expect(
      fetchVerifiedReleaseDescriptor(caller.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000)
    expect(AbortSignal.any).toHaveBeenCalledWith([
      caller.signal,
      timeoutController.signal,
    ])
  })

  it('bounds each asset fetch independently', async () => {
    const caller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBe(combinedController.signal)
        throw new DOMException('timed out', 'TimeoutError')
      }),
    )
    const { fetchVerifiedAsset } = await import('./release-verifier.ts')

    await expect(
      fetchVerifiedAsset(
        {
          path: '/asset.js',
          mediaType: 'application/javascript',
          size: 1,
          digest: `sha256:${'0'.repeat(64)}`,
        },
        caller.signal,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000)
    expect(AbortSignal.any).toHaveBeenCalledWith([
      caller.signal,
      timeoutController.signal,
    ])
  })
})
