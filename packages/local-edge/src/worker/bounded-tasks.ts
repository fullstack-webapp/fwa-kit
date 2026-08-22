export async function runBoundedTasks<T>(
  items: readonly T[],
  concurrency: number,
  runTask: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('bounded task concurrency must be a positive integer')
  }

  let nextIndex = 0
  let hasFailure = false
  let firstFailure: unknown

  const runWorker = async () => {
    while (!hasFailure) {
      const itemIndex = nextIndex
      nextIndex += 1
      if (itemIndex >= items.length) {
        return
      }

      try {
        await runTask(items[itemIndex])
      } catch (error) {
        if (!hasFailure) {
          hasFailure = true
          firstFailure = error
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker(),
    ),
  )

  if (hasFailure) {
    throw firstFailure
  }
}
