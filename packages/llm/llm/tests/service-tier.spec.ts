import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class TierAdapter extends LlmAdapter {
  readonly tiers: ('default' | 'priority')[] = ['default', 'priority']
  readonly requests: GenerateOptions[] = []
  override listModels(provider: string): Promise<LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'model', name: 'Model', serviceTiers: this.tiers }])
  }
  override async resolveModel(provider: string, model: string): Promise<LlmModelInfo> {
    return { provider, id: model, name: 'Model', ...model === 'unsupported' ? {} : { serviceTiers: this.tiers } }
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new TierAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  return { ctx, adapter }
}

describe('explicit processing tiers', () => {
  it('returns detached capability arrays through catalog and exact resolution', async () => {
    const { ctx, adapter } = await harness()
    const catalog = await ctx.llm.listModels('test')
    const info = await ctx.llm.resolveModelInfo('test', 'model')
    expect(catalog[0]?.serviceTiers).toEqual(['default', 'priority'])
    expect(info.serviceTiers).toEqual(['default', 'priority'])
    expect(catalog[0]?.serviceTiers).not.toBe(adapter.tiers)
    expect(info.serviceTiers).not.toBe(adapter.tiers)
  })

  it.each([undefined, 'default', 'priority'] as const)('preserves %s through resolution, freezing and dispatch', async (serviceTier) => {
    const { ctx, adapter } = await harness()
    const config = { provider: 'test', model: 'model', ...serviceTier === undefined ? {} : { serviceTier } }
    expect(await ctx.llm.resolveCallConfig(config)).toEqual(config)
    const prepared = await ctx.llm.prepareCall(config)
    expect(prepared.config).toEqual(config)
    expect(Object.isFrozen(prepared.config)).toBe(true)
    for await (const _chunk of prepared.stream({ ...config, messages: [] })) { /* drain offline adapter */ }
    expect(adapter.requests[0]?.serviceTier).toBe(serviceTier)
    if (serviceTier === undefined) expect(adapter.requests[0]).not.toHaveProperty('serviceTier')
  })

  it.each(['default', 'priority'] as const)('rejects unsupported %s during resolution and preparation without dispatch', async (serviceTier) => {
    const { ctx, adapter } = await harness()
    const config = { provider: 'test', model: 'unsupported', serviceTier }
    await expect(ctx.llm.resolveCallConfig(config)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    await expect(ctx.llm.prepareCall(config)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(adapter.requests).toEqual([])
    expect(await ctx.llm.resolveCallConfig({ provider: 'test', model: 'unsupported' }))
      .toEqual({ provider: 'test', model: 'unsupported' })
  })
})
