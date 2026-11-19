/**
 * Live Phanrouter-compatible integration through DSH's real LlmRuntime and
 * LlmPiAi adapter. One no-tool request; the fixed route, exact model, and
 * assistant text are the contract. No loader/profile/tools/agent loop. The
 * explicit DSH_PHANROUTER_E2E selector keeps this out of the official suite.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, it } from 'vitest'
import { assemble } from './assemble.ts'
import { expectPhanrouterAssistant } from './phanrouter-check.ts'

const baseURL = 'https://cloud.phanthy.com/phanrouter/v1'
const model = 'deepseek-v4.1-flash-1017'
const apiKey = process.env.PHANROUTER_API_KEY
const selected = process.env.DSH_PHANROUTER_E2E === '1'

describe.skipIf(!selected || apiKey === undefined)('Phanrouter live OpenAI-completions route', () => {
  it('returns the exact assistant text, with no tools and one stop finish', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          phanrouter: {
            api: 'openai-completions',
            apiKeyEnv: 'PHANROUTER_API_KEY',
            baseURL,
            retryPolicy: { mode: 'normal', maxRetries: 0 },
            models: [{ id: model, contextWindow: 128000, maxTokens: 128 }],
          },
        },
      })
      const result = await assemble(ctx, {
        provider: 'phanrouter',
        model,
        maxTokens: 128,
        messages: [createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Reply exactly PHANROUTER_OK' }],
        })],
      })
      expectPhanrouterAssistant(result)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 60_000)
})
