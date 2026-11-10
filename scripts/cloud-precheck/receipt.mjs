/**
 * Canonical precheck receipt: the document the trusted cloud workflow emits and the
 * pre-push gate validates.
 *
 * This module is also the trust anchor: the gate pins the SHA-256 of these bytes at
 * the dispatched revision, so a receipt and the code that produced it must match the
 * approved workflow revision. Keep it dependency-free: the gate runs before install.
 */
import { createHash } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

/** Receipt format identifier; a new shape requires a new identifier. */
export const RECEIPT_SCHEMA = 'dsh-cloud-precheck-receipt/v1'

/** Exact receipt fields; unknown or missing fields reject the receipt. */
export const RECEIPT_FIELDS = [
  'schema',
  'repository',
  'workflowPath',
  'workflowFileSha256',
  'receiptScriptPath',
  'receiptScriptSha256',
  'reconstructScriptPath',
  'reconstructScriptSha256',
  'dispatchRef',
  'dispatchSha',
  'runId',
  'runAttempt',
  'candidateCommit',
  'candidateTree',
  'base',
  'patchSha256',
  'commands',
  'conclusion',
  'startedAt',
  'finishedAt',
  'runner',
]

const sha256Pattern = /^[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40}$/u
const runIdPattern = /^[1-9][0-9]*$/u

/**
 * Hash bytes the same way `sha256sum` does.
 * @param {Buffer | string} value - Bytes to hash.
 * @returns {string} Lowercase hexadecimal SHA-256.
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Serialize a receipt with a stable key order for byte comparison.
 * @param {Record<string, unknown>} receipt - Complete receipt document.
 * @returns {string} JSON text with a trailing newline.
 * @throws If the receipt is not a valid receipt document.
 */
export function serializeReceipt(receipt) {
  validateReceiptShape(receipt)
  const ordered = {}
  for (const field of RECEIPT_FIELDS) ordered[field] = receipt[field]
  return `${JSON.stringify(ordered, null, 2)}\n`
}

/**
 * Validate the receipt structure and the fields that do not depend on the run.
 * @param {unknown} value - Parsed receipt document.
 * @returns {Record<string, unknown>} The validated receipt.
 * @throws If a field is missing, unknown, or malformed.
 */
export function validateReceiptShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt must be an object')
  const receipt = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(receipt).sort()
  const expected = [...RECEIPT_FIELDS].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`receipt keys must be exactly ${RECEIPT_FIELDS.join(', ')}`)
  }
  if (receipt.schema !== RECEIPT_SCHEMA) throw new Error(`receipt schema must be ${RECEIPT_SCHEMA}`)
  for (const field of ['workflowFileSha256', 'receiptScriptSha256', 'reconstructScriptSha256', 'patchSha256']) {
    if (typeof receipt[field] !== 'string' || !sha256Pattern.test(receipt[field])) throw new Error(`receipt ${field} must be a SHA-256`)
  }
  for (const field of ['dispatchSha', 'candidateCommit', 'candidateTree', 'base']) {
    if (typeof receipt[field] !== 'string' || !commitPattern.test(receipt[field])) throw new Error(`receipt ${field} must be a commit id`)
  }
  if (typeof receipt.runId !== 'string' || !runIdPattern.test(receipt.runId)) throw new Error('receipt runId must be a run number')
  if (typeof receipt.runAttempt !== 'number' || !Number.isInteger(receipt.runAttempt) || receipt.runAttempt < 1) {
    throw new Error('receipt runAttempt must be a positive integer')
  }
  if (receipt.conclusion !== 'success') throw new Error('receipt conclusion must be success')
  for (const field of ['repository', 'workflowPath', 'receiptScriptPath', 'reconstructScriptPath', 'dispatchRef', 'startedAt', 'finishedAt', 'runner']) {
    if (typeof receipt[field] !== 'string' || receipt[field].length === 0) throw new Error(`receipt ${field} must be a non-empty string`)
  }
  if (!Array.isArray(receipt.commands) || receipt.commands.length === 0
    || receipt.commands.some(command => typeof command !== 'string' || command.length === 0)) {
    throw new Error('receipt commands must be a non-empty list of commands')
  }
  return receipt
}

/**
 * Build the receipt the trusted workflow uploads for one verified candidate.
 * @param {Record<string, unknown>} fields - Receipt field values.
 * @returns {string} Serializable receipt text.
 */
export function buildReceipt(fields) {
  validateReceiptShape(fields)
  return serializeReceipt(fields)
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      base: { type: 'string' },
      'candidate-commit': { type: 'string' },
      'candidate-tree': { type: 'string' },
      'patch-sha256': { type: 'string' },
      'workflow-file-sha256': { type: 'string' },
      'receipt-script-sha256': { type: 'string' },
      'reconstruct-script-sha256': { type: 'string' },
      'started-at': { type: 'string' },
      'finished-at': { type: 'string' },
    },
    allowPositionals: false,
  })
  const required = ['out', 'base', 'candidate-commit', 'candidate-tree', 'patch-sha256',
    'workflow-file-sha256', 'receipt-script-sha256', 'reconstruct-script-sha256', 'started-at', 'finished-at']
  for (const name of required) {
    if (values[name] === undefined) throw new Error(`receipt: --${name} is required`)
  }
  const env = process.env
  const receipt = {
    schema: RECEIPT_SCHEMA,
    repository: env.GITHUB_REPOSITORY,
    workflowPath: '.github/workflows/cloud-precheck.yml',
    workflowFileSha256: values['workflow-file-sha256'],
    receiptScriptPath: 'scripts/cloud-precheck/receipt.mjs',
    receiptScriptSha256: values['receipt-script-sha256'],
    reconstructScriptPath: 'scripts/cloud-precheck/reconstruct.mjs',
    reconstructScriptSha256: values['reconstruct-script-sha256'],
    dispatchRef: env.GITHUB_REF,
    dispatchSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    candidateCommit: values['candidate-commit'],
    candidateTree: values['candidate-tree'],
    base: values.base,
    patchSha256: values['patch-sha256'],
    commands: ['pnpm install --frozen-lockfile', 'pnpm run typecheck'],
    conclusion: 'success',
    startedAt: values['started-at'],
    finishedAt: values['finished-at'],
    runner: 'macos-15',
  }
  const text = buildReceipt(receipt)
  writeFileSync(values.out, text)
  process.stdout.write(text)
}

/**
 * Report whether this module is the process entry point.
 * @returns {boolean} True when node ran this file directly.
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedDirectly()) main()
