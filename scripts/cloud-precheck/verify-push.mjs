/**
 * Pre-push gate: admit a push only when every pushed tip has a verified cloud precheck receipt.
 *
 * The gate reads git's pre-push ref lines from stdin, resolves each pushed commit, and
 * requires an API-verified GitHub Actions run whose trusted definition, candidate
 * commit, tree, run attempt, job, steps, and artifact agree. Every unknown, missing, or
 * unreachable fact rejects the push: there is no local build fallback and no bypass.
 *
 * Trust boundary: this proves the candidate tree installed and type-checked on a hosted
 * runner under a pinned workflow definition. It cannot prove the candidate's own
 * package scripts were honest; review still owns that.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECEIPT_SCHEMA, sha256, validateReceiptShape } from './receipt.mjs'

/**
 * Approved gate definition. A change to the workflow or this verifier requires a
 * reviewable edit of these hashes; the workflow revision fetched from GitHub must
 * hash to exactly these values.
 */
export const PINS = Object.freeze({
  repository: 'NBStarry/deepseek-harness',
  workflowPath: '.github/workflows/cloud-precheck.yml',
  workflowFileSha256: '4414af7bd067f08aea4c9ecdc77b4313496fa3b6b77009025ae6d2a61357de7e',
  receiptScriptPath: 'scripts/cloud-precheck/receipt.mjs',
  receiptScriptSha256: 'c7e7b5a5c8aa9213b275ea8f259d4603d170f9a72db9f81c0e2cf48f295a0bc5',
  reconstructScriptPath: 'scripts/cloud-precheck/reconstruct.mjs',
  reconstructScriptSha256: '7d0a00313a25768fe9f7be7ad7777abfb26ff6a4b9002b8c84f3a033cc36b2bf',
  // GitHub registers a workflow_dispatch workflow only from the default branch.
  allowedDispatchRefs: Object.freeze(['refs/heads/master']),
  requiredJob: 'precheck',
  requiredSteps: Object.freeze([
    'Require Apple Silicon host',
    'Checkout baseline',
    'Setup Node',
    'Setup pnpm',
    'Trusted gate definition',
    'Reconstruct and verify candidate',
    'Install dependencies',
    'Run typecheck',
    'Emit receipt',
    'Upload receipt',
  ]),
})

const zeroSha = /^0{40}$/u
const commitSha = /^[a-f0-9]{40}$/u
const artifactPrefix = 'cloud-precheck-'

/**
 * Split git's pre-push stdin into pushed ref updates.
 * @param {string} text - stdin content: one `<local ref> <local sha> <remote ref> <remote sha>` per line.
 * @returns {{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }[]} Parsed updates.
 * @throws If the input is empty or any line is malformed.
 */
export function parsePushUpdates(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  if (lines.length === 0) throw new Error('git supplied no ref updates; refusing to admit an unexplained push')
  return lines.map(line => {
    const fields = line.split(/\s+/u)
    if (fields.length !== 4) throw new Error(`malformed pre-push line: ${JSON.stringify(line)}`)
    const [localRef, localSha, remoteRef, remoteSha] = fields
    if (!zeroSha.test(localSha) && !commitSha.test(localSha)) throw new Error(`malformed local sha: ${localSha}`)
    if (!zeroSha.test(remoteSha) && !commitSha.test(remoteSha)) throw new Error(`malformed remote sha: ${remoteSha}`)
    if (zeroSha.test(localSha) !== (localRef === '(delete)')) {
      throw new Error(`malformed deletion: ${localRef} ${localSha} must pair the (delete) marker with an all-zero sha`)
    }
    return { localRef, localSha, remoteRef, remoteSha }
  })
}

/**
 * Derive the GitHub repository slug from the origin remote.
 * @param {string} url - `origin` URL such as `git@github.com:Owner/Repo.git`.
 * @returns {string} `Owner/Repo`.
 * @throws If the URL is not a GitHub repository URL.
 */
export function repositorySlug(url) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(url.trim())
  if (match === null) throw new Error(`origin must name a GitHub repository, got ${JSON.stringify(url)}`)
  return `${match[1]}/${match[2]}`
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ghText(gh, args) {
  return String(gh(args))
}

function runJson(gh, args) {
  const text = ghText(gh, args)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GitHub API returned unparsable JSON for ${args.join(' ')}`)
  }
}

/**
 * Read the approved workflow definition bytes from GitHub at the dispatched revision.
 * @param {object} options - Verification inputs.
 * @param {(args: string[]) => string} options.gh - Authenticated GitHub CLI runner.
 * @param {object} options.pins - Approved gate definition.
 * @param {string} options.repository - `Owner/Repo` the run belongs to.
 * @param {string} options.dispatchSha - Revision the workflow definition was dispatched from.
 * @returns {void} Throws unless both pinned files match byte-for-byte.
 */
export function verifyPinnedDefinition({ gh, pins, repository, dispatchSha }) {
  for (const [path, expected] of [
    [pins.workflowPath, pins.workflowFileSha256],
    [pins.receiptScriptPath, pins.receiptScriptSha256],
    [pins.reconstructScriptPath, pins.reconstructScriptSha256],
  ]) {
    const bytes = ghText(gh, ['api', `repos/${repository}/contents/${path}?ref=${dispatchSha}`, '-H', 'Accept: application/vnd.github.raw'])
    if (sha256(bytes) !== expected) throw new Error(`trusted definition file ${path} at ${dispatchSha} does not match the approved hash`)
  }
}

function verifiedJobs({ gh, pins, repository, runId, attempt }) {
  const pages = runJson(gh, ['api', '--paginate', '--slurp',
    `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`])
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('job listing is empty')
  const jobs = pages.flatMap(page => {
    if (page === null || typeof page !== 'object' || !Array.isArray(page.jobs)) throw new Error('job page is malformed')
    return page.jobs
  })
  const total = pages[0].total_count
  if (typeof total !== 'number' || jobs.length !== total) throw new Error(`job listing is incomplete: ${jobs.length} of ${String(total)}`)
  if (jobs.some(job => job.run_attempt !== attempt)) throw new Error('job listing belongs to another attempt')
  const matched = jobs.filter(job => job.name === pins.requiredJob)
  if (matched.length !== 1) throw new Error(`expected exactly one ${pins.requiredJob} job, found ${matched.length}`)
  if (matched[0].conclusion !== 'success') throw new Error(`required job ${pins.requiredJob} concluded ${String(matched[0].conclusion)}`)
  const steps = Array.isArray(matched[0].steps) ? matched[0].steps : []
  for (const name of pins.requiredSteps) {
    const matches = steps.filter(step => step.name === name)
    if (matches.length !== 1) throw new Error(`required step ${JSON.stringify(name)} is missing from the precheck job`)
    if (matches[0].conclusion !== 'success') throw new Error(`required step ${JSON.stringify(name)} concluded ${String(matches[0].conclusion)}`)
  }
}

function artifactName(tip, runId, attempt) {
  return `${artifactPrefix}${tip}-${runId}-${attempt}`
}

const maxReceiptBytes = 4 * 1024 * 1024

function readReceiptFromArtifact({ gh, repository, artifactId }) {
  const zip = gh(['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`], { encoding: 'buffer' })
  const bytes = Buffer.isBuffer(zip) ? zip : Buffer.from(String(zip))
  if (bytes.length === 0 || bytes.length > maxReceiptBytes) throw new Error('receipt artifact size is outside the accepted range')
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-cloud-precheck-')), 'receipt.zip')
  try {
    writeFileSync(file, bytes)
    const members = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').map(name => name.trim()).filter(Boolean)
    if (members.length !== 1 || members[0] !== 'receipt.json') throw new Error(`receipt artifact must contain exactly receipt.json, has ${members.join(', ')}`)
    return execFileSync('unzip', ['-p', file, 'receipt.json'], { encoding: 'utf8', maxBuffer: maxReceiptBytes })
  } finally {
    rmSync(dirname(file), { recursive: true, force: true })
  }
}

function verifiedReceipt({ gh, pins, repository, runId, tip, cwd }) {
  const run = runJson(gh, ['api', `repos/${repository}/actions/runs/${runId}`])
  if (run.path !== pins.workflowPath) throw new Error(`run ${runId} ran ${String(run.path)}, not the approved workflow`)
  if (run.event !== 'workflow_dispatch') throw new Error(`run ${runId} was not dispatched`)
  if (run.status !== 'completed') throw new Error(`run ${runId} is ${String(run.status)}`)
  if (run.conclusion !== 'success') throw new Error(`run ${runId} concluded ${String(run.conclusion)}`)
  if (typeof run.head_sha !== 'string' || !commitSha.test(run.head_sha)) throw new Error(`run ${runId} has no usable dispatched revision`)
  if (typeof run.run_attempt !== 'number' || !Number.isInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error(`run ${runId} reports no attempt number; the gate will not guess which attempt produced the receipt`)
  }
  if (typeof run.head_branch !== 'string' || run.head_branch.length === 0) throw new Error(`run ${runId} reports no dispatched branch`)
  verifyPinnedDefinition({ gh, pins, repository, dispatchSha: run.head_sha })
  verifiedJobs({ gh, pins, repository, runId, attempt: run.run_attempt })
  const artifacts = runJson(gh, ['api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`])
  if (!Array.isArray(artifacts.artifacts) || artifacts.artifacts.length !== artifacts.total_count) {
    throw new Error('artifact listing is incomplete')
  }
  const name = artifactName(tip, runId, run.run_attempt)
  const expected = artifacts.artifacts.filter(artifact => artifact.name === name)
  if (expected.length !== 1) throw new Error(`run ${runId} has ${expected.length} receipts for ${tip}, expected exactly one named ${name}`)
  if (expected[0].expired !== false) throw new Error(`receipt artifact ${name} has expired`)
  const receipt = validateReceiptShape(JSON.parse(readReceiptFromArtifact({ gh, repository, artifactId: expected[0].id })))
  if (receipt.schema !== RECEIPT_SCHEMA) throw new Error('receipt schema differs from the approved schema')
  if (receipt.repository !== pins.repository) throw new Error(`receipt repository ${String(receipt.repository)} differs from ${pins.repository}`)
  if (receipt.workflowPath !== pins.workflowPath) throw new Error('receipt names a different workflow')
  if (receipt.receiptScriptPath !== pins.receiptScriptPath) throw new Error('receipt names a different verifier')
  if (receipt.workflowFileSha256 !== pins.workflowFileSha256) throw new Error('receipt workflow hash is not the approved hash')
  if (receipt.receiptScriptSha256 !== pins.receiptScriptSha256) throw new Error('receipt verifier hash is not the approved hash')
  if (receipt.runId !== String(runId)) throw new Error('receipt names a different run')
  if (receipt.runAttempt !== run.run_attempt) throw new Error('receipt attempt differs from the current attempt')
  if (receipt.dispatchSha !== run.head_sha) throw new Error('receipt dispatch revision differs from the run')
  if (!pins.allowedDispatchRefs.includes(receipt.dispatchRef)) throw new Error(`receipt dispatched ref ${String(receipt.dispatchRef)} is not approved`)
  if (`refs/heads/${run.head_branch}` !== receipt.dispatchRef) throw new Error('receipt dispatched ref differs from the run branch')
  if (receipt.reconstructScriptPath !== pins.reconstructScriptPath) throw new Error('receipt names a different reconstruction script')
  if (receipt.reconstructScriptSha256 !== pins.reconstructScriptSha256) throw new Error('receipt reconstruction hash is not the approved hash')
  if (receipt.candidateCommit !== tip) throw new Error('receipt verified a different commit than the pushed tip')
  const tree = git(cwd, ['rev-parse', '--verify', `${tip}^{tree}`])
  if (receipt.candidateTree !== tree) throw new Error('receipt tree differs from the pushed commit tree')
  return receipt
}

/**
 * Reject a push whose target is not the approved repository.
 *
 * git passes the pushed remote name and its resolved URL as the first two pre-push
 * arguments, and lefthook exposes them as `{1}` and `{2}`. The URL is the pushed target
 * for a named remote (including `pushurl`) and is the URL itself for `git push <url>`,
 * so validating it covers both forms.
 * @param {{ name?: string, url?: string }} remote - Hook arguments.
 * @param {object} pins - Approved gate definition.
 * @returns {{ name: string, url: string }} Approved push target.
 * @throws If an argument is missing or the URL is not the approved repository.
 */
export function assertApprovedRemote(remote, pins) {
  const name = typeof remote.name === 'string' ? remote.name : ''
  const url = typeof remote.url === 'string' ? remote.url : ''
  if (name.length === 0 || url.length === 0) {
    throw new Error("refusing push: lefthook must pass the pushed remote name and URL (run: node scripts/cloud-precheck/verify-push.mjs '{1}' '{2}')")
  }
  let slug
  try {
    slug = repositorySlug(url)
  } catch {
    throw new Error(`refusing push: ${name} targets ${url}, which is not the approved repository ${pins.repository}`)
  }
  if (slug !== pins.repository) throw new Error(`refusing push: ${name} targets ${url}, which is not the approved repository ${pins.repository}`)
  return { name, url }
}

/**
 * Admit or reject one push.
 * @param {object} options - Verification inputs.
 * @param {string} options.cwd - Repository the push runs in.
 * @param {string} [options.repository] - `Owner/Repo`; derived from origin when omitted.
 * @param {string} options.stdinText - git pre-push stdin.
 * @param {number} options.runId - Workflow run named by the developer; only locates the run.
 * @param {(args: string[]) => string} options.gh - Authenticated GitHub CLI runner.
 * @param {typeof PINS} [options.pins] - Approved gate definition.
 * @param {(message: string) => void} [options.log] - Progress sink.
 * @returns {{ tip: string; receipt: Record<string, unknown> }[]} Verified tips.
 * @throws If any pushed claim cannot be verified; callers must treat a throw as a rejected push.
 */
export function verifyPush({ cwd, remote, stdinText, runId, gh, pins = PINS, log = () => {} }) {
  assertApprovedRemote(remote, pins)
  const tips = new Set()
  for (const update of parsePushUpdates(stdinText)) {
    if (zeroSha.test(update.localSha)) {
      log(`deleting ${update.remoteRef} publishes no commit; no receipt required`)
      continue
    }
    const tip = git(cwd, ['rev-parse', '--verify', `${update.localSha}^{commit}`])
    if (!zeroSha.test(update.remoteSha)) {
      try {
        git(cwd, ['cat-file', '-e', `${update.remoteSha}^{commit}`])
      } catch {
        throw new Error(`remote revision ${update.remoteSha} is unknown locally; fetch before pushing so the gate can prove fast-forward`)
      }
      try {
        git(cwd, ['merge-base', '--is-ancestor', update.remoteSha, tip])
      } catch {
        throw new Error(`refusing non-fast-forward update of ${update.remoteRef}`)
      }
    }
    tips.add(tip)
  }
  if (tips.size > 1) throw new Error('a receipt covers one commit; push one distinct tip per push (multiple refs at the same tip may share it)')
  const verified = []
  for (const tip of tips) {
    log(`verifying cloud precheck for ${tip}`)
    verified.push({ tip, receipt: verifiedReceipt({ gh, pins, repository: pins.repository, runId, tip, cwd }) })
  }
  return verified
}

function defaultGh() {
  return (args, options = {}) => execFileSync('gh', args, {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

function main() {
  const [name, url, ...extra] = process.argv.slice(2)
  if (extra.length > 0) throw new Error('cloud precheck gate: unexpected extra hook arguments')
  const run = process.env.DSH_CLOUD_PRECHECK_RUN
  if (run === undefined || !/^[1-9][0-9]*$/u.test(run)) {
    throw new Error('set DSH_CLOUD_PRECHECK_RUN to the cloud precheck run id before pushing; the id only locates the run')
  }
  if (process.env.GH_CONFIG_DIR === undefined) {
    throw new Error('set GH_CONFIG_DIR so the gate can read the run through authenticated GitHub CLI calls')
  }
  const log = message => { process.stderr.write(`cloud precheck gate: ${message}\n`) }
  const verified = verifyPush({
    cwd: process.cwd(),
    remote: { name, url },
    stdinText: readFileSync(0, 'utf8'),
    runId: Number(run),
    gh: defaultGh(),
    log,
  })
  for (const { tip } of verified) log(`admitted ${tip} on a verified cloud precheck`)
}

/**
 * Report whether this module is the process entry point.
 *
 * Node resolves the executed module through the filesystem, so a launcher path that walks a
 * symlink (for example macOS `/var` to `/private/var`) differs from `process.argv[1]` by the
 * unresolved prefix. Comparing bare strings there would skip the gate and exit zero, so both
 * sides go through `realpathSync`.
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
    process.stderr.write(`cloud precheck gate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('cloud precheck gate: reject push; run the approved cloud precheck workflow for this exact commit, then retry\n')
    process.exitCode = 1
  }
}
