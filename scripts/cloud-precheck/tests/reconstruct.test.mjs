/** Offline coverage for the shared reconstruction script the workflow and payload test run. */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { sha256 } from '../receipt.mjs'

const script = join(import.meta.dirname, '..', 'reconstruct.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reconstruct-'))
  const repo = join(root, 'source')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'author@example.invalid')
  git(repo, 'config', 'user.name', 'Author')
  writeFileSync(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'file.txt'), 'candidate\n')
  git(repo, 'commit', '-q', '-am', 'candidate message')
  const candidate = git(repo, 'rev-parse', 'HEAD')
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}')
  const patch = execFileSync('git', ['-C', repo, 'diff', '--binary', base, candidate])
  const commitObject = execFileSync('git', ['-C', repo, 'cat-file', 'commit', candidate])
  return {
    root, repo, base, candidate, tree,
    inputs: {
      patch: gzipSync(patch).toString('base64'),
      patchSha256: sha256(patch),
      commitObject: gzipSync(commitObject).toString('base64'),
      commitObjectSha256: sha256(commitObject),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function run(f, overrides = {}) {
  const work = join(f.root, `work-${String(Math.random()).slice(2)}`)
  const values = {
    '--source': f.repo,
    '--work': work,
    '--base': f.base,
    '--candidate-commit': f.candidate,
    '--candidate-tree': f.tree,
    '--patch': f.inputs.patch,
    '--patch-sha256': f.inputs.patchSha256,
    '--commit-object': f.inputs.commitObject,
    '--commit-object-sha256': f.inputs.commitObjectSha256,
    ...overrides,
  }
  const args = Object.entries(values).flatMap(([flag, value]) => [flag, String(value)])
  return { work, output: execFileSync('node', [script, ...args], { encoding: 'utf8' }) }
}

test('rebuilds the exact candidate commit instead of a synthetic one', () => {
  const f = fixture()
  try {
    const { work, output } = run(f)
    assert.match(output, new RegExp(`CANDIDATE_HEAD ${f.candidate}`, 'u'))
    assert.match(output, new RegExp(`CANDIDATE_TREE ${f.tree}`, 'u'))
    assert.equal(git(work, 'rev-parse', 'HEAD'), f.candidate)
    assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), f.tree)
    assert.equal(git(work, 'status', '--porcelain'), '')
    assert.equal(git(work, 'log', '-1', '--format=%B').trim(), 'candidate message')
  } finally { f.cleanup() }
})

test('rejects a patch that does not reproduce the candidate tree', () => {
  const f = fixture()
  try {
    assert.throws(() => run(f, { '--candidate-tree': f.base }), /reproduce candidate_tree/u)
  } finally { f.cleanup() }
})

test('rejects commit object bytes that do not match their hash', () => {
  const f = fixture()
  try {
    assert.throws(() => run(f, { '--commit-object-sha256': 'a'.repeat(64) }), /commit object bytes do not match/u)
    assert.throws(() => run(f, { '--patch-sha256': 'b'.repeat(64) }), /patch bytes do not match/u)
  } finally { f.cleanup() }
})

test('rejects a candidate commit id the object does not hash to', () => {
  const f = fixture()
  try {
    assert.throws(() => run(f, { '--candidate-commit': f.base }), /commit object hashes to/u)
  } finally { f.cleanup() }
})

test('rebuilds a candidate whose tree equals the base tree', () => {
  const f = fixture()
  try {
    const base = f.base
    git(f.repo, 'checkout', '-q', '--detach', base)
    git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'metadata only')
    const candidate = git(f.repo, 'rev-parse', 'HEAD')
    const tree = git(f.repo, 'rev-parse', 'HEAD^{tree}')
    const patch = execFileSync('git', ['-C', f.repo, 'diff', '--binary', base, candidate])
    assert.equal(patch.length, 0)
    const commitObject = execFileSync('git', ['-C', f.repo, 'cat-file', 'commit', candidate])
    const { work } = run(f, {
      '--candidate-commit': candidate,
      '--candidate-tree': tree,
      '--patch': gzipSync(patch).toString('base64'),
      '--patch-sha256': sha256(patch),
      '--commit-object': gzipSync(commitObject).toString('base64'),
      '--commit-object-sha256': sha256(commitObject),
    })
    assert.equal(git(work, 'rev-parse', 'HEAD'), candidate)
    assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), tree)
  } finally { f.cleanup() }
})
