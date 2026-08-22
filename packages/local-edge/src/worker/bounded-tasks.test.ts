import { describe, expect, it } from 'vitest'
import { runBoundedTasks } from './bounded-tasks.ts'

describe('runBoundedTasks', () => {
  it('limits concurrent work and completes every item', async () => {
    let activeTasks = 0
    let maxActiveTasks = 0
    const completed: number[] = []

    await runBoundedTasks([0, 1, 2, 3, 4, 5, 6], 3, async (item) => {
      activeTasks += 1
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks)
      await Promise.resolve()
      completed.push(item)
      activeTasks -= 1
    })

    expect(maxActiveTasks).toBe(3)
    expect(completed.sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ])
  })

  it('waits for in-flight work before surfacing the first failure', async () => {
    let activeTasks = 0

    await expect(
      runBoundedTasks([0, 1, 2, 3], 2, async (item) => {
        activeTasks += 1
        try {
          await Promise.resolve()
          if (item === 1) {
            throw new Error('candidate asset failed')
          }
        } finally {
          activeTasks -= 1
        }
      }),
    ).rejects.toThrow('candidate asset failed')
    expect(activeTasks).toBe(0)
  })

  it('rejects invalid concurrency', async () => {
    await expect(runBoundedTasks([], 0, async () => {})).rejects.toThrow(
      'positive integer',
    )
  })
})
