/**
 * Keyless mock-only checks for the Phanrouter route. These never run in the
 * live CI job: they use a fake credential and a loopback server, and assert the
 * exact assistant text/finish and the single request shape. The negative case
 * proves a prompt echo containing the expected marker cannot pass the assertion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'
import { expectPhanrouterAssistant, PHANROUTER_EXPECTED } from './phanrouter-check.ts'

const model = 'deepseek-v4.1-flash-1017'
const expected = PHANROUTER_EXPECTED
const key = 'mock-phanrouter-key'

function sse(text: string): string[] {
  return [
    JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: text }, index: 0, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    '[DONE]',
  ]
}

async function routeContext(baseURL: string): Promise<Context> {
  vi.stubEnv('PHANROUTER_TEST_KEY', key)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      phanrouter: {
        api: 'openai-completions',
        apiKeyEnv: 'PHANROUTER_TEST_KEY',
        baseURL,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
        models: [{ id: model, contextWindow: 128000, maxTokens: 128 }],
      },
    },
  })
  return ctx
}

async function run(ctx: Context, prompt = `Reply exactly ${expected}`) {
  return assemble(ctx, {
    provider: 'phanrouter',
    model,
    maxTokens: 128,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] })],
  })
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

describe('Phanrouter mock-only route', () => {
  it('accepts only the exact assistant text and uses one authenticated request', async () => {
    const server = await mockServer([{ events: sse(expected) }])
    const ctx = await routeContext(server.url)
    try {
      const result = await run(ctx)
      expectPhanrouterAssistant(result)
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]).toMatchObject({ max_completion_tokens: 128 })
      expect(server.paths).toEqual(['/chat/completions'])
      expect(server.headers[0]?.authorization).toBe(`Bearer ${key}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the exact-text expectation when the model output differs despite the prompt echoing the marker', async () => {
    const observed: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        observed.push(body)
        const text = body.includes(expected) ? 'DIFFERENT' : 'UNEXPECTED'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(sse(text).map(frame => `data: ${frame}\n\n`).join(''))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
    const ctx = await routeContext(`http://127.0.0.1:${address.port}`)
    try {
      const result = await run(ctx)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toContain(expected)
      expect(() => expectPhanrouterAssistant(result)).toThrow()
      expect(result.message.content).toEqual([{ type: 'text', text: 'DIFFERENT' }])
    } finally {
      await ctx.fiber.dispose()
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
