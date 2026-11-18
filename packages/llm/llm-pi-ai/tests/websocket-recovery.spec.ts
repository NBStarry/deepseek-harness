import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, Context as PiContext, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const sdkStream = vi.hoisted(() => vi.fn())
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: sdkStream, streamSimple: sdkStream }),
}))

let root: string | undefined
let context: Context | undefined

const restart = 'WebSocket closed 1012 Service Restart'

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: [], api: 'openai-completions', provider: 'recovery-test', model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: 0, ...overrides,
  }
}

function failure(stage: 'before' | 'text' | 'tool', errorMessage = restart): AssistantMessageEvent[] {
  const partial = stage === 'tool'
    ? assistant({ content: [{ type: 'toolCall', id: 'discarded', name: 'count', arguments: {} }] })
    : assistant()
  const chunks: AssistantMessageEvent[] = stage === 'before' ? [] : stage === 'text' ? [
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: 'discarded text', partial },
  ] : [
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"value":', partial },
  ]
  return [
    ...stage === 'before' ? [] : [{ type: 'start' as const, partial }],
    ...chunks,
    { type: 'error', reason: 'error', error: assistant({ stopReason: 'error', errorMessage }) },
  ]
}

function text(): AssistantMessageEvent[] {
  const partial = assistant()
  return [
    { type: 'start', partial },
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: 'recovered', partial },
    { type: 'text_end', contentIndex: 0, content: 'recovered', partial },
    { type: 'done', reason: 'stop', message: assistant({ content: [{ type: 'text', text: 'recovered' }] }) },
  ]
}

function tool(): AssistantMessageEvent[] {
  const call = { type: 'toolCall' as const, id: 'completed', name: 'count', arguments: {} }
  const partial = assistant({ content: [call] })
  return [
    { type: 'start', partial },
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial },
    { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial },
    { type: 'done', reason: 'toolUse', message: assistant({ content: [call], stopReason: 'toolUse' }) },
  ]
}

async function load(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-websocket-recovery-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      recovery-test:',
    '        apiKeyEnv: DSH_WEBSOCKET_RECOVERY_TEST_KEY',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:9/v1',
    '        models:',
    '          - id: test-model',
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 2',
    '          backoff:',
    '            initialDelayMs: 1',
    '            maxDelayMs: 1',
    '            jitterRatio: 0',
    "- name: '@deepseek-ai/dsh-llm-retry'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_WEBSOCKET_RECOVERY_TEST_KEY: 'test-key' } },
  ]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-llm-retry', Retry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import: (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  return ctx
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  sdkStream.mockReset()
})

async function run(scripts: AssistantMessageEvent[][], cancel = false) {
  const requests: PiContext[] = []
  sdkStream.mockImplementation((_model: Model<'openai-completions'>, request: PiContext, options: SimpleStreamOptions) => {
    requests.push(structuredClone(request))
    expect(options.maxRetries).toBe(0)
    const events = scripts[requests.length - 1]
    if (events === undefined) throw new Error('unexpected SDK request')
    return (async function* () { yield* events })()
  })
  const ctx = await load()
  let executions = 0
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'count', description: 'Count executions', parameters: {},
    async execute() { executions++; return [{ type: 'text', text: 'counted' }] },
  })))
  const agent = await ctx.agentLoop.create(SessionId('websocket-recovery'), { provider: 'recovery-test', model: 'test-model' })
  if (cancel) ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { agent, requests, executions }
}

describe('WebSocket restart recovery through the Loader composition', () => {
  it.each(['before', 'text', 'tool'] as const)('retries a restart during %s without committing failed output', { timeout: 60_000 }, async (stage) => {
    const { agent, requests, executions } = await run([failure(stage), text()])
    const events = agent.session.snapshotEvents()
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(events.filter(event => event.type === 'step/start').map(event => [event.data.turn, event.data.step])).toEqual([[1, 1]])
    expect(events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code)).toEqual(['TRANSPORT'])
    const attempt = events.find(event => event.type === 'assistant/attempt')
    const retry = events.find(event => event.type === 'llm/retry')
    expect(attempt).toBeDefined()
    expect(attempt?.seq).toBeLessThan(retry?.seq ?? 0)
    expect(events.filter(event => event.type === 'assistant/message').map(event => [event.data.turn, event.data.step])).toEqual([[1, 1]])
    if (attempt?.type === 'assistant/attempt' && stage !== 'before') {
      expect(expandAssistantStream(attempt.data.stream).map(member => member.chunk)).toContainEqual(stage === 'text'
        ? { type: 'text-delta', index: 0, text: 'discarded text' }
        : { type: 'tool-call-delta', index: 0, id: 'discarded', name: 'count', argumentsDelta: '{"value":' })
    }
    expect(events.some(event => event.type === 'tool/call')).toBe(false)
    expect(executions).toBe(0)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] })
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('discarded')
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  })

  it('does not rerun a completed tool when the following step restarts', { timeout: 60_000 }, async () => {
    const { agent, requests, executions } = await run([tool(), failure('tool'), text()])
    const events = agent.session.snapshotEvents()
    expect(requests).toHaveLength(3)
    expect(requests[2]).toEqual(requests[1])
    expect(JSON.stringify(requests[2])).not.toContain('discarded')
    expect(requests[1]?.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'completed')).toBe(true)
    expect(executions).toBe(1)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/start').map(event => [event.data.turn, event.data.step])).toEqual([[1, 1], [1, 2]])
    expect(events.filter(event => event.type === 'llm/retry').map(event => [event.data.turn, event.data.step, event.data.failure.code])).toEqual([[1, 2, 'TRANSPORT']])
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('discarded')
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] })
  })

  it('stops when cancellation wins during retry backoff', { timeout: 60_000 }, async () => {
    const { agent, requests, executions } = await run([failure('text')], true)
    const events = agent.session.snapshotEvents()
    expect(requests).toHaveLength(1)
    expect(executions).toBe(0)
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(events.some(event => event.type === 'llm/retry-started' || event.type === 'assistant/message' || event.type === 'tool/call')).toBe(false)
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('discarded')
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })

  it.each([
    ['exhausted', [failure('before'), failure('before'), failure('before')], 3, 2, 'TRANSPORT'],
    ['permanent', [failure('before', '401 unauthorized')], 1, 0, 'AUTH'],
  ] as const)('stops on %s errors', { timeout: 60_000 }, async (_label, scripts, calls, retries, code) => {
    const { agent, requests, executions } = await run([...scripts])
    const events = agent.session.snapshotEvents()
    expect(requests).toHaveLength(calls)
    expect(executions).toBe(0)
    expect(events.filter(event => event.type === 'llm/retry')).toHaveLength(retries)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.some(event => event.type === 'assistant/message' || event.type === 'tool/call')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code } } } })
  })
})
