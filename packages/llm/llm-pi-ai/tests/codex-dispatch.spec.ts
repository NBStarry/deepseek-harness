import { zstdDecompressSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { assertServiceable, resolveProfiles, type PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const provider = 'openai-codex'
const model = 'gpt-5.5'
const request: GenerateOptions = {
  provider, model, sessionId: 'local-session' as NonNullable<GenerateOptions['sessionId']>,
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up the value.' }] })],
}

type Account = 'A' | 'B'
function token(account: Account): string {
  const claim = { 'https://api.openai.com/auth': { chatgpt_account_id: account } }
  return `e30.${Buffer.from(JSON.stringify(claim)).toString('base64url')}.fixture`
}

function reply(text: string, tool = false): Response {
  const items = [
    ...tool ? [{ type: 'reasoning', id: 'rs_private', encrypted_content: 'opaque-A', summary: [{ type: 'summary_text', text: 'Public summary.' }] }] : [],
    { type: 'message', id: 'msg_private', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] },
    ...tool ? [{ type: 'function_call', id: 'fc_private', call_id: 'call_local', name: 'lookup', arguments: '{"key":1}' }] : [],
  ]
  const response = { id: 'resp_private', status: 'completed', output: items, usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
  const events = [
    { type: 'response.created', response: { id: response.id } },
    ...items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ]),
    { type: 'response.completed', response },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function fixture() {
  const state = { selected: 'A' as Account }
  const grant = (account: Account) => ({ apiKey: token(account), isCurrent: () => state.selected === account })
  const resolveSelected = vi.fn(async () => grant(state.selected))
  const send = vi.fn<typeof fetch>(async () => reply('Success.'))
  const profiles = resolveProfiles({ [provider]: { headers: { 'SESSION-ID': 'bad', 'X-Client-Request-ID': 'bad', 'x-tier': 'priority' } } }, 'strict', true)
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => { throw new Error('Unexpected legacy credential resolution') },
    auth: memoryAuth(),
    codexAccounts: { resolveSelected },
    codexFetch: send,
  })
  const expectSent = (...accounts: Account[]): void => {
    expect(send.mock.calls.map(([url, init]) => {
      const headers = new Headers(init?.headers)
      return [String(url), init?.method, headers.get('chatgpt-account-id'), headers.get('authorization')]
    })).toEqual(accounts.map(id => ['https://chatgpt.com/backend-api/codex/responses', 'POST', id, `Bearer ${token(id)}`]))
  }
  return { adapter, state, grant, resolveSelected, send, expectSent }
}

async function collect(call: Pick<PreparedAdapterCall, 'stream'>, options = request): Promise<BlockAssembler> {
  const blocks = new BlockAssembler()
  for await (const chunk of call.stream(options)) blocks.push(chunk)
  return blocks
}

function wireBody(init: RequestInit | undefined): { input: Record<string, unknown>[] } {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body)
  if (!(body instanceof Uint8Array) || new Headers(init?.headers).get('content-encoding') !== 'zstd') {
    throw new Error('Expected Codex JSON or zstd-compressed JSON')
  }
  return JSON.parse(zstdDecompressSync(body).toString('utf8'))
}

describe('Codex account selection at HTTP dispatch', () => {
  it.each(['before stream', 'during resolution', 'at send'] as const)('sends only B after switching %s', async (timing) => {
    const { adapter, state, grant, resolveSelected, send, expectSent } = fixture()
    const prepared = await adapter.prepareCall(provider, model)
    expect(resolveSelected).not.toHaveBeenCalled()
    if (timing === 'before stream') state.selected = 'B'
    if (timing === 'during resolution') resolveSelected.mockImplementationOnce(async () => {
      const stale = grant(state.selected)
      await Promise.resolve()
      state.selected = 'B'
      return stale
    })
    if (timing === 'at send') {
      resolveSelected.mockResolvedValueOnce({ apiKey: token('A'), isCurrent: () => { state.selected = 'B'; return false } })
      // A yield after the final successful check would let another switch race the send.
      let insideCheckTurn = false
      resolveSelected.mockResolvedValueOnce({ apiKey: token('B'), isCurrent: () => {
        insideCheckTurn = true
        queueMicrotask(() => { insideCheckTurn = false })
        return state.selected === 'B'
      } })
      send.mockImplementationOnce(async () => {
        expect(insideCheckTurn).toBe(true)
        return reply('Success.')
      })
    }
    const result = await collect(prepared)
    expect(result.blocks()).toEqual([{ type: 'text', text: 'Success.' }])
    expectSent('B')
  })

  it('rebuilds after a refused send even when A is selected again before the SDK emits its error', async () => {
    const { adapter, resolveSelected, expectSent } = fixture()
    let checked = false
    resolveSelected.mockResolvedValueOnce({ apiKey: token('A'), isCurrent: () => {
      const current = checked
      checked = true
      return current
    } })
    expect((await collect(adapter)).finish).toEqual({ kind: 'stop' })
    expect(resolveSelected).toHaveBeenCalledTimes(2)
    expectSent('A')
  })

  it('replaces only a stale unsent grant when setup fails before the fetch hook', async () => {
    const { adapter, state, resolveSelected, expectSent } = fixture()
    resolveSelected.mockResolvedValueOnce({ apiKey: 'malformed-fixture', isCurrent: () => { state.selected = 'B'; return false } })
    expect((await collect(adapter)).finish).toEqual({ kind: 'stop' })
    expectSent('B')
    resolveSelected.mockResolvedValueOnce({ apiKey: 'malformed-fixture', isCurrent: () => true })
    expect((await collect(adapter)).finish).toMatchObject({ kind: 'error' })
    expectSent('B')
  })

  it('lets B complete while an earlier A fetch is still pending', async () => {
    const { adapter, state, send, expectSent } = fixture()
    const started = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    send.mockImplementationOnce((_url, init) => {
      started.resolve(undefined)
      expect(init?.signal?.aborted).toBe(false)
      return response.promise
    })
    const inFlight = collect(adapter)
    try {
      await started.promise
      state.selected = 'B'
      expect((await collect(adapter)).finish).toEqual({ kind: 'stop' })
      expectSent('A', 'B')
      expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    } finally { response.resolve(reply('A finished.')) }
    expect((await inFlight).blocks()).toEqual([{ type: 'text', text: 'A finished.' }])
  })

  it.each([200, 503])('keeps an already sent A response (%i); a new stream uses B', async (status) => {
    const { adapter, state, send, expectSent } = fixture()
    const prepared = await adapter.prepareCall(provider, model)
    send.mockImplementationOnce(async () => {
      state.selected = 'B'
      return status === 200 ? reply('From A.') : new Response('Synthetic A failure', { status })
    })
    const first = await collect(prepared)
    if (status === 200) expect(first.blocks()).toEqual([{ type: 'text', text: 'From A.' }])
    else expect(first.finish).toMatchObject({ kind: 'error', failure: { message: 'Synthetic A failure' } })
    expectSent('A')
    // Host recovery reuses the prepared call but opens a new stream.
    expect((await collect(prepared)).blocks()).toEqual([{ type: 'text', text: 'Success.' }])
    expectSent('A', 'B')
  })

  it('retains visible history and tool pairing without replaying account-bound state', async () => {
    const { adapter, state, send, expectSent } = fixture()
    send.mockResolvedValueOnce(reply('Checking the value.', true))
    const first = await collect(adapter)
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const message = first.message({ provider, model, replayState: first.replayState! })
    expect(JSON.stringify(message.source.replayState)).toContain('opaque-A')
    const call = message.content.find(block => block.type === 'tool-call')!
    const messages = [...request.messages, message, createToolResultMessage({
      callId: call.id, content: [{ type: 'text', text: 'The value is 42.' }], isError: false,
    })]
    state.selected = 'B'
    expect((await collect(adapter, { ...request, messages })).finish).toEqual({ kind: 'stop' })
    expectSent('A', 'B')
    const init = send.mock.calls[1]![1]
    const body = wireBody(init)
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body).not.toHaveProperty('prompt_cache_key')
    const headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    expect(headers.get('x-tier')).toBe('priority')
    expect(headers.has('session-id')).toBe(false)
    expect(headers.has('x-client-request-id')).toBe(false)
    const wire = JSON.stringify(body)
    expect(wire).not.toMatch(/opaque-A|resp_private|rs_private|fc_private|msg_private|local-session/)
    expect(wire).toContain('Look up the value.')
    expect(wire).toContain('Checking the value.')
    const calls = body.input.filter(item => item['type'] === 'function_call')
    const results = body.input.filter(item => item['type'] === 'function_call_output')
    expect(calls).toMatchObject([{ name: 'lookup', arguments: '{"key":1}' }])
    expect(calls[0]!['call_id']).toEqual(expect.any(String))
    expect(results).toMatchObject([{ call_id: calls[0]!['call_id'] }])
    expect(JSON.stringify(results[0]!['output'])).toContain('The value is 42.')
  })
})

describe('Codex account route configuration', () => {
  it.each([
    { api: 'openai-responses' },
    { baseURL: 'https://example.invalid' },
    { apiKeyEnv: 'SYNTHETIC_KEY' },
  ])('rejects conflicting Codex profile %j', (profile) => {
    expect(() => assertServiceable({ codexAccounts: true, providers: { [provider]: profile } }))
      .toThrow(/codexAccounts/)
  })

  it('cannot enable OAuth dispatch on another route through stored provider settings', () => {
    const stored = JSON.parse('{"openai":{"selectedCodex":true}}')
    expect(resolveProfiles(stored, 'deferred', true).get('openai')?.selectedCodex).toBe(false)
  })

  it.each([{}, { apiKeyEnv: 'SYNTHETIC_KEY' }] satisfies PiAiProviderProfile[])('uses ordinary credential resolution without opt-in (%j)', async (profile) => {
    const profiles = resolveProfiles({ [provider]: profile })
    // Malformed fixture keys stop inside the SDK before it opens any connection.
    const auth = memoryAuth({ [provider]: { type: 'oauth', access: 'legacy-fixture', refresh: 'unused', expires: Number.MAX_SAFE_INTEGER } })
    const resolveApiKey = vi.fn(async () => 'apiKeyEnv' in profile ? 'explicit-fixture' : undefined)
    const resolveSelected = vi.fn(async () => { throw new Error('Unexpected account lookup') })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth,
      codexAccounts: { resolveSelected } })
    expect((await collect(adapter)).finish).toMatchObject({ kind: 'error', failure: { message: 'Failed to extract accountId from token' } })
    expect(resolveApiKey).toHaveBeenCalledWith(provider, profiles.get(provider))
    expect(resolveSelected).not.toHaveBeenCalled()
  })
})
