/** Real Codex device login, account selection and refresh with an offline issuer. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Authorization from '@deepseek-ai/dsh-authorization'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import Llm from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Json from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'
import { assemble } from './assemble.ts'
import { catalogProvider } from '../src/catalog.ts'
import type {} from '../src/codex-accounts.ts'

const provider = 'openai-codex'
const request = { provider, model: getBuiltinModels(provider)[0]!.id, messages: [] }
type Owner = NonNullable<Context['llmPiAiAccounts']>
type Snapshot = Awaited<ReturnType<Owner['accounts']>>
let home: string
let ctx: Context

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'dsh-codex-accounts-')) })
afterEach(async () => {
  try { await ctx?.fiber.dispose() }
  finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await rm(home, { recursive: true, force: true })
  }
})

async function boot(codexAccounts = true, profileDir = home) {
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_PROFILE_DIR: profileDir } }]))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, llm: Llm, credentials: Credentials, authorization: Authorization,
    storage: Storage, domain: Domain, json: Json, pi: PiAi })
  const unexpected = (): never => { throw new Error('Unexpected module resolution in offline profile') }
  ctx.loader.internal = { version: 'v2', loadCache: new Map(), import: unexpected, register: unexpected,
    getOrCreateModuleJob: unexpected, resolveSync: unexpected, load: unexpected }
  const config = join(home, 'base.yml')
  await writeFile(config, JSON.stringify([
    { id: 'llm', name: 'cordis:llm' },
    { id: 'storage', name: 'cordis:storage' },
    { id: 'json', name: 'cordis:json', config: { root: join(home, 'data') } },
    { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(home, 'credentials.yaml'), watch: false } },
    { id: 'authorization', name: 'cordis:authorization' },
    { id: 'llm-pi-ai', name: 'cordis:pi', config: { codexAccounts, providers: { [provider]: {} } } },
  ]))
  await profileComposition(ctx, home, config)
  return ctx.get('llmPiAiAccounts')
}

function jwt(account: string, rotated = false) {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: `offline-account-${account}` }, rotated }
  return `offline.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.unsigned`
}

function offlineIssuer() {
  const refresh = Promise.withResolvers<undefined>()
  const state = { account: 'B', deviceApproval: Promise.resolve(), refreshes: 0, sent: [] as (string | null)[] }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    switch (req.url) {
      case 'https://auth.openai.com/api/accounts/deviceauth/usercode':
        return Response.json({ device_auth_id: 'offline-device', user_code: 'ABCD-1234', interval: 0 })
      case 'https://auth.openai.com/api/accounts/deviceauth/token':
        await state.deviceApproval
        return Response.json({ authorization_code: 'offline-code', code_verifier: 'offline-verifier' })
      case 'https://auth.openai.com/oauth/token': {
        const body = await req.text()
        const rotating = body.includes('refresh_token')
        if (rotating) {
          expect(body).toContain('OFFLINE_REFRESH_A')
          state.refreshes++
          await refresh.promise
        }
        const account = rotating ? 'A' : state.account
        return Response.json({ access_token: jwt(account, rotating), refresh_token: `OFFLINE_REFRESH_${account}`,
          expires_in: account === 'A' ? 3600 : 86400 })
      }
      case 'https://chatgpt.com/backend-api/codex/responses': {
        state.sent.push(req.headers.get('authorization'))
        const item = { type: 'message', id: 'msg_offline', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
        const completed = { type: 'response.completed', response: { id: 'offline', status: 'completed', output: [item],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }
        const events = [{ type: 'response.created', response: { id: 'offline' } }, { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item }, completed]
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      default: throw new Error(`Unexpected offline request: ${req.method} ${new URL(req.url).origin}`)
    }
  }
  vi.stubGlobal('fetch', fetch)
  return { state, refresh }
}

async function until(owner: Owner, matches: (value: Snapshot) => boolean) {
  const controller = new AbortController()
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
    for await (const snapshot of owner.watch(provider, { signal })) {
      expect(JSON.stringify(snapshot)).not.toMatch(/OFFLINE_REFRESH_|\.unsigned|offline-account-[AB]/)
      if (matches(snapshot)) return snapshot
    }
    throw new Error('Account watch ended before the expected snapshot')
  } finally { controller.abort() }
}

async function prompt(owner: Owner, label: string) {
  const { attempt } = await owner.beginLogin(provider, { label })
  expect(attempt?.phase).toBe('running')
  const id = attempt!.id
  await until(owner, s => s.attempt?.id === id && s.attempt.prompt?.kind === 'select')
  return id
}

async function authorize(owner: Owner, label: string) {
  const attemptId = await prompt(owner, label)
  await owner.answer(provider, { attemptId, value: 'device_code' })
  const snapshot = await until(owner, s => s.attempt?.id === attemptId && s.attempt.phase !== 'running')
  expect(snapshot.attempt?.phase).toBe('authorized')
  const account = snapshot.accounts.find(a => a.label === label)
  expect(account?.status).toBe('ready')
  return { snapshot, ref: account!.ref }
}

async function select(owner: Owner, ref: string) {
  const { revision } = await owner.accounts(provider)
  return owner.selectAccount(provider, { ref, expectedRevision: revision })
}

it('does not offer account writes on a route without the opt-in', async () => {
  offlineIssuer()
  expect(await boot(false)).toBeUndefined()
})

it('rejects cancelled attempt ids, leaves login unselected and restores only committed state on restart', async () => {
  const { state } = offlineIssuer()
  const owner = (await boot())!
  const cancelled = await prompt(owner, 'abandoned')
  const delayed = Promise.withResolvers<undefined>()
  state.deviceApproval = delayed.promise
  try {
    await owner.answer(provider, { attemptId: cancelled, value: 'device_code' })
    const notice = await until(owner, s => s.attempt?.notice?.code === 'ABCD-1234')
    expect(notice.attempt?.notice?.url).toBe('https://auth.openai.com/codex/device')
    expect((await owner.cancel(provider, { attemptId: cancelled })).attempt?.phase).toBe('cancelled')
  } finally { delayed.resolve(undefined) }
  const next = await prompt(owner, 'B')
  for (const action of [() => owner.answer(provider, { attemptId: cancelled, value: 'device_code' }),
    () => owner.cancel(provider, { attemptId: cancelled })]) {
    await expect(action()).rejects.toMatchObject({ code: 'PI_AI_ATTEMPT_STALE' })
  }
  await owner.answer(provider, { attemptId: next, value: 'device_code' })
  const authorized = await until(owner, s => s.attempt?.phase === 'authorized')
  expect(authorized.activeRef).toBeNull()
  expect(authorized.accounts).toMatchObject([{ label: 'B', status: 'ready' }])
  expect(state.sent).toEqual([])
  const b = authorized.accounts[0]!.ref
  const selected = await select(owner, b)
  expect(selected.activeRef).toBe(b)
  await expect(owner.selectAccount(provider, { ref: b, expectedRevision: authorized.revision }))
    .rejects.toMatchObject({ code: 'PI_AI_ACCOUNTS_REVISION_CONFLICT' })
  const pending = await prompt(owner, 'discard on restart')
  await ctx.fiber.dispose()
  expect(ctx.get('llmPiAiAccounts')).toBeUndefined()
  const reopened = (await boot())!
  const restored = await reopened.accounts(provider)
  expect(restored).toMatchObject({ activeRef: b, accounts: [{ ref: b, status: 'ready' }] })
  expect(restored.attempt).toBeUndefined()
  await expect(reopened.answer(provider, { attemptId: pending, value: 'device_code' })).rejects.toMatchObject({ code: 'PI_AI_ATTEMPT_STALE' })
  expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'stop' })
  expect(state.sent).toEqual([`Bearer ${jwt('B')}`])
})

it('switches to B while A refresh is blocked, then uses the rotated grant only for A', async () => {
  const { state, refresh } = offlineIssuer()
  const owner = (await boot())!
  state.account = 'A'
  const a = await authorize(owner, 'A')
  await select(owner, a.ref)
  state.account = 'B'
  const b = await authorize(owner, 'B')
  expect(b.snapshot.activeRef).toBe(a.ref)
  const now = Date.now
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 2 * 3600_000)
  expect((await owner.accounts(provider)).accounts.find(entry => entry.ref === a.ref)?.status).toBe('ready')
  const pending = assemble(ctx, request)
  try {
    await vi.waitFor(() => expect(state.refreshes).toBe(1))
    // If a shared writer lock blocks selection, release the fake issuer and fail rather than hanging teardown.
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; refresh.resolve(undefined) }, 3000)
    try { expect((await select(owner, b.ref)).activeRef).toBe(b.ref) }
    finally { clearTimeout(timer) }
    expect(timedOut).toBe(false)
    expect(state.sent).toEqual([])
  } finally {
    refresh.resolve(undefined)
    expect((await pending).finish).toMatchObject({ kind: 'stop' })
  }
  expect(state.sent).toEqual([`Bearer ${jwt('B')}`])
  await select(owner, a.ref)
  expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'stop' })
  expect(state.sent).toEqual([`Bearer ${jwt('B')}`, `Bearer ${jwt('A', true)}`])
  expect(state.refreshes).toBe(1)
})

it('accepts only one concurrent CAS and isolates private accounts and selection between profiles', async () => {
  offlineIssuer()
  const owner = (await boot())!
  const { ref, snapshot } = await authorize(owner, 'private B')
  const request = { ref, expectedRevision: snapshot.revision }
  const results = await Promise.allSettled([owner.selectAccount(provider, request), owner.selectAccount(provider, request)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PI_AI_ACCOUNTS_REVISION_CONFLICT' } })
  await ctx.fiber.dispose()
  const other = (await boot(true, join(home, 'different-profile')))!
  expect(await other.accounts(provider)).toMatchObject({ activeRef: null, accounts: [] })
  await expect(select(other, ref)).rejects.toMatchObject({ code: 'PI_AI_ACCOUNT_UNAVAILABLE' })
})

it('redacts browser callbacks and rejects issuer links with extra fields', async () => {
  const owner = (await boot())!
  const url = new URL('https://auth.openai.com/oauth/authorize')
  url.search = new URLSearchParams({ response_type: 'code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
    code_challenge_method: 'S256', code_challenge: 'A'.repeat(43), state: 'a'.repeat(32),
    originator: 'pi', codex_cli_simplified_flow: 'true', id_token_add_organizations: 'true' }).toString()
  let fail = false
  vi.spyOn(catalogProvider(provider)!.auth.oauth!, 'login').mockImplementation(async (interaction) => {
    interaction.notify({ type: 'auth_url', url: url.href, instructions: 'NEVER_ECHO' })
    const reply = await interaction.prompt({ type: 'manual_code', message: 'NEVER_ECHO' })
    expect(reply).toBe('PRIVATE_CALLBACK')
    if (fail) throw new Error('NEVER_ECHO')
    return { type: 'oauth', access: jwt('B'), refresh: 'OFFLINE_REFRESH_B', expires: Date.now() + 10000, accountId: 'offline-account-B' }
  })
  for (fail of [false, true]) {
    const initial = await owner.beginLogin(provider, { label: 'browser' })
    expect(initial.attempt?.prompt?.kind).toBe('secret')
    expect(initial.attempt?.notice?.url).toBe(url.href)
    expect(JSON.stringify(initial)).not.toContain('NEVER_ECHO')
    await owner.answer(provider, { attemptId: initial.attempt!.id, value: 'PRIVATE_CALLBACK' })
    const done = await until(owner, snapshot => snapshot.attempt?.phase !== 'running')
    expect(done.attempt?.phase).toBe(fail ? 'failed' : 'authorized')
    expect(JSON.stringify(done)).not.toMatch(/NEVER_ECHO|PRIVATE_CALLBACK/)
  }
  url.searchParams.set('access_token', 'NEVER_ECHO')
  const unsafe = await owner.beginLogin(provider, {})
  expect(unsafe.attempt?.phase).toBe('failed')
  expect(JSON.stringify(unsafe)).not.toContain('NEVER_ECHO')
})

it('expires a pending prompt and releases an awaiting observer on teardown', async () => {
  const owner = (await boot())!
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let attemptId: string
  try {
    const first = await owner.beginLogin(provider, {})
    attemptId = first.attempt!.id
    await expect(owner.beginLogin(provider, {})).rejects.toMatchObject({ code: 'PI_AI_LOGIN_IN_PROGRESS' })
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    expect((await owner.accounts(provider)).attempt?.phase).toBe('failed')
    await expect(owner.answer(provider, { attemptId, value: 'device_code' })).rejects.toMatchObject({ code: 'PI_AI_ATTEMPT_STALE' })
  } finally { vi.useRealTimers() }
  const watch = owner.watch(provider, { signal: new AbortController().signal })
  await watch.next()
  const pending = watch.next()
  await ctx.fiber.dispose()
  expect((await pending).done).toBe(true)
})

it('rejects expired or unusable legacy grants without falling back to another ready account', async () => {
  const { state } = offlineIssuer()
  const owner = (await boot())!
  const legacy = PiAi.recordKeyFor(provider)
  const grant = { type: 'oauth', access: jwt('A'), refresh: '', accountId: 'offline-account-A', expires: Date.now() - 1 }
  await ctx.credentials.modifyRecord(legacy, async () => ({ kind: 'grant', payload: grant }))
  const b = await authorize(owner, 'B')
  expect(b.snapshot.activeRef).toBe('legacy')
  for (const status of ['expired', 'unavailable']) {
    if (status === 'unavailable') await ctx.credentials.modifyRecord(legacy, async () => ({ kind: 'api-key', key: 'offline-non-oauth' }))
    const snapshot = await owner.accounts(provider)
    expect(snapshot.accounts).toContainEqual(expect.objectContaining({ ref: 'legacy', status }))
    await expect(select(owner, 'legacy')).rejects.toMatchObject({ code: 'PI_AI_ACCOUNT_UNAVAILABLE' })
    expect((await ctx.llm.listModels(provider)).length).toBeGreaterThan(0)
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error' })
    expect(state.sent).toEqual([])
    expect(state.refreshes).toBe(0)
  }
  await select(owner, b.ref)
  expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'stop' })
  expect(state.sent).toEqual([`Bearer ${jwt('B')}`])
})
