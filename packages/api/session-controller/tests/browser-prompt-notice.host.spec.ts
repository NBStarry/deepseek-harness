/**
 * `api-session/browser-prompt`: only the authenticated browser peer's accepted
 * prompt publishes the transient notice, inside the committed inbox insertion
 * and before its first claim. Same-principal API peers, direct calls, duplicate
 * request ids, and rejected prompts publish nothing.
 */
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods, type PeerId, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestController, createSessionTestRemote } from './test-remote.ts'

const OWNER: Principal = { kind: 'owner' }
const SESSION = SessionId('browser-prompt-session')
const owned = new Set<Context>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/** Streams one plain answer for every admitted model step. */
class QuietAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function peer(ctx: Context, id: string, principal: Principal): PeerScope {
  return {
    id: id as PeerId, ctx, principal, interactions: 'answer',
    signal: new AbortController().signal, dispose: async () => {},
  }
}

function promptRequest(requestId: string, content = [{ type: 'text' as const, text: 'hello' }]): SessionPromptRequest {
  return { requestId: requestId as SessionRequestId, sessionId: SESSION, mode: 'queue', content }
}

async function harness() {
  const ctx = new Context()
  owned.add(ctx)
  ctx.baseUrl = import.meta.url
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new QuietAdapter())
  const agent = await loop.create(SESSION, { provider: 'mock', model: 'mock' }, { cwd: resolve('.') })
  const browserPeer = peer(ctx, 'authenticated-browser-peer', OWNER)
  ctx.provide('connection', { browserPeer } as never)
  const controller = await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: resolve('.'),
  })
  await expect(ctx.plugin(TypertGatewayService)).resolves.toBeDefined()
  const apiPeer = peer(ctx, 'owner-api-peer', OWNER)
  const trace: string[] = []
  ctx.on('agent/inbox/inserted', ({ agent: owner, message }) => {
    if (owner === agent) trace.push(`inserted:${String(message.id)}`)
  })
  ctx.on('api-session/browser-prompt', (owner, messageId) => {
    if (owner === agent) trace.push(`notice:${String(messageId)}`)
  })
  ctx.on('agent/inbox/claimed', ({ agent: owner, message }) => {
    if (owner === agent) trace.push(`claimed:${String(message.id)}`)
  })
  const invoke = (caller: PeerScope, request: SessionPromptRequest) => ctx.typertGateway.invoke({
    peer: caller, namespace: 'session', method: 'prompt', args: { request },
  })
  return { ctx, controller, agent, browserPeer, apiPeer, trace, invoke }
}

describe('api-session/browser-prompt producer', () => {
  it('publishes (agent, message.id) inside insertion before the claim for the browser peer', async () => {
    const { agent, controller, trace, invoke, browserPeer } = await harness()
    await invoke(browserPeer, promptRequest('browser-1'))
    await agent.whenIdle()
    expect(trace).toHaveLength(3)
    const [inserted, notice, claimed] = trace
    expect(inserted).toMatch(/^inserted:/u)
    expect(notice).toBe(`notice:${inserted?.slice('inserted:'.length)}`)
    expect(claimed).toBe(`claimed:${inserted?.slice('inserted:'.length)}`)
    expect(remoteMethods(controller).some(marker => marker.method === 'prompt')).toBe(true)
  })

  it('publishes nothing for a same-principal owner API peer on another connection', async () => {
    const { agent, trace, invoke, apiPeer } = await harness()
    await invoke(apiPeer, promptRequest('api-1'))
    await agent.whenIdle()
    expect(trace.some(entry => entry.startsWith('inserted:'))).toBe(true)
    expect(trace.some(entry => entry.startsWith('claimed:'))).toBe(true)
    expect(trace.some(entry => entry.startsWith('notice:'))).toBe(false)
  })

  it('publishes nothing without an invocation identity', async () => {
    const { ctx, trace } = await harness()
    const remote = await createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
      cwd: resolve('.'),
    })
    const accepted = await remote.prompt(promptRequest('direct-1'))
    expect(accepted.ok).toBe(true)
    expect(trace.some(entry => entry.startsWith('notice:'))).toBe(false)
  })

  it('publishes once for a duplicate request id', async () => {
    const { agent, trace, invoke, browserPeer } = await harness()
    await invoke(browserPeer, promptRequest('duplicate-1'))
    await invoke(browserPeer, promptRequest('duplicate-1'))
    await agent.whenIdle()
    expect(trace.filter(entry => entry.startsWith('notice:'))).toHaveLength(1)
    expect(trace.filter(entry => entry.startsWith('inserted:'))).toHaveLength(1)
  })

  it('publishes nothing when the Remote rejects empty content', async () => {
    const { trace, invoke, browserPeer } = await harness()
    await expect(invoke(browserPeer, promptRequest('empty-1', [])))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(trace).toEqual([])
  })

  it('publishes nothing when prompt admission rejects the Session', async () => {
    const { trace, invoke, browserPeer } = await harness()
    const missing: SessionPromptRequest = {
      requestId: 'missing-1' as SessionRequestId,
      sessionId: SessionId('missing-session'),
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    }
    await expect(invoke(browserPeer, missing)).rejects.toMatchObject({ code: 'session/not-found' })
    expect(trace).toEqual([])
  })
})
