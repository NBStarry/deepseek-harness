import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
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
    return new Response('{"error":{"message":"offline transport stop"}}', { status: 400 })
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
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
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
    await drain(adapter, options)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(bodies.map(body => body.service_tier)).toEqual([undefined, 'priority', undefined])
    expect(bodies[0]).not.toHaveProperty('service_tier')
    expect(bodies[2]).not.toHaveProperty('service_tier')
    expect(bodies[1]?.reasoning).toEqual(bodies[0]?.reasoning)
    expect(bodies[1]?.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.high ?? 'high' })
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
    await drain(adapter, { provider, model: 'offline-model', messages: [], serviceTier: 'priority' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(bodies[0]).not.toHaveProperty('service_tier')
  })
})
