import { afterEach, describe, expect, it, vi } from 'vitest'

describe('worker observation runtime', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('uses one instance id and a strictly increasing revision', async () => {
    const runtime = await import('./observation-runtime.ts')
    const initial = runtime.currentKernelObservationIdentity()
    const first = runtime.advanceKernelObservation()
    const second = runtime.advanceKernelObservation()

    expect(first.kernelInstanceId).toBe(initial.kernelInstanceId)
    expect(first.observationRevision).toBe(initial.observationRevision + 1)
    expect(second.observationRevision).toBe(first.observationRevision + 1)
  })

  it('pairs a durable read with the newest progress revision without retrying', async () => {
    const runtime = await import('./observation-runtime.ts')
    let reads = 0
    const snapshot = await runtime.readStableKernelObservation(
      async () => {
        reads += 1
        runtime.advanceKernelObservation()
        return { read: reads }
      },
      () => ({ progress: reads }),
    )

    expect(reads).toBe(1)
    expect(snapshot).toMatchObject({
      durableState: { read: 1 },
      memoryState: { progress: 1 },
      identity: { observationRevision: 1 },
    })
  })

  it('bounds snapshot retries under continuous mutation', async () => {
    const runtime = await import('./observation-runtime.ts')
    let reads = 0

    await expect(
      runtime.readStableKernelObservation(
        async () => {
          reads += 1
          await runtime.runKernelLifecycleMutation(async () => undefined)
          return undefined
        },
        () => undefined,
      ),
    ).rejects.toThrow('changed during snapshot read')
    expect(reads).toBe(runtime.kernelObservationTest.maxSnapshotReadAttempts)
  })

  it('keeps snapshots behind a lifecycle publication window', async () => {
    const runtime = await import('./observation-runtime.ts')
    let publish!: () => void
    const gate = new Promise<void>((resolve) => {
      publish = resolve
    })
    let visible = 'before'
    const mutation = runtime.runKernelLifecycleMutation(async () => {
      await gate
      visible = 'after'
      runtime.advanceKernelObservation()
    })

    const snapshot = runtime.readStableKernelObservation(
      async () => ({ visible }),
      () => ({ visible }),
    )
    await Promise.resolve()
    publish()
    await mutation

    await expect(snapshot).resolves.toMatchObject({
      durableState: { visible: 'after' },
      memoryState: { visible: 'after' },
    })
  })
})
