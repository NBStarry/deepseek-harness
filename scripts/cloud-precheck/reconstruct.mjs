/**
 * Rebuild the exact candidate commit from a baseline checkout and verify its identity.
 *
 * The cloud precheck copies this file from the dispatched revision, then runs it. The
 * offline payload test runs the same file against a local clone, so a synthetic-commit
 * regression fails before any dispatch. Only node builtins and git; no install or build.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { sha256 } from './receipt.mjs'

function git(cwd, args, stdin) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input: stdin, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function decode(value, label) {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0) throw new Error(`${label} must not be empty`)
  const inflated = execFileSync('gzip', ['-d', '-c'], { input: bytes, maxBuffer: 512 * 1024 * 1024 })
  return inflated
}

function reconstruct({ source, work, base, candidateCommit, candidateTree, patch, patchSha256, commitObject, commitObjectSha256 }) {
  for (const [label, value, pattern] of [
    ['base', base, /^[a-f0-9]{40}$/u],
    ['candidate commit', candidateCommit, /^[a-f0-9]{40}$/u],
    ['candidate tree', candidateTree, /^[a-f0-9]{40}$/u],
    ['patch sha256', patchSha256, /^[a-f0-9]{64}$/u],
    ['commit object sha256', commitObjectSha256, /^[a-f0-9]{64}$/u],
  ]) {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is malformed`)
  }
  const patchBytes = decode(patch, 'patch')
  if (sha256(patchBytes) !== patchSha256) throw new Error('patch bytes do not match patch_sha256')
  const objectBytes = decode(commitObject, 'commit object')
  if (sha256(objectBytes) !== commitObjectSha256) throw new Error('commit object bytes do not match commit_object_sha256')
  git(process.cwd(), ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, work])
  git(work, ['checkout', '--quiet', '--detach', base])
  if (git(work, ['rev-parse', 'HEAD']) !== base) throw new Error('clone does not start at the baseline')
  if (git(work, ['status', '--porcelain']) !== '') throw new Error('baseline checkout is dirty')
  const patchFile = join(work, '.git', 'candidate.patch')
  const objectFile = join(work, '.git', 'candidate.commit')
  try {
    writeFileSync(patchFile, patchBytes)
    writeFileSync(objectFile, objectBytes)
    if (patchBytes.length > 0) git(work, ['apply', '--index', patchFile])
    if (git(work, ['write-tree']) !== candidateTree) throw new Error('applied patch does not reproduce candidate_tree')
    const written = git(work, ['hash-object', '-t', 'commit', '-w', '--stdin'], objectBytes)
    if (written !== candidateCommit) throw new Error(`commit object hashes to ${written}, not the candidate commit`)
    git(work, ['reset', '--quiet', '--hard', candidateCommit])
  } finally {
    rmSync(patchFile, { force: true })
    rmSync(objectFile, { force: true })
  }
  if (git(work, ['rev-parse', 'HEAD']) !== candidateCommit) throw new Error('HEAD is not the candidate commit')
  if (git(work, ['rev-parse', 'HEAD^{tree}']) !== candidateTree) throw new Error('HEAD tree is not the candidate tree')
  if (git(work, ['status', '--porcelain']) !== '') throw new Error('reconstruction left the worktree dirty')
  const actual = git(work, ['cat-file', 'commit', candidateCommit]).split('\n').join('\n')
  const expected = objectBytes.toString('utf8').replace(/\n+$/u, '')
  if (actual.replace(/\n+$/u, '') !== expected) throw new Error('reconstructed commit bytes differ from the supplied object')
  return { head: candidateCommit, tree: candidateTree }
}

function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      work: { type: 'string' },
      base: { type: 'string' },
      'candidate-commit': { type: 'string' },
      'candidate-tree': { type: 'string' },
      patch: { type: 'string' },
      'patch-sha256': { type: 'string' },
      'commit-object': { type: 'string' },
      'commit-object-sha256': { type: 'string' },
    },
    allowPositionals: false,
  })
  for (const name of ['source', 'work', 'base', 'candidate-commit', 'candidate-tree', 'patch', 'patch-sha256', 'commit-object', 'commit-object-sha256']) {
    if (values[name] === undefined) throw new Error(`reconstruct: --${name} is required`)
  }
  const result = reconstruct({
    source: values.source,
    work: values.work,
    base: values.base,
    candidateCommit: values['candidate-commit'],
    candidateTree: values['candidate-tree'],
    patch: values.patch,
    patchSha256: values['patch-sha256'],
    commitObject: values['commit-object'],
    commitObjectSha256: values['commit-object-sha256'],
  })
  process.stdout.write(`CANDIDATE_HEAD ${result.head}\nCANDIDATE_TREE ${result.tree}\n`)
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

if (invokedDirectly()) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`cloud precheck reconstruct: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
