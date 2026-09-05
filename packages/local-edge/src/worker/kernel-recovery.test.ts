import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let isTrustedResetPost: typeof import('./kernel-recovery.ts').isTrustedResetPost
let kernelSnapshotFailureCode: typeof import('./local-edge-worker.ts').kernelSnapshotFailureCode
let MetadataAuthorityError: typeof import('./release-metadata.ts').MetadataAuthorityError

function resetRequest(
  headers: Record<string, string>,
  mode: RequestMode = 'navigate',
) {
  return {
    headers: new Headers(headers),
    mode,
  } as Request
}

describe('isTrustedResetPost', () => {
  beforeAll(async () => {
    vi.stubGlobal('self', globalThis)
    vi.stubGlobal('location', new URL('https://app.example/settings?__fwa=reset'))
    ;({ isTrustedResetPost } = await import('./kernel-recovery.ts'))
    ;({ kernelSnapshotFailureCode } = await import('./local-edge-worker.ts'))
    ;({ MetadataAuthorityError } = await import('./release-metadata.ts'))
  })

  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://app.example/settings?__fwa=reset'))
  })

  it('accepts a same-origin navigation with an Origin header', () => {
    expect(
      isTrustedResetPost(
        resetRequest({
          Origin: 'https://app.example',
          'Sec-Fetch-Site': 'same-origin',
        }),
      ),
    ).toBe(true)
  })

  it('accepts an iOS same-origin navigation when Origin is omitted', () => {
    expect(
      isTrustedResetPost(
        resetRequest({ 'Sec-Fetch-Site': 'same-origin' }),
      ),
    ).toBe(true)
  })

  it('uses a same-origin Referer only when stronger headers are absent', () => {
    expect(
      isTrustedResetPost(
        resetRequest({ Referer: 'https://app.example/settings?__fwa=reset' }),
      ),
    ).toBe(true)
  })

  it.each([
    {
      name: 'cross-site fetch metadata',
      headers: {
        Origin: 'https://app.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    },
    {
      name: 'foreign Origin',
      headers: {
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'same-origin',
      },
    },
    {
      name: 'opaque Origin',
      headers: {
        Origin: 'null',
        'Sec-Fetch-Site': 'same-origin',
      },
    },
    {
      name: 'foreign Referer fallback',
      headers: { Referer: 'https://attacker.example/form' },
    },
    {
      name: 'no browser provenance',
      headers: {},
    },
  ])('rejects $name', ({ headers }) => {
    expect(
      isTrustedResetPost(resetRequest(headers as Record<string, string>)),
    ).toBe(false)
  })

  it('does not relax programmatic reset controls', () => {
    expect(
      isTrustedResetPost(
        resetRequest(
          {
            Origin: 'https://app.example',
            'Sec-Fetch-Site': 'same-origin',
          },
          'cors',
        ),
      ),
    ).toBe(false)
    expect(
      isTrustedResetPost(
        resetRequest(
          {
            Origin: 'https://app.example',
            'Sec-Fetch-Site': 'same-origin',
            'X-FWA-Control': 'reset',
          },
          'cors',
        ),
      ),
    ).toBe(true)
  })

  it('publishes bounded snapshot failure codes', () => {
    expect(
      kernelSnapshotFailureCode(
        new MetadataAuthorityError(
          'metadata-epoch-missing',
          'sensitive implementation detail',
        ),
      ),
    ).toBe('metadata-epoch-missing')
    expect(kernelSnapshotFailureCode(new Error('private failure'))).toBe(
      'kernel-snapshot-failed',
    )
  })
})
