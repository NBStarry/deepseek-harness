/** Offline expression-scope regression for the precheck workflow; no dependencies. */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const workflowPath = join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'cloud-precheck.yml')
const lines = readFileSync(workflowPath, 'utf8').split('\n')

const stepsScopes = new Set(['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'])
const jobEnvScopes = new Set(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'])

function indentOf(line) {
  return line.length - line.trimStart().length
}

function owner(index) {
  const indent = indentOf(lines[index])
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor].trim() === '') continue
    if (indentOf(lines[cursor]) < indent) {
      return { key: lines[cursor].trim().replace(/:.*$/u, ''), indent: indentOf(lines[cursor]) }
    }
  }
  return { key: '', indent: -1 }
}

test('every workflow expression uses a context allowed at its location', () => {
  const violations = []
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/gu)) {
      const expression = match[1]
      const name = expression.split('.')[0].trim()
      const where = owner(index)
      const location = `${where.key}:${where.indent}`
      let allowed
      if (where.key === 'env' && where.indent === 4) allowed = jobEnvScopes
      else if (where.key === 'group') allowed = jobEnvScopes
      else allowed = stepsScopes
      if (!allowed.has(name)) violations.push(`line ${index + 1}: ${location} cannot read ${name} (${expression})`)
    }
  }
  assert.deepEqual(violations, [])
})

test('the candidate directory is published through the environment file, not job env', () => {
  const jobEnv = lines.findIndex(line => line === '    env:')
  assert.notEqual(jobEnv, -1)
  assert.doesNotMatch(lines[jobEnv + 1] + lines[jobEnv + 2] + lines[jobEnv + 3], /runner\./u)
  assert.ok(lines.some(line => line.includes('echo "CANDIDATE_DIR=$RUNNER_TEMP/candidate" >> "$GITHUB_ENV"')))
  assert.doesNotMatch(lines.join('\n'), /working-directory:/u)
  assert.doesNotMatch(lines.join('\n'), /\$\{\{\s*env\.CANDIDATE_DIR/u)
  const consumers = lines.filter(line => line.includes('cd "$CANDIDATE_DIR"'))
  assert.equal(consumers.length, 2)
})

test('job env only reads dispatch inputs', () => {
  const start = lines.findIndex(line => line === '    env:')
  assert.notEqual(start, -1)
  const block = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() !== '' && indentOf(lines[index]) <= 4) break
    block.push(lines[index])
  }
  assert.ok(block.length >= 8)
  for (const line of block) {
    for (const match of line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/gu)) {
      assert.equal(match[1].split('.')[0].trim(), 'inputs', `job env reads ${match[1]}`)
    }
  }
})
