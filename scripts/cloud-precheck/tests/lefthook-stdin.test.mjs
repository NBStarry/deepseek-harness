/** Wiring test: real lefthook forwards git's ref updates to the gate. */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PINS } from '../verify-push.mjs'
import { RECEIPT_SCHEMA, serializeReceipt } from '../receipt.mjs'

const lefthook = process.env.DSH_LEFTHOOK_BIN
const skip = lefthook === undefined ? 'set DSH_LEFTHOOK_BIN to a real lefthook binary to run this wiring test' : false
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'cloud-precheck.yml')
const receiptPath = join(repoRoot, 'scripts', 'cloud-precheck', 'receipt.mjs')
const reconstructPath = join(repoRoot, 'scripts', 'cloud-precheck', 'reconstruct.mjs')
const verifier = join(repoRoot, 'scripts', 'cloud-precheck', 'verify-push.mjs')
const dispatchSha = 'd'.repeat(40)
const runId = 77
const approvedUrl = 'git@github.com:NBStarry/deepseek-harness.git'

const stubSource = `import { readFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.env.DSH_GATE_STATE, 'utf8'))
const line = process.argv.slice(2).join(' ')
if (line.includes('/actions/artifacts/') && line.endsWith('/zip')) {
  process.stdout.write(readFileSync(state.zip))
} else {
  const contents = /\\/contents\\/(.+?)\\?ref=/u.exec(line)
  if (contents !== null) process.stdout.write(readFileSync(state.files[contents[1]]))
  else if (line.includes('/attempts/') && line.includes('/jobs')) process.stdout.write(JSON.stringify(state.pages))
  else if (line.includes('/artifacts?per_page')) process.stdout.write(JSON.stringify(state.artifacts))
  else if (/\\/actions\\/runs\\/[0-9]+$/u.test(line)) process.stdout.write(JSON.stringify(state.run))
  else { process.stderr.write('unexpected gh call: ' + line + '\\n'); process.exit(9) }
}
`

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function receiptFor(tip, tree) {
  return {
    schema: RECEIPT_SCHEMA,
    repository: PINS.repository,
    workflowPath: PINS.workflowPath,
    workflowFileSha256: PINS.workflowFileSha256,
    receiptScriptPath: PINS.receiptScriptPath,
    receiptScriptSha256: PINS.receiptScriptSha256,
    reconstructScriptPath: PINS.reconstructScriptPath,
    reconstructScriptSha256: PINS.reconstructScriptSha256,
    dispatchRef: 'refs/heads/master',
    dispatchSha,
    runId: String(runId),
    runAttempt: 1,
    candidateCommit: tip,
    candidateTree: tree,
    base: 'b'.repeat(40),
    patchSha256: 'c'.repeat(64),
    commands: ['pnpm install --frozen-lockfile', 'pnpm run typecheck'],
    conclusion: 'success',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:10:00Z',
    runner: 'macos-15',
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-lefthook-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  const hooks = join(root, 'hooks')
  const bin = join(root, 'bin')
  mkdirSync(hooks)
  mkdirSync(bin)
  execFileSync('git', ['init', '-q', '--bare', remote])
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'core.hooksPath', hooks)
  writeFileSync(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', approvedUrl)
  // Keep the configured (approved) URL while routing the transport to a local bare repo,
  // so the gate reads a real approved push target and the test never reaches the network.
  git(repo, 'config', `url.${remote}.insteadOf`, approvedUrl)
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh
exec "${lefthook}" run pre-push "$@"
`)
  chmodSync(join(hooks, 'pre-push'), 0o755)
  writeFileSync(join(repo, 'lefthook.yml'), `pre-push:
  jobs:
    - name: cloud precheck receipt
      use_stdin: true
      run: node "${verifier}" '{1}' '{2}'
`)
  writeFileSync(join(bin, 'stub.mjs'), stubSource)
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
exec "${process.execPath}" "${join(bin, 'stub.mjs')}" "$@"
`)
  chmodSync(join(bin, 'gh'), 0o755)
  return { root, repo, remote, bin }
}

function stateFor({ root, tip, tree, conclusion = 'success' }) {
  writeFileSync(join(root, 'receipt.json'), serializeReceipt(receiptFor(tip, tree)))
  execFileSync('zip', ['-q', '-j', join(root, 'receipt.zip'), 'receipt.json'], { cwd: root })
  const pages = [{
    total_count: 1,
    jobs: [{
      name: PINS.requiredJob,
      conclusion: 'success',
      run_attempt: 1,
      steps: PINS.requiredSteps.map(name => ({ name, conclusion: 'success' })),
    }],
  }]
  return {
    run: {
      id: runId, path: PINS.workflowPath, event: 'workflow_dispatch', status: 'completed',
      conclusion, head_sha: dispatchSha, head_branch: 'master', run_attempt: 1,
    },
    pages,
    artifacts: { total_count: 1, artifacts: [{ id: 9, name: `cloud-precheck-${tip}-${runId}-1`, expired: false }] },
    files: {
      [PINS.workflowPath]: workflowPath,
      [PINS.receiptScriptPath]: receiptPath,
      [PINS.reconstructScriptPath]: reconstructPath,
    },
    zip: join(root, 'receipt.zip'),
  }
}

function gateEnv({ bin, statePath }) {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DSH_GATE_STATE: statePath,
    GH_CONFIG_DIR: '/nonexistent-config-dir',
    DSH_CLOUD_PRECHECK_RUN: String(runId),
  }
}

function pushToUrl({ repo, bin, statePath, url }) {
  return execFileSync('git', ['push', url, 'candidate:refs/heads/feature'], {
    cwd: repo,
    encoding: 'utf8',
    env: gateEnv({ bin, statePath }),
  })
}

function runHook({ repo, bin, statePath, name, url }) {
  return execFileSync('git', ['rev-parse', '--verify', 'refs/heads/candidate'], {
    cwd: repo, encoding: 'utf8',
  }) && execFileSync(lefthook, ['run', 'pre-push', name, url], {
    cwd: repo,
    encoding: 'utf8',
    input: `refs/heads/candidate ${git(repo, 'rev-parse', 'refs/heads/candidate')} refs/heads/feature ${'0'.repeat(40)}\n`,
    env: gateEnv({ bin, statePath }),
  })
}

function prepareCandidate(repo) {
  const base = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'candidate')
  const tip = git(repo, 'rev-parse', 'HEAD')
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}')
  git(repo, 'branch', 'candidate')
  // Detaching proves the gate reads git's stdin rather than HEAD: HEAD is the baseline,
  // while the pushed ref names the candidate.
  git(repo, 'checkout', '-q', '--detach', base)
  return { tip, tree }
}

test('real lefthook forwards ref updates so the gate admits a verified push', { skip }, () => {
  const f = fixture()
  try {
    const { tip } = prepareCandidate(f.repo)
    const statePath = join(f.root, 'state.json')
    writeFileSync(statePath, JSON.stringify(stateFor({ root: f.root, tip, tree: git(f.repo, 'rev-parse', 'candidate^{tree}') })))
    runHook({ repo: f.repo, bin: f.bin, statePath, name: 'origin', url: approvedUrl })
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/candidate'), tip)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('real lefthook admits an approved explicit URL target under another remote name', { skip }, () => {
  const f = fixture()
  try {
    const { tip } = prepareCandidate(f.repo)
    const statePath = join(f.root, 'state.json')
    writeFileSync(statePath, JSON.stringify(stateFor({ root: f.root, tip, tree: git(f.repo, 'rev-parse', 'candidate^{tree}') })))
    runHook({ repo: f.repo, bin: f.bin, statePath, name: 'mirror', url: approvedUrl })
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/candidate'), tip)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('real lefthook rejects the push when the run did not succeed', { skip }, () => {
  const f = fixture()
  try {
    const { tip } = prepareCandidate(f.repo)
    const statePath = join(f.root, 'state.json')
    const tree = git(f.repo, 'rev-parse', 'candidate^{tree}')
    writeFileSync(statePath, JSON.stringify(stateFor({ root: f.root, tip, tree, conclusion: 'cancelled' })))
    assert.throws(() => runHook({ repo: f.repo, bin: f.bin, statePath, name: 'origin', url: approvedUrl }))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('real git push to a local URL is rejected by the gate', { skip }, () => {
  const f = fixture()
  try {
    const { tip } = prepareCandidate(f.repo)
    const statePath = join(f.root, 'state.json')
    writeFileSync(statePath, JSON.stringify(stateFor({ root: f.root, tip, tree: git(f.repo, 'rev-parse', 'candidate^{tree}') })))
    assert.throws(() => pushToUrl({ repo: f.repo, bin: f.bin, statePath, url: f.remote }))
    assert.throws(() => git(f.remote, 'rev-parse', '--verify', 'refs/heads/feature'))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
