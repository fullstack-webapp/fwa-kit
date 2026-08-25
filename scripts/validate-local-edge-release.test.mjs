import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNextReleaseVersion,
  compareVersions,
} from './validate-local-edge-release.mjs'

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
