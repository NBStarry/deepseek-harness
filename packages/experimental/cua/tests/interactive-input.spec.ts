/** Desktop CUA admission: only a verified browser submission that is claimed and accepted can drive it. */
import { PassThrough, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-tool-skill'
import { expect, it, onTestFinished } from 'vitest'
import { CuaConfig, installCua } from '../src/index.ts'
import type { NativeChannel } from '../src/native-client.ts'

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

function toolCall(id: string): StreamChunk[] {
  const argumentsJson = JSON.stringify({ method: 'getCapabilities', params: {} })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name: 'cua', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name: 'cua', arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Fake helper channel: answers every request with an empty JSON result. */
function fakeChannels() {
  const requests: string[] = []
  const open = (): NativeChannel => {
    const stdout = new PassThrough()
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk)) as { id: string; method: string }
      requests.push(frame.method)
      stdout.write(Buffer.from(JSON.stringify({ id: frame.id, result: {} }) + '\n'))
      callback()
    } })
    const done = Promise.withResolvers<undefined>()
    return { stdin, stdout, done: done.promise, close: () => { done.resolve(undefined) }, waitForClose: () => done.promise }
  }
  return { requests, open }
}

function cuaProvider(channels: ReturnType<typeof fakeChannels>) {
  return {
    name: 'test-cua-interactive',
    inject: ['computerUse', 'subprocess', 'tools', 'systemPrompt', 'agents'],
    Config: CuaConfig,
    apply(ctx: Context, config: CuaConfig) {
      installCua(ctx, config, {
        helperPath: resolve('unused-cua-helper'),
        createChannel: () => channels.open(),
        description: 'Fixture computer interaction',
        guidance: 'Fixture CUA guidance',
      })
    },
  }
}

function profile(name: string): ProfileContext {
  return {
    name, dir: resolve('profile'), patchPath: resolve('profile/cordis.patch.yml'),
    installAnchor: resolve('install'), cwd: resolve('.'), home: resolve('home'),
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
}

async function setup(profileName = 'desktop') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = import.meta.url
  ctx.provide('profileContext', profile(profileName))
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Subprocess, [])
  const channels = fakeChannels()
  const mounted = await ctx.plugin(cuaProvider(channels), { agentPreset: false })
  return { ctx, mounted, channels }
}


/** Publish the real transient notice inside the production insertion window. */
function notifyOnInserted(ctx: Context, agent: Agent, messageId: MessageId): () => void {
  return ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
    if (owner === agent && message.id === messageId) ctx.emit('api-session/browser-prompt', agent, message.id)
  })
}

const toolNames = (request: GenerateOptions | undefined): string[] => request?.tools?.map(tool => tool.name) ?? []
const guidanceVisible = (request: GenerateOptions | undefined): boolean =>
  JSON.stringify(request?.messages ?? []).includes('Fixture CUA guidance')

/** Tool results of one real Agent, narrowed through the Session event union. */
function results(agent: Agent) {
  return agent.session.snapshotEvents()
    .filter((event): event is Extract<SessionEvent, { type: 'tool/result' }> => event.type === 'tool/result')
}

it('executes a verified browser prompt that is claimed and accepted', async () => {
  const adapter = new ScriptAdapter([toolCall('browser'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('browser'), { provider: 'mock', model: 'mock' })
  const message = createUserMessage({ content: [{ type: 'text', text: 'read the capabilities' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).toContain('cua')
  expect(channels.requests).toEqual(['getCapabilities'])
  expect(results(agent)[0]?.data.message.isError).toBe(false)
})

it('rejects a plain user message without the browser notification', async () => {
  const adapter = new ScriptAdapter([toolCall('plain'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('plain'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  expect(guidanceVisible(adapter.requests[0])).toBe(false)
  expect(channels.requests).toEqual([])
})

it('hides the tool when a notified prompt shares the batch with an unauthorized user message', async () => {
  const adapter = new ScriptAdapter([toolCall('mixed'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('mixed'), { provider: 'mock', model: 'mock' })
  const browser = createUserMessage({ content: [{ type: 'text', text: 'browser request' }], source: { kind: 'user' } })
  agent.inject(createUserMessage({ content: [{ type: 'text', text: 'api request' }], source: { kind: 'user' } }))
  notifyOnInserted(ctx, agent, browser.id)
  agent.followup(browser)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  expect(channels.requests).toEqual([])
})

it('denies execution when the pre-step replaces the notified prompt with context', async () => {
  const adapter = new ScriptAdapter([toolCall('replaced'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    return { ...decision, messages: [createUserMessage({ content: [{ type: 'text', text: 'context only' }], source: { kind: 'runtime-context' } })] }
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('replaced'), { provider: 'mock', model: 'mock' })
  const message = createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).toContain('cua')
  expect(channels.requests).toEqual([])
  expect(results(agent)[0]?.data.message.isError).toBe(true)
  expect(JSON.stringify(results(agent)[0]?.data.message.content)).toContain('verified browser prompt')
})

it('drops the notice on discard and on provider remount', async () => {
  const { ctx, mounted, channels } = await setup()
  const agent = await ctx.agentLoop.create(SessionId('drop'), { provider: 'mock', model: 'mock' })
  const discarded = createUserMessage({ content: [{ type: 'text', text: 'gone' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, discarded.id)
  agent.inject(discarded)
  agent.inbox.remove(discarded.id)
  await mounted.dispose()
  const remountedChannels = fakeChannels()
  const remounted = await ctx.plugin(cuaProvider(remountedChannels), { agentPreset: false })
  onTestFinished(() => remounted.dispose())
  const adapter = new ScriptAdapter([toolCall('cold'), text('ok')])
  ctx.llm.registerAdapter(['mock'], adapter)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plain after restart' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  expect(channels.requests).toEqual([])
  expect(remountedChannels.requests).toEqual([])
})

it('rejects a durable subagent session even with a browser notification', async () => {
  const adapter = new ScriptAdapter([toolCall('subagent'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const meta = { cwd: resolve('.'), origin: 'subagent' as const }
  const agent = await ctx.agentLoop.create(SessionId('subagent'), { provider: 'mock', model: 'mock' }, meta)
  const message = createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  expect(channels.requests).toEqual([])
})

it('keeps non-desktop hosts unchanged', async () => {
  const adapter = new ScriptAdapter([toolCall('web'), text('ok')])
  const { ctx, channels } = await setup('web')
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('web'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).toContain('cua')
  expect(channels.requests).toEqual(['getCapabilities'])
  expect(results(agent)[0]?.data.message.isError).toBe(false)
})

it('admits a real first turn whose harmless context is the skill catalog', async () => {
  const adapter = new ScriptAdapter([toolCall('catalog'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('catalog'), { provider: 'mock', model: 'mock' })
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'available skills' }],
    source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
  }))
  const message = createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).toContain('cua')
  expect(channels.requests).toEqual(['getCapabilities'])
})

it('does not treat a user-question reply as a new task authorization', async () => {
  const adapter = new ScriptAdapter([toolCall('question'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('question'), { provider: 'mock', model: 'mock' })
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'answer recorded' }],
    source: { kind: 'user-question-reply', callId: ToolCallId('q-1'), outcome: 'answered' },
  }))
  const message = createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  expect(channels.requests).toEqual([])
})

it('recovers on the next browser prompt after a scheduled turn', async () => {
  const adapter = new ScriptAdapter([toolCall('schedule'), text('ok'), toolCall('recover'), text('ok')])
  const { ctx, channels } = await setup()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('recover'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the schedule' }], source: { kind: 'schedule' } }))
  await agent.whenIdle()
  expect(toolNames(adapter.requests[0])).not.toContain('cua')
  const humanTurnStart = adapter.requests.length

  const message = createUserMessage({ content: [{ type: 'text', text: 'human now' }], source: { kind: 'user' } })
  notifyOnInserted(ctx, agent, message.id)
  agent.followup(message)
  await agent.whenIdle()
  expect(toolNames(adapter.requests[humanTurnStart])).toContain('cua')
  expect(channels.requests).toEqual(['getCapabilities'])
})
