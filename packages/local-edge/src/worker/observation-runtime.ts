import type { KernelObservationIdentity } from '../revalidation-observation.ts'

const maxSnapshotReadAttempts = 8
const kernelInstanceId = crypto.randomUUID()
let observationRevision = 0
let lifecycleVersion = 0
let lifecycleTail: Promise<void> = Promise.resolve()

export function currentKernelObservationIdentity(): KernelObservationIdentity {
  return { kernelInstanceId, observationRevision }
}

export function advanceKernelObservation(): KernelObservationIdentity {
  if (observationRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('kernel observation revision exhausted')
  }
  observationRevision += 1
  return currentKernelObservationIdentity()
}

export async function runKernelLifecycleMutation<T>(
  mutate: () => Promise<T>,
): Promise<T> {
  const previous = lifecycleTail
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  lifecycleTail = previous.then(() => gate)

  await previous
  lifecycleVersion += 1
  try {
    return await mutate()
  } finally {
    lifecycleVersion += 1
    release()
  }
}

export async function readStableKernelObservation<T>(
  readDurableState: () => Promise<T>,
  readMemoryState: () => unknown,
): Promise<{
  durableState: T
  memoryState: unknown
  identity: KernelObservationIdentity
}> {
  for (let attempt = 0; attempt < maxSnapshotReadAttempts; attempt += 1) {
    const pendingLifecycle = lifecycleTail
    await pendingLifecycle
    const version = lifecycleVersion
    const durableState = await readDurableState()
    const memoryState = structuredClone(readMemoryState())
    const identity = currentKernelObservationIdentity()
    if (version === lifecycleVersion) {
      return { durableState, memoryState, identity }
    }
  }

  throw new Error('kernel observation changed during snapshot read')
}

export const kernelObservationTest = {
  maxSnapshotReadAttempts,
}
