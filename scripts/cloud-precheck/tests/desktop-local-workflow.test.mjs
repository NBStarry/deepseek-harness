/** Check the manually dispatched Desktop CUA packaging option. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

test('CUA opt-in reaches packaging and is recorded', () => {
  const workflow = yaml.load(readFileSync(new URL('../../../.github/workflows/desktop-local-build.yml', import.meta.url), 'utf8'))
  const option = workflow.on.workflow_dispatch.inputs.include_cua
  assert.equal(option.type, 'boolean')
  assert.equal(option.default, false)
  const steps = workflow.jobs.build.steps
  const packaging = steps.find(step => step.name === 'Package unsigned desktop app')
  assert.equal(packaging.env.DSH_DESKTOP_INCLUDE_CUA, "${{ inputs.include_cua && '1' || '' }}")
  assert.match(packaging.run, /unset DSH_DESKTOP_INCLUDE_CUA/u)
  assert.match(packaging.run, /pnpm run package:desktop:mac:arm64:unsigned/u)
  const provenance = steps.find(step => step.name === 'Write provenance')
  assert.match(provenance.run, /"includeCua": \$\{\{ inputs\.include_cua \}\}/u)
})
