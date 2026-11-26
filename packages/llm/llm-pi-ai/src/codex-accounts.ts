/** Private Codex grant ownership and the masked account-management service. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { recordKeyFor } from './auth.ts'
import { catalogProvider } from './catalog.ts'

const PROVIDER = 'openai-codex'

const DEVICE_PAGE = 'https://auth.openai.com/codex/device'
const ACCOUNT_REF = /^account-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const selection = defineDomain({ name: 'codex_accounts', version: 1, tables: {}, global: {
  initial: { ref: 'legacy' }, schema: z.strictObject({ ref: z.union([z.literal('legacy'), z.string().regex(ACCOUNT_REF)]) }),
} })
const labelSchema = z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}]+$/u)
const grantSchema = z.object({ type: z.literal('oauth'), access: z.string().min(1), refresh: z.string(),
  expires: z.number().finite(), accountId: z.string().min(1) })
const namedSchema = z.object({ label: labelSchema, grant: grantSchema })
const legacyKey = recordKeyFor(PROVIDER)

function denied(suffix: string): never {
  throw Object.assign(new Error('Codex account operation unavailable or rejected.'), { code: `PI_AI_${suffix}` })
}

function accountKey(ref: string, scope: string) {
  if (ref === 'legacy') return legacyKey
  if (!ACCOUNT_REF.test(ref)) denied('ACCOUNT_UNAVAILABLE')
  return credentialKey(`codex-accounts-${scope}`, ref)
}

function unpack(ref: string, record?: CredentialRecord) {
  if (record?.kind !== 'grant') return undefined
  if (ref === 'legacy') {
    const parsed = grantSchema.safeParse(record.payload)
    return parsed.success ? { label: 'Existing login', grant: parsed.data } : undefined
  }
  return namedSchema.safeParse(record.payload).data
}

type Phase = 'running' | 'authorized' | 'cancelled' | 'failed'
interface AttemptView {
  id: string
  targetLabel: string
  phase: Phase
  notice?: { message: string; url: string; code?: string }
  prompt?: { kind: 'select' | 'secret'; message: string; options?: { id: string; label: string }[] }
}
interface Attempt {
  view: AttemptView
  controller: AbortController
  answer?: (value: string) => void
  committing?: boolean
}
interface Snapshot {
  revision: string
  activeRef: string | null
  writable: boolean
  accounts: { ref: string; label: string; maskedAccountId: string | null; status: 'ready' | 'expired' | 'unavailable' }[]
  attempt?: AttemptView
}

function status(account: ReturnType<typeof unpack>) {
  if (!account) return 'unavailable' as const
  return account.grant.expires > Date.now() || account.grant.refresh ? 'ready' as const : 'expired' as const
}

function browserUrl(raw: string) {
  const url = new URL(raw)
  const required = {
    response_type: 'code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', redirect_uri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access', code_challenge_method: 'S256', id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true', originator: 'pi',
  }
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash
    || url.searchParams.size !== Object.keys(required).length + 2
    || Object.entries(required).some(([key, value]) => url.searchParams.get(key) !== value)
    || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('code_challenge') ?? '')
    || !/^[0-9a-f]{32}$/u.test(url.searchParams.get('state') ?? '')) denied('ACCOUNTS_UNAVAILABLE')
  return url.href
}

function oauth() {
  return catalogProvider(PROVIDER)?.auth.oauth ?? denied('ACCOUNTS_UNAVAILABLE')
}

class Owner {
  readonly lifetime = new AbortController()
  private opening?: Promise<Domain<typeof selection>>
  private attempt?: Attempt
  private revision: string = randomUUID()
  private changing = false
  private readonly logins = new Set<Promise<void>>()
  private waiters = new Set<() => void>()

  constructor(private readonly ctx: Context, private readonly scope: string) {}

  changed() {
    this.revision = randomUUID()
    for (const wake of this.waiters) wake()
  }

  async close() {
    this.lifetime.abort()
    this.attempt?.controller.abort()
    this.changed()
    await Promise.all(this.logins)
    if (this.opening) await (await this.opening).close()
  }

  private check(provider = PROVIDER) {
    if (provider !== PROVIDER || this.lifetime.signal.aborted) denied('ACCOUNTS_UNAVAILABLE')
  }

  private store() {
    this.check()
    return this.ctx.get('credentials') ?? denied('ACCOUNTS_UNAVAILABLE')
  }

  private domain() {
    this.check()
    const storage = this.ctx.get('storageDomain') ?? denied('ACCOUNTS_UNAVAILABLE')
    return this.opening ??= storage.open({ ...selection, name: `codex_accounts_${this.scope}` }).catch(() => {
      delete this.opening
      return denied('ACCOUNTS_UNAVAILABLE')
    })
  }

  async resolveSelected(): Promise<{ apiKey: string; isCurrent: () => boolean }> {
    const domain = await this.domain()
    for (;;) {
      this.check()
      const ref = domain.global.get().ref
      const generation = this.revision
      const isCurrent = () => !this.lifetime.signal.aborted && domain.global.get().ref === ref && this.revision === generation
      const key = accountKey(ref, this.scope)
      try {
        const store = this.store()
        let data = unpack(ref, await store.readRecord(key))
        if (!data) denied('ACCOUNT_UNAVAILABLE')
        if (data.grant.expires <= Date.now()) {
          const result = await store.modifyRecord(key, async (current) => {
            const held = unpack(ref, current)
            if (!held || status(held) !== 'ready') denied('ACCOUNT_UNAVAILABLE')
            if (held.grant.expires > Date.now() || !isCurrent()) return undefined
            const next = grantSchema.parse(await oauth().refresh(held.grant, AbortSignal.timeout(15_000)))
            if (next.accountId !== held.grant.accountId) denied('ACCOUNT_UNAVAILABLE')
            return { kind: 'grant', payload: ref === 'legacy' ? next : { label: held.label, grant: next } }
          })
          data = unpack(ref, result)
        }
        if (!isCurrent()) continue
        if (!data || data.grant.expires <= Date.now()) denied('ACCOUNT_UNAVAILABLE')
        const { apiKey } = await oauth().toAuth(data.grant)
        if (!apiKey) denied('ACCOUNT_UNAVAILABLE')
        const expires = data.grant.expires
        return { apiKey, isCurrent: () => isCurrent() && Date.now() < expires }
      } catch (_error) {
        // The issuer may echo token material; expose neither its error nor its cause.
        this.check()
        if (isCurrent()) denied('ACCOUNT_UNAVAILABLE')
      }
    }
  }

  async accounts(provider: string): Promise<Snapshot> {
    this.check(provider)
    const domain = await this.domain()
    const store = this.store()
    for (;;) {
      const revision = this.revision
      const refs = (await store.listRecords()).flatMap(({ key }) => key === legacyKey ? ['legacy']
        : credentialKeyScope(key) === `codex-accounts-${this.scope}` && ACCOUNT_REF.test(credentialKeyId(key)) ? [credentialKeyId(key)] : [])
      const { ref } = domain.global.get()
      if (ref !== 'legacy' && !refs.includes(ref)) refs.push(ref)
      const accounts = await Promise.all(refs.map(async (ref) => {
        const data = unpack(ref, await store.readRecord(accountKey(ref, this.scope)))
        const id = data?.grant.accountId
        return { ref, label: data?.label ?? 'Unavailable account', status: status(data),
          maskedAccountId: id && /^[a-zA-Z0-9_-]{8,}$/u.test(id) ? `••••${id.slice(-4)}` : null }
      }))
      const { writable } = await store.describeRecord(legacyKey)
      this.check(provider)
      if (revision !== this.revision) continue
      return { revision, activeRef: ref === 'legacy' && !refs.includes(ref) ? null : ref, writable, accounts,
        ...this.attempt && { attempt: structuredClone(this.attempt.view) } }
    }
  }

  async selectAccount(provider: string, { ref, expectedRevision }: { ref: string; expectedRevision: string }) {
    const snapshot = await this.accounts(provider)
    if (!snapshot.writable) denied('ACCOUNTS_READ_ONLY')
    const domain = await this.domain()
    if (expectedRevision !== this.revision || this.changing) denied('ACCOUNTS_REVISION_CONFLICT')
    if (!snapshot.accounts.some(row => row.ref === ref && row.status === 'ready')) denied('ACCOUNT_UNAVAILABLE')
    this.changing = true
    try {
      await domain.global.set({ ref })
      this.changed()
    } finally { this.changing = false }
    return this.accounts(provider)
  }

  async beginLogin(provider: string, { label }: { label?: string }) {
    const snapshot = await this.accounts(provider)
    if (!snapshot.writable) denied('ACCOUNTS_READ_ONLY')
    const targetLabel = labelSchema.safeParse(label ?? 'Codex account').data ?? denied('INVALID_ACCOUNT_LABEL')
    if (this.attempt?.view.phase === 'running') denied('LOGIN_IN_PROGRESS')
    const attempt: Attempt = { controller: new AbortController(), view: { id: randomUUID(), targetLabel, phase: 'running' } }
    this.attempt = attempt
    this.changed()
    const task = this.login(attempt)
    this.logins.add(task)
    void task.finally(() => this.logins.delete(task))
    return this.accounts(provider)
  }

  private async login(attempt: Attempt) {
    const { controller, view } = attempt
    const signal = controller.signal
    // The issuer grants a device authorization for at most fifteen minutes, including human input.
    const timer = setTimeout(() => controller.abort(), 15 * 60_000)
    timer.unref()
    try {
      const credential = await oauth().login({ signal,
        prompt: async (prompt) => {
          const pending = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal
          pending.throwIfAborted()
          if (prompt.type === 'select') {
            const options = [{ id: 'browser', label: 'Browser sign-in' }, { id: 'device_code', label: 'Device code' }]
              .filter(item => prompt.options.some(option => option.id === item.id))
            if (!options.length) denied('ACCOUNTS_UNAVAILABLE')
            view.prompt = { kind: 'select', message: 'Choose a sign-in method.', options }
          } else if (prompt.type === 'manual_code' && view.notice?.url) {
            view.prompt = { kind: 'secret', message: 'Paste the callback URL or authorization code.' }
          } else denied('ACCOUNTS_UNAVAILABLE')
          const answer = Promise.withResolvers<string>()
          const abort = () => answer.reject(new Error('Authorization prompt ended.'))
          pending.addEventListener('abort', abort, { once: true })
          attempt.answer = answer.resolve
          this.changed()
          try { return await answer.promise } finally {
            pending.removeEventListener('abort', abort)
            delete attempt.answer
            delete view.prompt
            this.changed()
          }
        },
        notify: (event) => {
          signal.throwIfAborted()
          if (event.type === 'auth_url') {
            view.notice = { message: 'Open this page to sign in.', url: browserUrl(event.url) }
          } else if (event.type === 'device_code') {
            if (event.verificationUri !== DEVICE_PAGE || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(event.userCode)) denied('ACCOUNTS_UNAVAILABLE')
            view.notice = { message: 'Enter this code on the verification page.', url: DEVICE_PAGE, code: event.userCode }
          } else return
          this.changed()
        },
      })
      const grant = grantSchema.parse(credential)
      const key = accountKey(`account-${randomUUID()}`, this.scope)
      await this.store().modifyRecord(key, async (current) => {
        signal.throwIfAborted()
        if (current) denied('ACCOUNT_CONFIG_INVALID')
        attempt.committing = true
        clearTimeout(timer)
        return { kind: 'grant', payload: { label: view.targetLabel, grant } }
      })
      signal.throwIfAborted()
      view.phase = 'authorized'
    } catch (_error) {
      if (view.phase !== 'cancelled') view.phase = 'failed'
    } finally {
      clearTimeout(timer)
      delete attempt.answer
      delete view.prompt
      delete view.notice
      this.changed()
    }
  }

  private running(provider: string, id: string) {
    this.check(provider)
    const attempt = this.attempt
    if (!attempt || attempt.view.id !== id || attempt.view.phase !== 'running' || attempt.committing || attempt.controller.signal.aborted) denied('ATTEMPT_STALE')
    return attempt
  }

  async answer(provider: string, request: { attemptId: string; value: string }) {
    const attempt = this.running(provider, request.attemptId)
    const prompt = attempt.view.prompt
    if (!attempt.answer || !prompt || request.value.length === 0 || request.value.length > 8192
      || (prompt.kind === 'select' && !prompt.options?.some(option => option.id === request.value))) denied('ATTEMPT_STALE')
    attempt.answer(request.value)
    delete attempt.answer
    delete attempt.view.prompt
    this.changed()
    return this.accounts(provider)
  }

  async cancel(provider: string, { attemptId }: { attemptId: string }) {
    const attempt = this.running(provider, attemptId)
    attempt.view.phase = 'cancelled'
    delete attempt.view.notice
    delete attempt.view.prompt
    attempt.controller.abort()
    this.changed()
    return this.accounts(provider)
  }

  async *watch(provider: string, { signal }: { signal: AbortSignal }) {
    const stop = AbortSignal.any([signal, this.lifetime.signal])
    while (!stop.aborted) {
      const snapshot = await this.accounts(provider)
      if (stop.aborted) return
      yield snapshot
      if (stop.aborted || snapshot.revision !== this.revision) continue
      const ready = Promise.withResolvers<void>()
      const resolve = () => ready.resolve()
      this.waiters.add(resolve)
      stop.addEventListener('abort', resolve, { once: true })
      try { await ready.promise } finally {
        this.waiters.delete(resolve)
        stop.removeEventListener('abort', resolve)
      }
    }
  }
}

type AccountService = Pick<Owner, 'accounts' | 'beginLogin' | 'selectAccount' | 'answer' | 'cancel' | 'watch'>
declare module '@deepseek-ai/cordis' {
  interface Context { llmPiAiAccounts: AccountService }
}

/**
 * Expose the masked owner only for an opted-in route. Secret-bearing resolution stays private to dispatch.
 * @param ctx - Owning adapter fiber.
 * @param settingsNs - Adapter entry id, scoped to the profile's composition URL.
 * @returns Private request-time credential resolution.
 */
export function registerCodexAccounts(ctx: Context, settingsNs: string) {
  const scope = createHash('sha256').update(JSON.stringify([launchEnvironmentOf(ctx).get('DSH_PROFILE_DIR')?.value ?? ctx.baseUrl, settingsNs])).digest('hex').slice(0, 24)
  const owner = new Owner(ctx, scope)
  ctx.provide('llmPiAiAccounts', {
    accounts: owner.accounts.bind(owner),
    beginLogin: owner.beginLogin.bind(owner),
    selectAccount: owner.selectAccount.bind(owner),
    answer: owner.answer.bind(owner),
    cancel: owner.cancel.bind(owner),
    watch: owner.watch.bind(owner),
  })
  ctx.on('loader/volatile-update', () => owner.changed())
  ctx.on('credentials/record-updated', (key) => {
    if (key === legacyKey || credentialKeyScope(key) === `codex-accounts-${scope}`) owner.changed()
  })
  ctx.effect(() => () => owner.close())
  return { resolveSelected: () => owner.resolveSelected() }
}
