import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNextReleaseVersion,
  compareVersions,
  releaseBranch,
  releaseTag,
  resolveReleasePackage,
  verifyReleaseTag,
} from './validate-release.mjs'

const localEdgeMetadata = { version: '0.1.0-beta.3' }
const documentShellMetadata = { version: '0.1.0-beta.1' }

test('resolves only the allowlisted release packages', () => {
  assert.deepEqual(resolveReleasePackage('local-edge'), {
    packageName: '@fullstack-webapp/local-edge',
    directory: 'packages/local-edge',
  })
  assert.deepEqual(resolveReleasePackage('document-shell'), {
    packageName: '@fullstack-webapp/document-shell',
    directory: 'packages/document-shell',
  })
  assert.throws(
    () => resolveReleasePackage('diagnostics'),
    /Unknown release package "diagnostics". Expected one of: local-edge, document-shell\./,
  )
  assert.throws(
    () => resolveReleasePackage('$(rm -rf /tmp/x)'),
    /Unknown release package "\$\(rm -rf \/tmp\/x\)". Expected one of: local-edge, document-shell\./,
  )
})

test('derives deterministic tag and branch names per package', () => {
  assert.equal(releaseTag('local-edge', '0.1.0-beta.4'), 'local-edge@0.1.0-beta.4')
  assert.equal(releaseTag('document-shell', '0.2.0'), 'document-shell@0.2.0')
  assert.equal(releaseBranch('local-edge', '0.1.0-beta.4'), 'release/local-edge-0.1.0-beta.4')
  assert.equal(releaseBranch('document-shell', '0.2.0'), 'release/document-shell-0.2.0')
  assert.throws(() => releaseBranch('unknown', '0.2.0'), /Unknown release package/)
})

test('verifies the package-specific release tag for the exact version', () => {
  assert.equal(
    verifyReleaseTag('local-edge@0.1.0-beta.3', 'local-edge', localEdgeMetadata),
    'local-edge@0.1.0-beta.3',
  )
  assert.equal(
    verifyReleaseTag('document-shell@0.1.0-beta.1', 'document-shell', documentShellMetadata),
    'document-shell@0.1.0-beta.1',
  )
})

test('rejects tag/version and tag/package mismatches', () => {
  assert.throws(
    () => verifyReleaseTag('local-edge@0.1.0-beta.3', 'local-edge'),
    /Missing package metadata for @fullstack-webapp\/local-edge/,
  )
  assert.throws(
    () => verifyReleaseTag('local-edge@0.1.0-beta.4', 'local-edge', localEdgeMetadata),
    /does not match local-edge@0\.1\.0-beta\.3 for @fullstack-webapp\/local-edge/,
  )
  assert.throws(
    () => verifyReleaseTag('document-shell@0.1.0-beta.1', 'local-edge', localEdgeMetadata),
    /does not match local-edge@0\.1\.0-beta\.3 for @fullstack-webapp\/local-edge/,
  )
  assert.throws(
    () => verifyReleaseTag('local-edge@0.1.0-beta.3', 'document-shell', documentShellMetadata),
    /does not match document-shell@0\.1\.0-beta\.1 for @fullstack-webapp\/document-shell/,
  )
})

test('orders prerelease and stable versions by SemVer precedence', () => {
  assert.equal(compareVersions('0.1.0-beta.3', '0.1.0-beta.2'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.3'), 1)
  assert.equal(compareVersions('0.1.1-alpha.0', '0.1.0'), 1)
})

test('accepts a greater release claim', () => {
  assert.doesNotThrow(() => {
    assertNextReleaseVersion({
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.3',
    })
  })
})

test('rejects equal, lower, and invalid release claims', () => {
  assert.throws(() => {
    assertNextReleaseVersion({
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.2',
    })
  }, /must be greater/)

  assert.throws(() => {
    assertNextReleaseVersion({
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.1',
    })
  }, /must be greater/)

  assert.throws(() => {
    assertNextReleaseVersion({
      currentVersion: '0.1.0-beta.2',
      targetVersion: '0.1.0-beta.03',
    })
  }, /SemVer/)
})
