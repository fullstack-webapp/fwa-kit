import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyAppRelease } from '../release.ts'
import {
  allocateReleaseObservation,
  applyLocalEdgeModeIfLatest,
  claimCandidateJournalIfLatest,
  deleteReleaseMetadata,
  normalizeStoredReleaseState,
  readClientReleasePins,
  readLocalEdgeEnabled,
  readOrCreateMetadataEpoch,
  readReleaseState,
  updateClientReleasePin,
  writeLocalEdgeEnabled,
  writeReleaseStateForCandidate,
} from './release-metadata.ts'

const releases = ['a', 'b', 'c', 'd'].map(
  (releaseId): LegacyAppRelease => ({
    schemaVersion: 1,
    appId: 'test-app',
    releaseId,
    appEntry: '/index.html',
    coreAssets: ['/index.html'],
  }),
)

describe('normalizeStoredReleaseState', () => {
  it('migrates the legacy previous release into the retained list', () => {
    expect(
      normalizeStoredReleaseState(releases[0], undefined, releases[1]),
    ).toEqual({
      active: releases[0],
      retained: [releases[1]],
    })
  })

  it('deduplicates retained releases and excludes the active release', () => {
    expect(
      normalizeStoredReleaseState(
        releases[0],
        [releases[1], releases[2], releases[1], releases[0]],
        releases[3],
      ),
    ).toEqual({
      active: releases[0],
      retained: [releases[1], releases[2], releases[3]],
    })
  })

  it('ignores malformed metadata values', () => {
    expect(
      normalizeStoredReleaseState(
        { releaseId: 'invalid' },
        [null, { schemaVersion: 3 }],
        'invalid',
      ),
    ).toEqual({ active: undefined, retained: [] })
  })
})

describe('release metadata authority', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('crypto', {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
        .mockReturnValueOnce('00000000-0000-4000-8000-000000000002'),
    })
  })

  it('only lets the bootstrap path create a metadata epoch', async () => {
    await expect(readReleaseState('missing-epoch')).rejects.toThrow()

    const metadataEpoch = await readOrCreateMetadataEpoch(true)

    expect(metadataEpoch).toBe('00000000-0000-4000-8000-000000000001')
    await expect(readReleaseState(metadataEpoch)).resolves.toEqual({
      active: undefined,
      retained: [],
    })
  })

  it('permanently rejects an old epoch after reset and bootstrap', async () => {
    const oldEpoch = await readOrCreateMetadataEpoch(true)
    await writeLocalEdgeEnabled(oldEpoch, true)
    await deleteReleaseMetadata()
    const newEpoch = await readOrCreateMetadataEpoch(true)

    expect(newEpoch).not.toBe(oldEpoch)
    await expect(writeLocalEdgeEnabled(oldEpoch, false)).rejects.toThrow(
      'lost metadata authority',
    )
    await expect(readLocalEdgeEnabled(newEpoch)).resolves.toBe(true)
  })

  it('orders descriptor transitions independently of lock acquisition order', async () => {
    const metadataEpoch = await readOrCreateMetadataEpoch(true)
    const older = await allocateReleaseObservation(metadataEpoch)
    const newer = await allocateReleaseObservation(metadataEpoch)

    await expect(
      applyLocalEdgeModeIfLatest(older, true),
    ).resolves.toMatchObject({ applied: false })

    await expect(
      claimCandidateJournalIfLatest(
        {
          metadataEpoch,
          kernelInstanceId: '00000000-0000-4000-8000-000000000020',
          attemptId: 3,
          releaseId: releases[2].releaseId,
          releaseObservationSeq: older.observationSeq,
          phase: 'installing',
        },
        older,
      ),
    ).resolves.toMatchObject({ claimed: false })

    await expect(
      applyLocalEdgeModeIfLatest(newer, false),
    ).resolves.toMatchObject({ applied: true })
    await expect(readLocalEdgeEnabled(metadataEpoch)).resolves.toBe(false)
  })

  it('rejects a candidate commit after a newer descriptor request is issued', async () => {
    const metadataEpoch = await readOrCreateMetadataEpoch(true)
    const observation = await allocateReleaseObservation(metadataEpoch)
    const owner = {
      metadataEpoch,
      kernelInstanceId: '00000000-0000-4000-8000-000000000021',
      attemptId: 4,
      releaseId: releases[1].releaseId,
      releaseObservationSeq: observation.observationSeq,
    }
    await expect(
      claimCandidateJournalIfLatest(
        { ...owner, phase: 'installing' },
        observation,
      ),
    ).resolves.toMatchObject({ claimed: true })

    await allocateReleaseObservation(metadataEpoch)

    await expect(
      writeReleaseStateForCandidate(owner, {
        active: releases[1],
        retained: [],
      }),
    ).rejects.toThrow('candidate install lost metadata authority')
    await expect(readReleaseState(metadataEpoch)).resolves.toEqual({
      active: undefined,
      retained: [],
    })
  })

  it('rejects a superseded candidate owner in the commit transaction', async () => {
    const metadataEpoch = await readOrCreateMetadataEpoch(true)
    const firstObservation = await allocateReleaseObservation(metadataEpoch)
    const firstOwner = {
      metadataEpoch,
      kernelInstanceId: '00000000-0000-4000-8000-000000000010',
      attemptId: 1,
      releaseId: releases[0].releaseId,
      releaseObservationSeq: firstObservation.observationSeq,
    }
    await claimCandidateJournalIfLatest(
      { ...firstOwner, phase: 'installing' },
      firstObservation,
    )
    const secondObservation = await allocateReleaseObservation(metadataEpoch)
    const secondOwner = {
      metadataEpoch,
      kernelInstanceId: '00000000-0000-4000-8000-000000000011',
      attemptId: 2,
      releaseId: releases[1].releaseId,
      releaseObservationSeq: secondObservation.observationSeq,
    }
    await claimCandidateJournalIfLatest(
      { ...secondOwner, phase: 'installing' },
      secondObservation,
    )

    await expect(
      writeReleaseStateForCandidate(firstOwner, {
        active: releases[0],
        retained: [],
      }),
    ).rejects.toThrow('candidate install lost metadata authority')
    await writeReleaseStateForCandidate(secondOwner, {
      active: releases[1],
      retained: [],
    })

    await expect(readReleaseState(metadataEpoch)).resolves.toEqual({
      active: releases[1],
      retained: [],
    })
  })

  it('merges concurrent client pin updates without dropping either client', async () => {
    const metadataEpoch = await readOrCreateMetadataEpoch(true)

    await Promise.all([
      updateClientReleasePin(metadataEpoch, 'client-a', 'release-a'),
      updateClientReleasePin(metadataEpoch, 'client-b', 'release-b'),
    ])

    await expect(readClientReleasePins(metadataEpoch)).resolves.toEqual(
      new Map([
        ['client-a', 'release-a'],
        ['client-b', 'release-b'],
      ]),
    )
  })
})
