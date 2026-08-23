import { describe, expect, it } from 'vitest'
import {
  deriveDebugInstallation,
  type DebugInstallationEvidence,
} from './debug-installation.ts'

const installedEvidence: DebugInstallationEvidence = {
  activeRelease: { assetCount: 3, releaseId: 'release-1' },
  caches: [
    {
      complete: true,
      entryCount: 3,
      expectedAssetCount: 3,
      missingAssetCount: 0,
      releaseId: 'release-1',
    },
  ],
  hasErrors: false,
  kernel: { localEdgeEnabled: true, mode: 'active' },
  revalidating: false,
  serviceWorker: { supported: true },
  localEdgePhase: 'ready',
}

describe('deriveDebugInstallation', () => {
  it('requires both an active release and its complete cache', () => {
    expect(deriveDebugInstallation(installedEvidence)).toEqual({
      detail: '3/3 assets · offline ready',
      label: 'Installed',
      state: 'installed',
    })
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        caches: [],
      }),
    ).toEqual({
      detail: 'Committed release cache is missing',
      label: 'Incomplete',
      state: 'incomplete',
    })
  })

  it('keeps an installed release visible while this page bypasses Local Edge', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        localEdgePhase: 'network-only',
      }),
    ).toMatchObject({
      detail: '3/3 assets · cached while this page bypasses Local Edge',
      state: 'installed',
    })
  })

  it('shows Updating when a pending worker waits to replace an incomplete active release', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        caches: [],
        serviceWorker: { supported: true, waiting: '/__fwa-sw.js' },
      }),
    ).toEqual({
      detail: 'A newer Local Edge worker is waiting to take over',
      label: 'Updating',
      state: 'updating',
    })
  })

  it('shows Updating when a worker is installing over an incomplete active release', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        caches: [],
        serviceWorker: { supported: true, installing: '/__fwa-sw.js' },
      }),
    ).toMatchObject({
      label: 'Updating',
      state: 'updating',
    })
  })

  it('keeps Incomplete for a missing active cache without a pending worker', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        caches: [],
      }),
    ).toEqual({
      detail: 'Committed release cache is missing',
      label: 'Incomplete',
      state: 'incomplete',
    })
  })

  it('shows background revalidation while the current release stays available', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        revalidating: true,
      }),
    ).toEqual({
      detail: '3/3 current assets remain offline ready',
      label: 'Updating',
      state: 'updating',
    })
  })

  it('treats an intentional network-only page without kernel evidence as normal', () => {
    expect(
      deriveDebugInstallation({
        caches: [],
        hasErrors: true,
        revalidating: false,
        serviceWorker: { supported: true },
        localEdgePhase: 'network-only',
      }),
    ).toEqual({
      detail: 'This page intentionally uses the network baseline',
      label: 'Bypassed',
      state: 'bypassed',
    })
  })

  it('reports the missing asset count for an incomplete cache', () => {
    expect(
      deriveDebugInstallation({
        ...installedEvidence,
        caches: [
          {
            complete: false,
            entryCount: 2,
            expectedAssetCount: 3,
            missingAssetCount: 1,
            releaseId: 'release-1',
          },
        ],
      }),
    ).toEqual({
      detail: '2/3 assets · 1 missing',
      label: 'Incomplete',
      state: 'incomplete',
    })
  })

  it('distinguishes installation progress, absence, and unavailable evidence', () => {
    const base: DebugInstallationEvidence = {
      caches: [],
      hasErrors: false,
      revalidating: false,
      serviceWorker: { supported: true },
      localEdgePhase: 'registering',
    }
    expect(deriveDebugInstallation(base).state).toBe('installing')
    expect(
      deriveDebugInstallation({
        ...base,
        kernel: { localEdgeEnabled: false, mode: 'disabled' },
        localEdgePhase: 'network-only',
      }).state,
    ).toBe('not-installed')
    expect(
      deriveDebugInstallation({
        ...base,
        hasErrors: true,
        localEdgePhase: 'error',
      }).state,
    ).toBe('unavailable')
    expect(
      deriveDebugInstallation({
        ...base,
        serviceWorker: { supported: false },
        localEdgePhase: 'unsupported',
      }).state,
    ).toBe('unsupported')
  })
})
