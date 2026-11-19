/** Shared test-only assertion for the fixed Phanrouter text contract. */
import { expect } from 'vitest'
import type { AssembledResult } from './assemble.ts'

export const PHANROUTER_EXPECTED = 'PHANROUTER_OK'

/** Concatenate only textual assistant blocks so an independent reasoning block is ignored. */
export function phanrouterAssistantText(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

/** Enforce the same exact-text-and-stop contract in live and mock tests. */
export function expectPhanrouterAssistant(result: AssembledResult): void {
  expect(phanrouterAssistantText(result)).toBe(PHANROUTER_EXPECTED)
  expect(result.finish).toEqual({ kind: 'stop' })
}
