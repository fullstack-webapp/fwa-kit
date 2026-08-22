import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaTypeFor } from './media-type.mjs'

test('uses an explicit binary media type for model weights', () => {
  assert.equal(
    mediaTypeFor('models/basic-pitch/group1-shard1of1.bin'),
    'application/octet-stream',
  )
})

test('keeps unknown supplemental asset types fail-closed', () => {
  assert.throws(
    () => mediaTypeFor('assets/model.unknown'),
    /No media type mapping for assets\/model\.unknown/,
  )
})
