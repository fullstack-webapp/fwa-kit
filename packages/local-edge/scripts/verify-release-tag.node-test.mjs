import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyReleaseTag } from './verify-release-tag.mjs'

const metadata = { version: '0.1.0-beta.1' }

test('accepts the package-specific tag for the exact version', () => {
  assert.equal(
    verifyReleaseTag('local-edge@0.1.0-beta.1', metadata),
    'local-edge@0.1.0-beta.1',
  )
})

test('rejects a different package version', () => {
  assert.throws(
    () => verifyReleaseTag('local-edge@0.1.0-beta.2', metadata),
    /does not match local-edge@0\.1\.0-beta\.1/,
  )
})

test('rejects a tag for another package', () => {
  assert.throws(
    () => verifyReleaseTag('diagnostics@0.1.0-beta.1', metadata),
    /does not match local-edge@0\.1\.0-beta\.1/,
  )
})
