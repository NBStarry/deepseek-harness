/** CUA tool and prompt ownership follows live Agent presets and provider disposal. */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CuaConfig, installCua } from '../src/index.ts'

const provider = {
  name: 'test-cua-scopes',
  inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'],
  Config: CuaConfig,
  apply(ctx: Context, config: CuaConfig) {
    installCua(ctx, config, {
      helperPath: resolve('unused-cua-helper'),
      createChannel() { throw new Error('Scope tests must not start a native helper') },
      description: 'Fixture computer interaction', guidance: 'Fixture CUA guidance',
    })
  },
}

async function setup(presetIds = ['standard', 'ptc']) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Subprocess, [])
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const id of presetIds) {
    await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
      yield await owner.agentPresets.register({ id, plugins: [] })
    } })
  }
  const create = (id: string, preset: string) => ctx.agents.create({
    sessionId: SessionId(id), setup: async (owner) => { await ctx.agentPresets.mount(owner, preset) },
  })
  return { ctx, create }
}

it('adds and removes CUA for existing and new PTC Agents without changing other presets', async () => {
  const { ctx, create } = await setup()
  const existing = await create('existing', 'ptc')
  const standard = await create('standard', 'standard')
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  const mounted = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua', text: 'Fixture CUA guidance\n\nMaximum click holdMs: 5000 ms.' }))
  await ctx.agentPresets.select(existing.agent, 'ptc')
  expect(ctx.tools.schemas(existing.agent).filter(tool => tool.name === 'cua')).toHaveLength(1)
  const fresh = await create('fresh', 'ptc')
  expect(ctx.tools.get('cua', fresh.agent)).toBeDefined()
  await ctx.agentPresets.select(existing.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  await ctx.agentPresets.select(existing.agent, 'ptc')
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  await fresh.dispose()
  expect(ctx.tools.get('cua', fresh.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua', existing.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: existing.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  const reloaded = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', existing.agent)).toBeDefined()
  expect(ctx.tools.get('cua', standard.agent)).toBeUndefined()
  await reloaded.dispose()
})

it('ignores unloaded Session selections and reports a failed live scope update', async () => {
  const { ctx, create } = await setup()
  const handle = await create('active', 'ptc')
  const mounted = await ctx.plugin(provider, {})
  await expect.poll(() => ctx.tools.get('cua', handle.agent)).toBeDefined()
  const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => {})
  const lookup = vi.spyOn(ctx.agentPresets, 'composedPreset')
  onTestFinished(() => { lookup.mockRestore(); warn.mockRestore() })
  ctx.emit('agent-preset/selected', SessionId('unloaded'), 'ptc')
  expect(lookup).not.toHaveBeenCalled()
  lookup.mockImplementationOnce(() => { throw new Error('Preset lookup failed during reload') })
  ctx.emit('agent-preset/selected', handle.agent.id, 'ptc')
  await expect.poll(() => warn.mock.calls).toEqual([['CUA tool scope update failed: Error: Preset lookup failed during reload']])
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
  await ctx.agentPresets.select(handle.agent, 'standard')
  await expect.poll(() => ctx.tools.get('cua', handle.agent)).toBeUndefined()
})

it('accepts a matching preset registered after the CUA provider', async () => {
  const { ctx, create } = await setup([])
  await ctx.plugin(provider, {})
  expect(ctx.tools.get('cua')).toBeUndefined()
  await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
    yield await owner.agentPresets.register({ id: 'ptc', plugins: [] })
  } })
  const handle = await create('late-preset', 'ptc')
  expect(ctx.tools.get('cua', handle.agent)).toBeDefined()
})

it('registers CUA for every preset in a nonempty agentPreset list and ignores other presets', async () => {
  const { ctx, create } = await setup(['ptc', 'standard', 'cordis', 'minimal'])
  const ptc = await create('listed-ptc', 'ptc')
  const standard = await create('listed-standard', 'standard')
  const cordis = await create('listed-cordis', 'cordis')
  const minimal = await create('listed-minimal', 'minimal')
  const mounted = await ctx.plugin(provider, { agentPreset: ['ptc', 'standard', 'cordis'] })
  for (const handle of [ptc, standard, cordis]) {
    await expect.poll(() => ctx.tools.get('cua', handle.agent)).toBeDefined()
  }
  expect(ctx.tools.get('cua', minimal.agent)).toBeUndefined()
  expect((await ctx.systemPrompt.assemble({ scope: standard.agent })).sections)
    .toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  expect((await ctx.systemPrompt.assemble({ scope: minimal.agent })).sections)
    .not.toContainEqual(expect.objectContaining({ name: 'computer-use:dsh-cua' }))
  await ctx.agentPresets.select(minimal.agent, 'cordis')
  await expect.poll(() => ctx.tools.get('cua', minimal.agent)).toBeDefined()
  await ctx.agentPresets.select(cordis.agent, 'minimal')
  await expect.poll(() => ctx.tools.get('cua', cordis.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua', ptc.agent)).toBeUndefined()
})

it('excludes an Agent without a composed preset from a configured list', async () => {
  const { ctx } = await setup(['ptc', 'cordis'])
  const bare = await ctx.agents.create({ sessionId: SessionId('list-bare') })
  await ctx.plugin(provider, { agentPreset: ['ptc', 'cordis'] })
  expect(ctx.tools.get('cua', bare.agent)).toBeUndefined()
})

it('still scopes a single agentPreset string to exactly that preset', async () => {
  const { ctx, create } = await setup(['ptc', 'standard', 'cordis'])
  const cordis = await create('string-cordis', 'cordis')
  const ptc = await create('string-ptc', 'ptc')
  const mounted = await ctx.plugin(provider, { agentPreset: 'cordis' })
  await expect.poll(() => ctx.tools.get('cua', cordis.agent)).toBeDefined()
  expect(ctx.tools.get('cua', ptc.agent)).toBeUndefined()
  await mounted.dispose()
  expect(ctx.tools.get('cua', cordis.agent)).toBeUndefined()
})

it('accepts list, single, false, and default agentPreset configurations', () => {
  expect(CuaConfig({}).agentPreset).toBe('ptc')
  expect(CuaConfig({ agentPreset: 'standard' }).agentPreset).toBe('standard')
  expect(CuaConfig({ agentPreset: ['ptc', 'standard', 'cordis'] }).agentPreset).toEqual(['ptc', 'standard', 'cordis'])
  expect(CuaConfig({ agentPreset: false }).agentPreset).toBe(false)
  expect(() => CuaConfig({ agentPreset: [] })).toThrow()
})

it.each([
  { programFormat: 'script', retainsState: true },
  { programFormat: 'script', retainsState: false },
  { programFormat: 'repl', retainsState: false },
  { programFormat: 'function-body', retainsState: true },
] as const)('selects CUA initialization from retention for $programFormat/$retainsState', async (runtime) => {
  const { ctx, create } = await setup()
  ctx.provide('ptcRuntime', runtime)
  await ctx.plugin(provider, {})
  const owner = await create('cua-runtime-guidance', 'ptc')
  const prompt = (await ctx.systemPrompt.assemble({ scope: owner.agent })).sections.find(section => section.name === 'computer-use:dsh-cua')?.text
  expect(prompt).toBeDefined()
  expect(prompt?.includes('Persistent PTC initialization:')).toBe(runtime.retainsState)
  expect(prompt?.includes('var cua = connectCua(() => tools.cua, text => console.log(text));')).toBe(runtime.retainsState)
})
