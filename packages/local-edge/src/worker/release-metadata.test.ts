import { describe, expect, it } from 'vitest'
import type { LegacyAppRelease } from '../release.ts'
import { normalizeStoredReleaseState } from './release-metadata.ts'

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
