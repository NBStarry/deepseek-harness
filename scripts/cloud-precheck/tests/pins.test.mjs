/** Offline guard that the pinned definition hashes match the checked-in bytes. */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PINS } from '../verify-push.mjs'
import { sha256 } from '../receipt.mjs'

const root = join(import.meta.dirname, '..', '..', '..')

test('pinned workflow, receipt writer, and reconstruction script match the checked-in bytes', () => {
  assert.equal(sha256(readFileSync(join(root, PINS.workflowPath))), PINS.workflowFileSha256)
  assert.equal(sha256(readFileSync(join(root, PINS.receiptScriptPath))), PINS.receiptScriptSha256)
  assert.equal(sha256(readFileSync(join(root, PINS.reconstructScriptPath))), PINS.reconstructScriptSha256)
})
