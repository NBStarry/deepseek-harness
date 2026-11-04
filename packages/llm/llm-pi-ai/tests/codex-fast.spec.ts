import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { ReasoningEffortId, userAgent, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiRequestHeaderContext } from '../src/types.ts'
import { resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

// Deliberately unsigned, offline-only token: the SDK only decodes the account claim.
const TOKEN = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline' } })).toString('base64url')}.test`
afterEach(() => vi.unstubAllGlobals())

function captureRequests() {
  const bodies: Record<string, unknown>[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = init?.body
    const compressed = new Headers(init?.headers).get('content-encoding') === 'zstd'
    const text = typeof body === 'string' ? body
      : body instanceof Uint8Array ? (compressed ? zstdDecompressSync(body) : Buffer.from(body)).toString()
        : (() => { throw new Error('unexpected SDK request body') })()
    bodies.push(JSON.parse(text) as Record<string, unknown>)
    const item = { type: 'message', id: 'offline-message', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: 'offline-response' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {
        id: 'offline-response', status: 'completed', output: [item],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { bodies, fetch }
}

function adapterOf(provider: string, profile: PiAiProviderProfile) {
  const profiles = resolveProfiles({ [provider]: profile })
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(TOKEN),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, options: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  expect(chunks.at(-1)).toEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
}

describe('native per-request Codex priority transport', () => {
  it('sends priority only while selected and preserves reasoning through the full SDK entry', async () => {
    const { bodies, fetch } = captureRequests()
    const model = getBuiltinModels('openai-codex')[0]!
    const adapter = adapterOf('openai-codex', {
      apiKeyEnv: 'OFFLINE_UNUSED', baseURL: 'https://offline.invalid', transport: 'sse',
    })
    const options: GenerateOptions = {
      provider: 'openai-codex', model: model.id, messages: [], reasoningEffort: ReasoningEffortId('high'),
    }
    await drain(adapter, options)
    await drain(adapter, { ...options, serviceTier: 'priority' })
    await drain(adapter, { ...options, serviceTier: 'default' })
    await drain(adapter, options)
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(bodies.map(body => body.service_tier)).toEqual([undefined, 'priority', 'default', undefined])
    expect(bodies[0]).not.toHaveProperty('service_tier')
    expect(bodies[3]).not.toHaveProperty('service_tier')
    expect(bodies[1]?.reasoning).toEqual(bodies[0]?.reasoning)
    expect(bodies[1]?.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.high ?? 'high' })
  })

  it('maps tiers by Responses protocol even on a custom provider route', async () => {
    const { bodies } = captureRequests()
    const adapter = adapterOf('custom-responses', {
      api: 'openai-responses', apiKeyEnv: 'OFFLINE_UNUSED', baseURL: 'https://offline.invalid/v1',
      models: [{ id: 'offline-model', contextWindow: 8192, maxTokens: 1024 }],
    })
    const options: GenerateOptions = { provider: 'custom-responses', model: 'offline-model', messages: [] }
    for (const serviceTier of [undefined, 'default', 'priority'] as const) {
      await drain(adapter, { ...options, ...serviceTier === undefined ? {} : { serviceTier } })
    }
    expect(bodies.map(body => body.service_tier)).toEqual([undefined, 'default', 'priority'])
    expect(await adapter.resolveModel(options.provider, options.model)).toMatchObject({ serviceTiers: ['default', 'priority'] })
    expect(await adapter.listModels(options.provider)).toMatchObject([{ serviceTiers: ['default', 'priority'] }])
  })

  it('composes request headers on the priority path and protects attribution', async () => {
    const { bodies, fetch } = captureRequests()
    const profiles = resolveProfiles({ 'custom-responses': {
      api: 'openai-responses', apiKeyEnv: 'OFFLINE_UNUSED', baseURL: 'https://offline.invalid/v1',
      models: [{ id: 'offline-model', contextWindow: 8192, maxTokens: 1024 }],
    } })
    const prepareHeaders = vi.fn((request: PiAiRequestHeaderContext, headers: Headers) => {
      expect(Object.isFrozen(request)).toBe(true)
      headers.set('x-session', 'prepared')
      headers.set('user-agent', 'forged')
      return headers
    })
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve(TOKEN), auth: memoryAuth(), prepareHeaders,
    })
    await drain(adapter, {
      provider: 'custom-responses', model: 'offline-model', messages: [], serviceTier: 'priority',
      sessionId: SessionId('fast-session'), purpose: 'session-title',
    })
    expect(prepareHeaders).toHaveBeenCalledOnce()
    expect(prepareHeaders.mock.calls[0]?.[0]).toEqual({
      provider: 'custom-responses', model: 'offline-model', baseURL: 'https://offline.invalid/v1',
      sessionId: 'fast-session', purpose: 'session-title',
    })
    expect(bodies[0]?.service_tier).toBe('priority')
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-session')).toBe('prepared')
    expect(headers.get('user-agent')).toBe(userAgent())
  })

  it('fails before dispatch when priority request header preparation fails', async () => {
    const { fetch } = captureRequests()
    const profiles = resolveProfiles({ 'custom-responses': {
      api: 'openai-responses', apiKeyEnv: 'OFFLINE_UNUSED', baseURL: 'https://offline.invalid/v1',
      models: [{ id: 'offline-model', contextWindow: 8192, maxTokens: 1024 }],
    } })
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve(TOKEN), auth: memoryAuth(),
      prepareHeaders: () => { throw new Error('fixture failure') },
    })
    await expect(drain(adapter, { provider: 'custom-responses', model: 'offline-model', messages: [], serviceTier: 'priority' }))
      .rejects.toMatchObject({ code: 'REQUEST_HEADERS' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains collection-owned OAuth authentication on the priority path', async () => {
    const { bodies, fetch } = captureRequests()
    const model = getBuiltinModels('openai-codex')[0]!
    const profiles = resolveProfiles({ 'openai-codex': { baseURL: 'https://offline.invalid', transport: 'sse' } })
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ 'openai-codex': { type: 'oauth', access: TOKEN, refresh: 'offline', expires: Date.now() + 3_600_000 } }),
    })
    await drain(adapter, { provider: 'openai-codex', model: model.id, messages: [], serviceTier: 'priority' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(bodies[0]?.service_tier).toBe('priority')
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it.each(['other-provider', 'openai-codex'])('does not send priority to %s using another API', async (provider) => {
    const { bodies, fetch } = captureRequests()
    const adapter = adapterOf(provider, {
      api: 'openai-completions', apiKeyEnv: 'OFFLINE_UNUSED', baseURL: 'https://offline.invalid/v1',
      models: [{ id: 'offline-model', contextWindow: 8192, maxTokens: 1024 }],
    })
    for (const serviceTier of ['default', 'priority'] as const) {
      await expect(drain(adapter, { provider, model: 'offline-model', messages: [], serviceTier }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(bodies).toEqual([])
    expect(await adapter.resolveModel(provider, 'offline-model')).not.toHaveProperty('serviceTiers')
  })
})
