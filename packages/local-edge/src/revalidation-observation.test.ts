import { describe, expect, it } from 'vitest'
import {
  isOrderedLocalEdgeSnapshot,
  reduceRevalidationObservation,
  type RevalidationObservationCursor,
} from './revalidation-observation.ts'

const instanceA = 'instance-a'
const instanceB = 'instance-b'

function progress(
  revision: number,
  completedAssets: number,
  options: {
    instance?: string
    attemptId?: number
    releaseId?: string
    totalAssets?: number
  } = {},
) {
  const kernelInstanceId = options.instance ?? instanceA
  const attemptId = options.attemptId ?? 1
  const releaseId = options.releaseId ?? 'release-a'
  const totalAssets = options.totalAssets ?? 12
  return {
    kind: 'progress' as const,
    identity: { kernelInstanceId, observationRevision: revision },
    attempt: { attemptId, releaseId, totalAssets },
    completedAssets,
  }
}

function terminal(
  revision: number,
  options: {
    instance?: string
    attemptId?: number
    releaseId?: string
  } = {},
) {
  return {
    kind: 'terminal' as const,
    identity: {
      kernelInstanceId: options.instance ?? instanceA,
      observationRevision: revision,
    },
    attempt: {
      attemptId: options.attemptId ?? 1,
      releaseId: options.releaseId ?? 'release-a',
    },
  }
}

function snapshot(
  revision: number,
  options: {
    instance?: string
    running?: boolean
    attemptId?: number
    releaseId?: string
    completedAssets?: number
    totalAssets?: number
  } = {},
) {
  const kernelInstanceId = options.instance ?? instanceA
  return {
    kind: 'snapshot' as const,
    identity: { kernelInstanceId, observationRevision: revision },
    ...(options.running
      ? {
          progress: {
            kernelInstanceId,
            observationRevision: revision,
            attemptId: options.attemptId ?? 1,
            releaseId: options.releaseId ?? 'release-a',
            completedAssets: options.completedAssets ?? 1,
            totalAssets: options.totalAssets ?? 12,
          },
        }
      : undefined),
  }
}

function apply(
  cursor: RevalidationObservationCursor,
  observation:
    | ReturnType<typeof progress>
    | ReturnType<typeof terminal>
    | ReturnType<typeof snapshot>,
) {
  return reduceRevalidationObservation(cursor, observation)
}

describe('ordered observation validation', () => {
  it('accepts an identified post-reset network-only snapshot', () => {
    expect(
      isOrderedLocalEdgeSnapshot({
        kernelInstanceId: instanceA,
        observationRevision: 8,
        localEdgeEnabled: false,
        mode: 'network-only',
      }),
    ).toBe(true)
  })

  it('rejects progress whose identity differs from its snapshot', () => {
    expect(
      isOrderedLocalEdgeSnapshot({
        kernelInstanceId: instanceA,
        observationRevision: 8,
        localEdgeEnabled: true,
        mode: 'active',
        release: { releaseId: 'release-a' },
        revalidation: {
          kernelInstanceId: instanceB,
          observationRevision: 8,
          attemptId: 1,
          releaseId: 'release-b',
          completedAssets: 1,
          totalAssets: 2,
        },
      }),
    ).toBe(false)
  })
})

describe('reduceRevalidationObservation', () => {
  it('lets a newer same-release attempt restart from a lower count', () => {
    const first = apply({ phase: 'unknown' }, progress(7, 7))
    const retry = apply(
      first.cursor,
      progress(10, 1, { attemptId: 9 }),
    )

    expect(retry.accepted).toBe(true)
    expect(retry.cursor).toMatchObject({
      phase: 'running',
      observationRevision: 10,
      attempt: { attemptId: 9, releaseId: 'release-a' },
      progress: { completedAssets: 1 },
    })
  })

  it('rejects delayed lower-revision progress and snapshots after settle', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 7))
    const settled = apply(running.cursor, terminal(8))

    expect(apply(settled.cursor, progress(7, 8))).toMatchObject({
      accepted: false,
      rejection: 'superseded',
    })
    expect(
      apply(
        settled.cursor,
        snapshot(7, { running: true, completedAssets: 7 }),
      ),
    ).toMatchObject({ accepted: false, rejection: 'superseded' })
    expect(settled.cursor.phase).toBe('settled')
  })

  it('rejects a higher-revision count regression within one attempt', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 5))
    const regressed = apply(running.cursor, progress(8, 2))

    expect(regressed).toMatchObject({
      accepted: false,
      rejection: 'conflict',
    })
    expect(regressed.cursor).toEqual(running.cursor)
  })

  it('uses a newer idle snapshot to heal a missed terminal', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 7))
    const healed = apply(running.cursor, snapshot(8))

    expect(healed).toMatchObject({ accepted: true, applySnapshot: true })
    expect(healed.cursor).toMatchObject({
      phase: 'settled',
      observationRevision: 8,
    })
  })

  it('accepts an equal-revision idle snapshot as terminal enrichment', () => {
    const settled = apply({ phase: 'unknown' }, terminal(8))
    const enriched = apply(settled.cursor, snapshot(8))

    expect(enriched).toMatchObject({
      accepted: true,
      applySnapshot: true,
      rejection: undefined,
    })
  })

  it('accepts matching equal-revision running projections', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 4))
    const enriched = apply(
      running.cursor,
      snapshot(7, { running: true, completedAssets: 4 }),
    )

    expect(enriched).toMatchObject({
      accepted: true,
      applySnapshot: true,
      rejection: undefined,
    })
  })

  it('rejects equal-revision running and settled conflicts', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 4))
    const settled = apply({ phase: 'unknown' }, terminal(7))

    expect(apply(running.cursor, snapshot(7))).toMatchObject({
      accepted: false,
      rejection: 'conflict',
    })
    expect(
      apply(
        settled.cursor,
        snapshot(7, { running: true, completedAssets: 4 }),
      ),
    ).toMatchObject({ accepted: false, rejection: 'conflict' })
  })

  it('rejects immutable attempt identity conflicts', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 4))

    expect(
      apply(
        running.cursor,
        snapshot(7, {
          running: true,
          releaseId: 'release-b',
          completedAssets: 4,
        }),
      ),
    ).toMatchObject({ accepted: false, rejection: 'conflict' })
    expect(
      apply(
        running.cursor,
        progress(7, 4, { totalAssets: 13 }),
      ),
    ).toMatchObject({ accepted: false, rejection: 'conflict' })
  })

  it('does not let a message switch an established kernel instance', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 4))
    const mismatched = apply(
      running.cursor,
      progress(20, 1, { instance: instanceB }),
    )

    expect(mismatched).toMatchObject({
      accepted: false,
      rejection: 'foreign-instance',
    })
    expect(mismatched.cursor).toEqual(running.cursor)
  })

  it('lets an authoritative snapshot establish a replacement instance', () => {
    const running = apply({ phase: 'unknown' }, progress(7, 4))
    const replacement = apply(
      running.cursor,
      snapshot(1, {
        instance: instanceB,
        running: true,
        attemptId: 1,
        releaseId: 'release-b',
      }),
    )

    expect(replacement).toMatchObject({ accepted: true, applySnapshot: true })
    expect(replacement.cursor).toMatchObject({
      phase: 'running',
      kernelInstanceId: instanceB,
      observationRevision: 1,
    })
  })

  it('allows a terminal observation to enrich an idle cursor at the same revision', () => {
    const idle = apply({ phase: 'unknown' }, snapshot(8))
    const settled = apply(idle.cursor, terminal(8))

    expect(settled).toMatchObject({ accepted: true, rejection: undefined })
    expect(settled.cursor).toMatchObject({
      phase: 'settled',
      attempt: { attemptId: 1, releaseId: 'release-a' },
    })
  })
})
