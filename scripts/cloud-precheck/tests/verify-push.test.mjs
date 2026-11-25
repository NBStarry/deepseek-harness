/** Offline coverage for the pre-push cloud precheck gate; no network, install, or build. */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PINS, parsePushUpdates, repositorySlug, verifyPinnedDefinition, verifyPush } from '../verify-push.mjs'
import { RECEIPT_SCHEMA, serializeReceipt, sha256 } from '../receipt.mjs'

const zero = '0'.repeat(40)
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const files = {
  [PINS.workflowPath]: readFileSync(join(repoRoot, '.github', 'workflows', 'cloud-precheck.yml')),
  [PINS.receiptScriptPath]: readFileSync(join(repoRoot, 'scripts', 'cloud-precheck', 'receipt.mjs')),
  [PINS.reconstructScriptPath]: readFileSync(join(repoRoot, 'scripts', 'cloud-precheck', 'reconstruct.mjs')),
}
const dispatchSha = 'd'.repeat(40)
const approvedUrl = 'git@github.com:NBStarry/deepseek-harness.git'
const approvedRemote = { name: 'origin', url: approvedUrl }

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'file.txt'), 'candidate\n')
  git(repo, 'commit', '-q', '-am', 'candidate')
  const tip = git(repo, 'rev-parse', 'HEAD')
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}')
  git(repo, 'remote', 'add', 'origin', 'git@github.com:NBStarry/deepseek-harness.git')
  return { root, repo, base, tip, tree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function receiptFor({ tip, tree, overrides = {} }) {
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
    runId: '77',
    runAttempt: 1,
    candidateCommit: tip,
    candidateTree: tree,
    base: 'b'.repeat(40),
    patchSha256: 'c'.repeat(64),
    commands: ['pnpm install --frozen-lockfile', 'pnpm run typecheck'],
    conclusion: 'success',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:10:00Z',
    runner: 'ubuntu-24.04',
    ...overrides,
  }
}

function zipReceipt(text, extraMembers = []) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-zip-'))
  try {
    writeFileSync(join(dir, 'receipt.json'), text)
    const members = ['receipt.json']
    for (const member of extraMembers) {
      writeFileSync(join(dir, member), 'extra')
      members.push(member)
    }
    execFileSync('zip', ['-q', '-j', join(dir, 'receipt.zip'), ...members], { cwd: dir })
    return readFileSync(join(dir, 'receipt.zip'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runFor(overrides = {}) {
  return {
    id: 77,
    path: PINS.workflowPath,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: dispatchSha,
    head_branch: 'master',
    run_attempt: 1,
    ...overrides,
  }
}

function stepsFor(overrides = {}) {
  const definition = PINS.definitions.find(item => item.runnerLabel === 'ubuntu-24.04')
  return [definition.firstStep, ...PINS.requiredTailSteps].map(name => ({ name, conclusion: overrides[name] ?? 'success' }))
}

function jobsFor({ attempt = 1, overrides = {}, jobOverrides = {} } = {}) {
  return [{ total_count: 1, jobs: [{ name: PINS.requiredJob, conclusion: 'success', run_attempt: attempt, labels: ['ubuntu-24.04'], steps: stepsFor(overrides), ...jobOverrides }] }]
}

function gate(options = {}) {
  const {
    tip = 'f'.repeat(40), tree = 'e'.repeat(40), receiptOverrides = {}, runOverrides = {},
    jobs, artifactOverrides = {}, fileOverrides = {}, extraZipMembers = [],
  } = options
  const state = {
    run: runFor(runOverrides),
    pages: jobs ?? jobsFor({ attempt: runFor(runOverrides).run_attempt }),
    artifacts: {
      total_count: 1,
      artifacts: [{ id: 9, name: `cloud-precheck-${tip}-77-1`, expired: false, ...artifactOverrides }],
    },
    fileOverrides,
    zip: zipReceipt(serializeReceipt(receiptFor({ tip, tree, overrides: receiptOverrides })), extraZipMembers),
  }
  state.gh = (args, optionsArg = {}) => {
    const line = args.join(' ')
    if (line.includes('/actions/artifacts/') && line.endsWith('/zip')) {
      return optionsArg.encoding === 'buffer' ? state.zip : state.zip.toString('latin1')
    }
    const contents = /\/contents\/(.+?)\?ref=/u.exec(line)
    if (contents !== null) {
      const override = state.fileOverrides[contents[1]]
      const text = override ?? files[contents[1]]
      if (text === undefined) throw new Error(`unexpected contents request for ${contents[1]}`)
      return text
    }
    if (line.includes('/attempts/') && line.includes('/jobs')) return JSON.stringify(state.pages)
    if (line.includes('/artifacts?per_page')) return JSON.stringify(state.artifacts)
    if (/\/actions\/runs\/[0-9]+$/u.test(line)) return JSON.stringify(state.run)
    throw new Error(`unexpected gh call: ${line}`)
  }
  return state
}

function push({ tip, remote = zero, localRef = 'refs/heads/feature' }) {
  return `${localRef} ${tip} refs/heads/feature ${remote}\n`
}

function expectFailure(f, pattern) {
  assert.throws(() => verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: f.state.gh, ...(f.pins === undefined ? {} : { pins: f.pins }), log: () => {} }), pattern)
}

test('admits one new branch push with a verified receipt', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const verified = verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: state.gh, log: () => {} })
    assert.equal(verified.length, 1)
    assert.equal(verified[0].tip, f.tip)
    assert.equal(verified[0].receipt.candidateTree, f.tree)
  } finally { f.cleanup() }
})

test('admits several refs only when they share one tip', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const stdinText = `${push({ tip: f.tip })}refs/heads/alias ${f.tip} refs/heads/alias ${zero}\n`
    assert.equal(verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText, runId: 77, gh: state.gh, log: () => {} }).length, 1)
  } finally { f.cleanup() }
})

test('verifies the pushed ref, not HEAD', () => {
  const f = fixture()
  try {
    git(f.repo, 'checkout', '-q', '--detach', f.base)
    const state = gate({ tip: f.tip, tree: f.tree })
    assert.equal(verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: state.gh, log: () => {} })[0].tip, f.tip)
  } finally { f.cleanup() }
})

test('rejects a receipt for another commit or tree', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { candidateCommit: f.base } }) },
      /different commit than the pushed tip/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { candidateTree: f.base } }) },
      /tree differs from the pushed commit tree/u)
  } finally { f.cleanup() }
})

test('rejects a changed workflow, receipt writer, or reconstruction script', () => {
  const f = fixture()
  try {
    for (const path of [PINS.workflowPath, PINS.receiptScriptPath, PINS.reconstructScriptPath]) {
      expectFailure({
        repo: f.repo,
        tip: f.tip,
        state: gate({ tip: f.tip, tree: f.tree, fileOverrides: { [path]: Buffer.concat([files[path], Buffer.from('# changed\n')]) } }),
      }, /does not match the approved hash|must match exactly one pin group/u)
    }
  } finally { f.cleanup() }
})

test('rejects cancelled runs and skipped or missing steps', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, runOverrides: { conclusion: 'cancelled' } }) }, /concluded cancelled/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: jobsFor({ overrides: { 'Run typecheck': 'skipped' } }) }) },
      /required step "Run typecheck" concluded skipped/u)
    const missing = jobsFor()
    missing[0].jobs[0].steps = missing[0].jobs[0].steps.filter(step => step.name !== 'Setup Node')
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: missing }) }, /required step "Setup Node" is missing/u)
  } finally { f.cleanup() }
})

test('rejects jobs from another attempt and an incomplete job listing', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: jobsFor({ attempt: 2 }) }) }, /job listing belongs to another attempt/u)
    const partial = jobsFor()
    partial[0].total_count = 3
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: partial }) }, /job listing is incomplete/u)
  } finally { f.cleanup() }
})

test('rejects unreachable or unparsable API answers', () => {
  const f = fixture()
  try {
    assert.throws(() => verifyPush({
      cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: () => { throw new Error('gh: connection refused') }, log: () => {},
    }), /connection refused/u)
    const garbage = (args) => {
      const line = args.join(' ')
      if (/\/actions\/runs\/[0-9]+$/u.test(line)) return 'not json'
      throw new Error(`unexpected ${line}`)
    }
    assert.throws(() => verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: garbage, log: () => {} }), /unparsable JSON/u)
  } finally { f.cleanup() }
})

test('rejects attempt reuse, expired artifacts, extra artifact members, and bad receipts', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { runAttempt: 2 } }) }, /attempt differs from the current attempt/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, artifactOverrides: { expired: true } }) }, /has expired/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, extraZipMembers: ['notes.txt'] }) }, /exactly receipt.json/u)
    const state = gate({ tip: f.tip, tree: f.tree })
    state.zip = zipReceipt(JSON.stringify({ ...receiptFor({ tip: f.tip, tree: f.tree }), extra: true }))
    expectFailure({ repo: f.repo, tip: f.tip, state }, /receipt keys must be exactly/u)
  } finally { f.cleanup() }
})

test('rejects a dispatched branch that differs from the receipt', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, runOverrides: { head_branch: 'side' } }) }, /dispatched ref differs from the run branch/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { dispatchRef: 'refs/heads/side' } }) }, /is not approved/u)
  } finally { f.cleanup() }
})

test('rejects a multi-tip push', () => {
  const f = fixture()
  try {
    git(f.repo, 'checkout', '-q', '-b', 'second', f.base)
    writeFileSync(join(f.repo, 'other.txt'), 'other\n')
    git(f.repo, 'add', '.')
    git(f.repo, 'commit', '-q', '-m', 'second tip')
    const second = git(f.repo, 'rev-parse', 'HEAD')
    const state = gate({ tip: f.tip, tree: f.tree })
    assert.throws(() => verifyPush({
      cwd: f.repo, remote: approvedRemote,
      stdinText: `${push({ tip: f.tip })}refs/heads/second ${second} refs/heads/second ${zero}\n`,
      runId: 77, gh: state.gh, log: () => {},
    }), /push one distinct tip per push/u)
  } finally { f.cleanup() }
})

test('rejects non-fast-forward updates and unknown remote revisions', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    assert.throws(() => verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.base, remote: f.tip }), runId: 77, gh: state.gh, log: () => {} }), /non-fast-forward/u)
    assert.throws(() => verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip, remote: 'a'.repeat(40) }), runId: 77, gh: state.gh, log: () => {} }), /unknown locally/u)
  } finally { f.cleanup() }
})

test('rejects a push when the hook arguments are missing or name another target', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const stdinText = push({ tip: f.tip })
    const run = remote => verifyPush({ cwd: f.repo, remote, stdinText, runId: 77, gh: state.gh, log: () => {} })
    assert.throws(() => verifyPush({ cwd: f.repo, remote: {}, stdinText, runId: 77, gh: state.gh, log: () => {} }),
      /lefthook must pass the pushed remote name and URL/u)
    assert.throws(() => run({ name: 'origin', url: 'git@github.com:someone/else.git' }), /not the approved repository/u)
    assert.throws(() => run({ name: 'origin', url: '/tmp/local-mirror.git' }), /not the approved repository/u)
    assert.throws(() => run({ name: 'origin', url: 'https://example.com/owner/repo.git' }), /not the approved repository/u)
  } finally { f.cleanup() }
})

test('admits an explicit URL push and any remote name that targets the approved repository', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const stdinText = push({ tip: f.tip })
    for (const remote of [{ name: approvedUrl, url: approvedUrl }, { name: 'mirror', url: approvedUrl }]) {
      assert.equal(verifyPush({ cwd: f.repo, remote, stdinText, runId: 77, gh: state.gh, log: () => {} }).length, 1)
    }
  } finally { f.cleanup() }
})

test('allows deletions explicitly and peels annotated tags', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const messages = []
    const deleted = verifyPush({
      cwd: f.repo, remote: approvedRemote, stdinText: `(delete) ${zero} refs/heads/old ${f.base}\n`, runId: 77, gh: state.gh, log: message => { messages.push(message) },
    })
    assert.equal(deleted.length, 0)
    assert.match(messages.join('\n'), /no receipt required/u)
    git(f.repo, 'tag', '-a', 'v1', '-m', 'tagged')
    const tag = git(f.repo, 'rev-parse', 'v1')
    assert.notEqual(tag, f.tip)
    const verified = verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: `refs/tags/v1 ${tag} refs/tags/v1 ${zero}\n`, runId: 77, gh: state.gh, log: () => {} })
    assert.equal(verified[0].tip, f.tip)
  } finally { f.cleanup() }
})

test('rejects empty, malformed, and malformed-deletion stdin', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    const run = stdinText => verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText, runId: 77, gh: state.gh, log: () => {} })
    assert.throws(() => run(''), /no ref updates/u)
    assert.throws(() => run('refs/heads/x deadbeef refs/heads/x\n'), /malformed pre-push line/u)
    assert.throws(() => run(`refs/heads/x ${'z'.repeat(40)} refs/heads/x ${zero}\n`), /malformed local sha/u)
    assert.throws(() => run(`refs/heads/x ${zero} refs/heads/x ${zero}\n`), /malformed deletion/u)
    assert.throws(() => run(`(delete) ${f.base} refs/heads/x ${zero}\n`), /malformed deletion/u)
  } finally { f.cleanup() }
})

test('parses GitHub origin URLs and receipt validation', () => {
  assert.equal(repositorySlug('git@github.com:NBStarry/deepseek-harness.git'), 'NBStarry/deepseek-harness')
  assert.equal(repositorySlug('https://github.com/NBStarry/deepseek-harness.git'), 'NBStarry/deepseek-harness')
  assert.equal(repositorySlug('ssh://git@github.com/NBStarry/deepseek-harness'), 'NBStarry/deepseek-harness')
  assert.throws(() => repositorySlug('https://example.com/owner/repo.git'), /origin must name a GitHub repository/u)
  const tip = 'a'.repeat(40)
  const tree = 'b'.repeat(40)
  assert.throws(() => serializeReceipt(receiptFor({ tip, tree, overrides: { conclusion: 'failure' } })), /conclusion must be success/u)
  assert.throws(() => serializeReceipt(receiptFor({ tip, tree, overrides: { runAttempt: 0 } })), /runAttempt must be a positive integer/u)
  assert.throws(() => serializeReceipt({ ...receiptFor({ tip, tree }), extra: true }), /receipt keys must be exactly/u)
  assert.equal(sha256('x').length, 64)
})

test('refuses a malformed pre-push line', () => {
  assert.throws(() => parsePushUpdates('a b c\n'), /malformed pre-push line/u)
  assert.equal(parsePushUpdates(`refs/heads/a ${'a'.repeat(40)} refs/heads/a ${zero}\n`).length, 1)
})

test('executes as a symlinked entry point and fails closed without a run or a valid target', () => {
  const f = fixture()
  try {
    const mirror = join(f.root, 'gate-link.mjs')
    symlinkSync(join(repoRoot, 'scripts', 'cloud-precheck', 'verify-push.mjs'), mirror)
    const invoke = (args, env) => spawnSync('node', [mirror, ...args], {
      cwd: f.repo,
      input: '',
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH, ...env },
    })
    const missingRun = invoke(['origin', approvedUrl], {})
    assert.notEqual(missingRun.status, 0, 'a symlinked gate must not exit zero without a run id')
    assert.match(missingRun.stderr, /DSH_CLOUD_PRECHECK_RUN/u)
    const missingConfig = invoke(['origin', approvedUrl], { DSH_CLOUD_PRECHECK_RUN: '77' })
    assert.notEqual(missingConfig.status, 0, 'a symlinked gate must not exit zero without GH_CONFIG_DIR')
    assert.match(missingConfig.stderr, /GH_CONFIG_DIR/u)
    const emptyStdin = invoke(['origin', approvedUrl], {
      DSH_CLOUD_PRECHECK_RUN: '77', GH_CONFIG_DIR: '/nonexistent-config-dir',
    })
    assert.notEqual(emptyStdin.status, 0, 'a symlinked gate must not exit zero without ref updates')
    assert.match(emptyStdin.stderr, /no ref updates/u)
    const foreignTarget = invoke(['origin', 'git@github.com:someone/else.git'], {
      DSH_CLOUD_PRECHECK_RUN: '77', GH_CONFIG_DIR: '/nonexistent-config-dir',
    })
    assert.notEqual(foreignTarget.status, 0, 'a symlinked gate must reject a foreign target')
    assert.match(foreignTarget.stderr, /not the approved repository/u)
  } finally { f.cleanup() }
})

test('importing the gate has no side effects and no exit status', () => {
  const f = fixture()
  try {
    const moduleUrl = new URL('../../../scripts/cloud-precheck/verify-push.mjs', import.meta.url).href
    const imported = spawnSync('node', ['--input-type=module', '-'], {
      cwd: f.repo,
      input: `await import(${JSON.stringify(moduleUrl)}); console.log('imported')\n`,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    })
    assert.equal(imported.status, 0, imported.stderr)
    assert.match(imported.stdout, /^imported$/mu)
    assert.equal(imported.stderr, '')
  } finally { f.cleanup() }
})


function workflowText() {
  return readFileSync(join(repoRoot, '.github', 'workflows', 'cloud-precheck.yml'), 'utf8')
}

function receiptFilesGh(args) {
  const line = args.join(' ')
  const match = /\/contents\/(.+?)\?ref=/u.exec(line)
  if (match === null) throw new Error(`unexpected gh call: ${line}`)
  return files[match[1]]
}

function firstStepScript(workflow) {
  const lines = workflow.split('\n')
  const start = lines.findIndex(line => line.trim() === '- name: Require GitHub-hosted Ubuntu 24.04')
  assert.notEqual(start, -1, 'Ubuntu first step missing')
  const run = lines.findIndex((line, index) => index > start && /^\s+run:\s*\|/u.test(line))
  assert.notEqual(run, -1, 'Ubuntu first step run block missing')
  const baseIndent = lines[run + 1].match(/^\s*/u)[0].length
  const body = []
  for (let index = run + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && lines[index].match(/^\s*/u)[0].length < baseIndent) break
    body.push(lines[index])
  }
  return body.map(line => line.slice(baseIndent)).join('\n')
}

function ubuntuGroup() {
  return PINS.definitions.find(definition => definition.runnerLabel === 'ubuntu-24.04')
}

function syntheticDefinition(label, firstStep, marker) {
  const bytes = {
    [PINS.workflowPath]: Buffer.from(`synthetic ${marker} workflow\n`),
    [PINS.receiptScriptPath]: Buffer.from(`synthetic ${marker} receipt\n`),
    [PINS.reconstructScriptPath]: Buffer.from(`synthetic ${marker} reconstruct\n`),
  }
  return {
    bytes,
    definition: {
      name: `synthetic-${marker}`,
      workflowFileSha256: sha256(bytes[PINS.workflowPath]),
      receiptScriptSha256: sha256(bytes[PINS.receiptScriptPath]),
      reconstructScriptSha256: sha256(bytes[PINS.reconstructScriptPath]),
      runnerLabel: label,
      firstStep,
    },
  }
}

function syntheticPins(definition) {
  return {
    repository: PINS.repository,
    workflowPath: PINS.workflowPath,
    receiptScriptPath: PINS.receiptScriptPath,
    reconstructScriptPath: PINS.reconstructScriptPath,
    allowedDispatchRefs: PINS.allowedDispatchRefs,
    requiredJob: PINS.requiredJob,
    requiredTailSteps: PINS.requiredTailSteps,
    definitions: [definition],
  }
}

test('workflow fixes ubuntu-24.04, seven inputs, ten steps, and exact ABI checks', () => {
  const workflow = workflowText()
  assert.deepEqual([...workflow.matchAll(/^\s+runs-on:\s*(.+)$/gmu)].map(match => match[1].trim()), ['ubuntu-24.04'])
  assert.doesNotMatch(workflow, /use_standby|macos-15|macos-26/u)
  const dispatchBlock = workflow.slice(workflow.indexOf('  workflow_dispatch:'), workflow.indexOf('\npermissions:'))
  const inputs = [...dispatchBlock.matchAll(/^ {6}([a-z0-9_]+):$/gmu)].map(match => match[1])
  assert.deepEqual(inputs.sort(), ['base', 'candidate_commit', 'candidate_tree', 'commit_object', 'commit_object_sha256', 'patch', 'patch_sha256'])
  const group = ubuntuGroup()
  assert.ok(group, 'ubuntu group missing')
  assert.deepEqual([...workflow.matchAll(/^ {6}- name: (.+)$/gmu)].map(match => match[1]), [group.firstStep, ...PINS.requiredTailSteps])
  assert.equal(PINS.requiredTailSteps.length, 9)
  const script = firstStepScript(workflow)
  assert.match(script, /RUNNER_ENVIRONMENT.*github-hosted/u)
  assert.match(script, /\/usr\/bin\/uname -s.*Linux/u)
  assert.match(script, /\/usr\/bin\/uname -m.*x86_64/u)
  assert.match(script, /unset ID VERSION_ID/u)
  assert.match(script, /\/etc\/os-release/u)
  assert.match(script, /ID.*ubuntu/u)
  assert.match(script, /VERSION_ID.*24\.04/u)
  assert.match(script, /RUNNER_LABEL=ubuntu-24\.04/u)
  assert.doesNotMatch(script, /ImageOS|ImageVersion|inputs\./u)
})

test('Ubuntu first step executes real logic with fixture os-release and fake absolute uname', () => {
  const workflow = workflowText()
  const script = firstStepScript(workflow)
  assert.ok((script.match(/\/etc\/os-release/gu) || []).length >= 1)
  assert.match(script, /\/usr\/bin\/uname/u)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ubuntu-host-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "${FAKE_UNAME_S:-Linux}";; -m) echo "${FAKE_UNAME_M:-x86_64}";; *) exit 2;; esac\n')
  execFileSync('chmod', ['755', join(bin, 'uname')])
  const osRelease = join(dir, 'os-release')
  writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n')
  const localScript = script.replaceAll('/usr/bin/uname', join(bin, 'uname')).replaceAll('/etc/os-release', osRelease)
  const run = (env) => spawnSync('bash', ['-c', localScript], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: join(dir, 'env'), ...env },
  })
  try {
    const ok = run({ RUNNER_ENVIRONMENT: 'github-hosted', ID: 'debian', VERSION_ID: '12' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(readFileSync(join(dir, 'env'), 'utf8'), /RUNNER_LABEL=ubuntu-24\.04/u)
    writeFileSync(osRelease, 'ID=debian\nVERSION_ID="24.04"\n')
    assert.notEqual(run({ RUNNER_ENVIRONMENT: 'github-hosted' }).status, 0, 'non-Ubuntu ID must fail')
    writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="22.04"\n')
    assert.notEqual(run({ RUNNER_ENVIRONMENT: 'github-hosted' }).status, 0, 'Ubuntu 22.04 must fail')
    writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n')
    assert.notEqual(run({ RUNNER_ENVIRONMENT: 'self-hosted' }).status, 0, 'non-hosted runner must fail')
    assert.notEqual(run({ RUNNER_ENVIRONMENT: 'github-hosted', FAKE_UNAME_M: 'aarch64' }).status, 0, 'non-x86_64 must fail')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pin definitions contain exact legacy-15, mac26, and ubuntu24 groups', () => {
  const labels = PINS.definitions.map(definition => definition.runnerLabel).sort()
  assert.deepEqual(labels, ['macos-15', 'macos-26', 'ubuntu-24.04'])
  const legacy = PINS.definitions.find(definition => definition.runnerLabel === 'macos-15')
  const mac26 = PINS.definitions.find(definition => definition.runnerLabel === 'macos-26')
  const ubuntu = PINS.definitions.find(definition => definition.runnerLabel === 'ubuntu-24.04')
  assert.equal(legacy.firstStep, 'Require Apple Silicon host')
  assert.equal(mac26.firstStep, 'Require Apple Silicon host')
  assert.equal(ubuntu.firstStep, 'Require GitHub-hosted Ubuntu 24.04')
  assert.equal(PINS.requiredTailSteps.length, 9)
  assert.equal(PINS.workflowFileSha256, ubuntu.workflowFileSha256)
  assert.equal(PINS.receiptScriptSha256, ubuntu.receiptScriptSha256)
  assert.equal(PINS.reconstructScriptSha256, ubuntu.reconstructScriptSha256)
  assert.equal(legacy.workflowFileSha256, '4414af7bd067f08aea4c9ecdc77b4313496fa3b6b77009025ae6d2a61357de7e')
  assert.equal(legacy.receiptScriptSha256, 'c7e7b5a5c8aa9213b275ea8f259d4603d170f9a72db9f81c0e2cf48f295a0bc5')
  assert.equal(mac26.workflowFileSha256, 'f1bc4a78874e499eaee7fde25a421385ec2fd07c83ffb0855b002205a034d77e')
  assert.equal(mac26.receiptScriptSha256, 'b2e902233c64643694b3fcd244379f2110f66f030cd7197798e7b978dc03b14c')
  for (const definition of PINS.definitions) assert.equal(definition.reconstructScriptSha256, '7d0a00313a25768fe9f7be7ad7777abfb26ff6a4b9002b8c84f3a033cc36b2bf')
  const mixed = { ...PINS, definitions: [{ name: 'mixed', workflowFileSha256: ubuntu.workflowFileSha256, receiptScriptSha256: legacy.receiptScriptSha256, reconstructScriptSha256: ubuntu.reconstructScriptSha256, runnerLabel: 'ubuntu-24.04', firstStep: ubuntu.firstStep }] }
  assert.throws(() => verifyPinnedDefinition({ gh: receiptFilesGh, pins: mixed, repository: PINS.repository, dispatchSha }), /must match exactly one pin group/u)
})

test('Ubuntu exact label and receipt are admitted; Mac or unknown labels rejected', () => {
  const f = fixture()
  try {
    const state = gate({ tip: f.tip, tree: f.tree })
    assert.equal(verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: state.gh, log: () => {} }).length, 1)
    for (const labels of [[], ['macos-15'], ['macos-26'], ['self-hosted'], ['ubuntu-24.04', 'macos-26']]) {
      expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: jobsFor({ jobOverrides: { labels } }) }) }, /required job labels/u)
    }
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: jobsFor({ jobOverrides: { labels: ['ubuntu-24.04'] } }), receiptOverrides: { runner: 'macos-26' } }) }, /receipt runner/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { runner: 'macos-15' } }) }, /receipt runner/u)
  } finally { f.cleanup() }
})

test('synthetic Mac 15/26 tuples require old first step and their exact single label', () => {
  const f = fixture()
  try {
    for (const [label, marker] of [['macos-15', 'mac15'], ['macos-26', 'mac26']]) {
      const { bytes, definition } = syntheticDefinition(label, 'Require Apple Silicon host', marker)
      const pins = syntheticPins(definition)
      const steps = [definition.firstStep, ...PINS.requiredTailSteps].map(name => ({ name, conclusion: 'success' }))
      const receiptOverrides = { runner: label, workflowFileSha256: definition.workflowFileSha256, receiptScriptSha256: definition.receiptScriptSha256, reconstructScriptSha256: definition.reconstructScriptSha256 }
      const state = gate({ tip: f.tip, tree: f.tree, fileOverrides: bytes, receiptOverrides, jobs: jobsFor({ jobOverrides: { labels: [label], steps } }) })
      assert.equal(verifyPush({ cwd: f.repo, remote: approvedRemote, stdinText: push({ tip: f.tip }), runId: 77, gh: state.gh, pins, log: () => {} }).length, 1)
      const wrongLabel = label === 'macos-15' ? 'macos-26' : 'macos-15'
      expectFailure({ repo: f.repo, tip: f.tip, pins, state: gate({ tip: f.tip, tree: f.tree, fileOverrides: bytes, receiptOverrides, jobs: jobsFor({ jobOverrides: { labels: [wrongLabel], steps } }) }) }, /required job labels/u)
      const ubuntuFirst = [ubuntuGroup().firstStep, ...PINS.requiredTailSteps].map(name => ({ name, conclusion: 'success' }))
      expectFailure({ repo: f.repo, tip: f.tip, pins, state: gate({ tip: f.tip, tree: f.tree, fileOverrides: bytes, receiptOverrides, jobs: jobsFor({ jobOverrides: { labels: [label], steps: ubuntuFirst } }) }) }, /required step/u)
    }
  } finally { f.cleanup() }
})

test('skipped required steps and changed tip/ref/receipts remain rejected', () => {
  const f = fixture()
  try {
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, jobs: jobsFor({ overrides: { 'Run typecheck': 'skipped' } }) }) }, /concluded skipped/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, receiptOverrides: { candidateCommit: f.base } }) }, /different commit/u)
    expectFailure({ repo: f.repo, tip: f.tip, state: gate({ tip: f.tip, tree: f.tree, runOverrides: { head_branch: 'side' } }) }, /dispatched ref differs/u)
    const state = gate({ tip: f.tip, tree: f.tree })
    state.zip = zipReceipt(JSON.stringify({ ...receiptFor({ tip: f.tip, tree: f.tree }), extra: true }))
    expectFailure({ repo: f.repo, tip: f.tip, state }, /receipt keys must be exactly/u)
  } finally { f.cleanup() }
})
