/** Isolated Desktop credential lifecycle, cookie exchanges, and admission identity. */
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import { DesktopSshLogin, desktopIndexVerifier } from '../src/desktop-ssh-login.ts'
import { HostConnectionService } from '../src/index.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/** Plain chat for every admitted model step. */
class QuietAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Sign a legacy browser cookie with the activation secret, as an older build did. */
function legacyCookie(name: string, secret: string, authority: string, issuedAt: number, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

/** Real Connection service plus the real Session Controller on one Agent loop. */
async function admissionHarness() {
  const ctx = new Context()
  owned.add(ctx)
  ctx.baseUrl = import.meta.url
  const { records, store } = memoryStore()
  const auth = await BrowserAuth.create({}, store, 30)
  const connection = new HostConnectionService(ctx, [], auth)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new QuietAdapter())
  const agent = await loop.create(SessionId(`ssh-admission-${randomUUID()}`),
    { provider: 'mock', model: 'mock' }, { cwd: resolve('.') })
  await createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: resolve('.'),
  })
  const notices: string[] = []
  ctx.on('api-session/browser-prompt', (_owner, messageId) => { notices.push(String(messageId)) })
  const prompt = async (peer: RemoteInvocation['peer'], text: string) => {
    const signal = new AbortController().signal
    const invocation: RemoteInvocation = {
      request: { namespace: 'session', method: 'prompt', args: {} },
      service: 'sessionController', peer, signal,
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    const accepted = await ctx.extend({ invocation }).sessionController.prompt({
      sessionId: agent.session.id, requestId: randomUUID() as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text }],
    }, signal)
    await agent.whenIdle()
    return accepted
  }
  return { auth, store, records, connection, notices, prompt }
}

function memoryStore() {
  const records = new Map<CredentialKey, CredentialRecord>()
  const store: Pick<CredentialProvider, 'modifyRecord' | 'readRecord'> = {
    readRecord: key => Promise.resolve(records.get(key)),
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  }
  return { records, store }
}

const listener = { host: '127.0.0.1', port: 3080, protocol: 'http:' }
const socket = { localAddress: listener.host, localPort: listener.port, originFormRoot: true }
const host = `${listener.host}:${listener.port}`

function exchange(auth: BrowserAuth, token: string, verifier?: DesktopSshLogin['verifier'], overrides?: Partial<ConnectionIndexRequest>) {
  let status = 0
  let cookie: string | undefined
  const response: ConnectionIndexResponse = {
    writeHead(code, headers) { status = code; cookie = headers?.['set-cookie']?.split(';')[0] },
    end() {},
  }
  auth.authorizeIndex({ method: 'GET', url: `http://x/?token=${token}`, headers: { host }, ...overrides }, response, false, verifier)
  return { status, cookie }
}

it('requires explicit issuance, survives restart, and rotates without revoking existing cookies', async () => {
  const { records, store } = memoryStore()
  const auth = await BrowserAuth.create({}, store, 30)
  const controls = await DesktopSshLogin.open(store, listener.port)
  assert.equal(records.size, 1)
  assert.equal(controls.read(), undefined)
  const first = await controls.rotate()
  assert.equal(records.size, 2)
  assert.equal(exchange(auth, first).status, 401)
  const initial = exchange(auth, first, desktopIndexVerifier(controls.verifier, listener, socket))
  assert.equal(initial.status, 303)
  assert.ok(initial.cookie)
  const oldLaunch = new URL(auth.authenticatedUrl('http://example.invalid')).searchParams.get('token')!

  const restarted = await BrowserAuth.create({}, store, 30)
  const moved = await DesktopSshLogin.open(store, listener.port + 1)
  assert.equal(moved.read(), undefined)
  assert.ok(!moved.verifier.matches(first))
  const reopened = await DesktopSshLogin.open(store, listener.port)
  const verifier = desktopIndexVerifier(reopened.verifier, listener, socket)
  assert.ok(reopened.read() === first)
  assert.equal(exchange(restarted, first, verifier).status, 303)
  const second = await reopened.rotate()
  assert.ok(second !== first && reopened.read() === second)
  assert.equal(exchange(restarted, first, verifier).status, 401)
  assert.equal(exchange(restarted, second, verifier).status, 303)
  const cookieRequest = { headers: { host, cookie: initial.cookie } }
  assert.ok(restarted.isAuthenticated(cookieRequest))
  assert.equal(restarted.authenticateApi(cookieRequest), undefined)
  assert.equal(exchange(restarted, oldLaunch, verifier).status, 401)
  const launch = new URL(restarted.authenticatedUrl('http://example.invalid')).searchParams.get('token')!
  assert.equal(exchange(restarted, launch).status, 303)
})

it('denies absent or mismatched socket facts, other authorities, and non-index uses', async () => {
  const { store } = memoryStore()
  const auth = await BrowserAuth.create({}, store, 30)
  const login = await DesktopSshLogin.open(store, listener.port)
  const token = await login.rotate()
  for (const denied of [
    desktopIndexVerifier(undefined, listener, socket), desktopIndexVerifier(login.verifier, undefined, socket),
    desktopIndexVerifier(login.verifier, listener, undefined),
    desktopIndexVerifier(login.verifier, { ...listener, protocol: 'https:' }, socket),
    desktopIndexVerifier(login.verifier, { ...listener, host: '192.0.2.1' }, socket),
    desktopIndexVerifier(login.verifier, { ...listener, port: 3081 }, socket),
    desktopIndexVerifier(login.verifier, listener, { ...socket, localAddress: '192.0.2.1' }),
    desktopIndexVerifier(login.verifier, listener, { ...socket, localPort: 3081 }),
    desktopIndexVerifier(login.verifier, listener, { ...socket, originFormRoot: false }),
  ]) assert.equal(exchange(auth, token, denied).status, 401)
  for (const authority of ['trusted.example:3080', 'localhost:3080', '127.0.0.1', '127.0.0.1:3081', '127.1:3080']) {
    assert.equal(exchange(auth, token, login.verifier, { headers: { host: authority } }).status, 401)
  }
  for (const request of [
    { method: 'HEAD' }, { method: 'POST' }, { url: `/index.html?token=${token}` },
    { url: `/?token=${token}&token=${token}` }, { url: `/?token=${token}&extra=1` },
    { headers: new Headers({ host, 'x-forwarded-host': 'public.example' }) },
    { headers: { host, origin: 'https://example.invalid' } }, { headers: { host, 'sec-fetch-site': 'cross-site' } },
  ]) assert.equal(exchange(auth, token, login.verifier, request).status, 401)
  const api = { headers: { host, authorization: `Bearer ${token}` }, method: 'GET', url: `/connect?token=${token}` }
  assert.equal(auth.isAuthenticated(api), false)
  assert.equal(auth.authenticateApi(api), undefined)
  let code = 0
  auth.authorizeConnect(api, { writeHead(status) { code = status }, end() {} }, false, () => assert.fail('unexpected API Peer'))
  assert.equal(code, 401)
})

it('does not publish uncommitted credentials or treat invalid records as new tokens', async () => {
  const { store } = memoryStore()
  const login = await DesktopSshLogin.open(store, listener.port)
  const first = await login.rotate()
  const rotating = login.rotate()
  await assert.rejects(login.rotate(), /in progress/u)
  await rotating
  store.modifyRecord = () => Promise.reject(new Error('simulated write failure'))
  await assert.rejects(login.rotate(), /simulated write failure/u)
  assert.equal(login.read(), undefined)
  assert.ok(!login.verifier.matches(first))
  store.modifyRecord = () => Promise.resolve(undefined)
  await assert.rejects(login.rotate(), /not confirmed/u)
  assert.equal(login.read(), undefined)
  store.readRecord = () => Promise.resolve({ kind: 'grant', payload: { version: 1, token: 'invalid' } })
  await assert.rejects(DesktopSshLogin.open(store, listener.port), /invalid Desktop SSH/u)
  await assert.rejects(DesktopSshLogin.open(store, 0), /bound port/u)
})

/** Activation secret used by the legacy-cookie cases. */
function activationSecret(records: Map<CredentialKey, CredentialRecord>): string {
  for (const record of records.values()) {
    if (record.kind !== 'grant') continue
    const payload = record.payload
    if (typeof payload !== 'object' || payload === null) continue
    const secret = Reflect.get(payload, 'secret')
    if (typeof secret === 'string') return secret
  }
  throw new Error('test credential store has no activation secret')
}

function cookieName(cookie: string): string {
  return cookie.split('=', 1)[0]!
}

function admitPeer(connection: HostConnectionService, cookie: string) {
  const result = connection.admit({ headers: { host, cookie } })
  if ('rejection' in result) throw new Error(`unexpected admission rejection ${result.rejection}`)
  return result.peer
}

it('admits the main launch cookie as the browser peer while SSH and legacy cookies are chat-only owner peers', async () => {
  const { auth, records, store, connection, notices, prompt } = await admissionHarness()
  const launch = new URL(auth.authenticatedUrl('http://x.invalid')).searchParams.get('token')!
  const normal = exchange(auth, launch)
  assert.equal(normal.status, 303)
  assert.ok(normal.cookie)
  const login = await DesktopSshLogin.open(store, listener.port)
  const token = await login.rotate()
  const verifier = desktopIndexVerifier(login.verifier, listener, socket)!
  const ssh = exchange(auth, token, verifier)
  assert.equal(ssh.status, 303)
  assert.ok(ssh.cookie)
  const legacy = legacyCookie(cookieName(normal.cookie), activationSecret(records), host,
    Date.now() - 1000, Date.now() + 60_000)

  const launchPeer = admitPeer(connection, normal.cookie)
  assert.equal(launchPeer, connection.browserPeer)
  for (const cookie of [ssh.cookie, legacy]) {
    const peer = admitPeer(connection, cookie)
    assert.notEqual(peer, connection.browserPeer)
    assert.equal(peer.principal.kind, 'owner')
  }

  // The same login admits the same Peer object through HTTP and the WS upgrade.
  for (const cookie of [normal.cookie, ssh.cookie]) {
    const socketAdmission = connection.admitConnection({ headers: { host, cookie } })
    assert.ok('peer' in socketAdmission)
    assert.equal(socketAdmission.peer, admitPeer(connection, cookie))
    await socketAdmission.release()
  }

  // Only a launch-authenticated prompt emits the browser-input notice.
  for (const cookie of [normal.cookie, ssh.cookie, legacy]) {
    await expect(prompt(admitPeer(connection, cookie), 'ordinary chat')).resolves.toEqual({ accepted: true })
  }
  assert.equal(notices.length, 1)
})

it('keeps rotation chat-only and refuses stale, expired, or tampered credentials without re-signing', async () => {
  const { auth, records, store, connection, notices, prompt } = await admissionHarness()
  const login = await DesktopSshLogin.open(store, listener.port)
  const verifier = desktopIndexVerifier(login.verifier, listener, socket)!
  const first = await login.rotate()
  const firstCookie = exchange(auth, first, verifier).cookie!
  const firstPeer = admitPeer(connection, firstCookie)
  assert.notEqual(firstPeer, connection.browserPeer)

  // An old URL with an existing low-privilege cookie may only clean its query.
  const stale = exchange(auth, 'stale-token', verifier, { headers: { host, cookie: firstCookie } })
  assert.equal(stale.status, 303)
  assert.equal(stale.cookie, undefined)
  const bare = exchange(auth, 'stale-token', verifier)
  assert.equal(bare.status, 401)
  assert.equal(bare.cookie, undefined)

  // Expired legacy and tampered cookies never admit anything.
  const secret = activationSecret(records)
  const expired = legacyCookie(cookieName(firstCookie), secret, host, Date.now() - 60_000, Date.now() - 1000)
  assert.ok('rejection' in connection.admit({ headers: { host, cookie: expired } }))
  assert.ok('rejection' in connection.admit({ headers: { host, cookie: `${firstCookie}x` } }))

  // Rotation replaces the exchange token; the older cookie stays a chat-only owner peer.
  const second = await login.rotate()
  assert.notEqual(second, first)
  assert.equal(exchange(auth, first, verifier).status, 401)
  const secondCookie = exchange(auth, second, verifier).cookie!
  const secondPeer = admitPeer(connection, secondCookie)
  assert.notEqual(secondPeer, connection.browserPeer)
  const oldPeer = admitPeer(connection, firstCookie)
  await prompt(secondPeer, 'rotated chat')
  await prompt(oldPeer, 'old cookie chat')
  assert.equal(notices.length, 0)
})

it('fails closed when one Cookie header repeats the session name in either order', async () => {
  const { auth, store, connection } = await admissionHarness()
  const launch = new URL(auth.authenticatedUrl('http://x.invalid')).searchParams.get('token')!
  const normal = exchange(auth, launch)
  assert.ok(normal.cookie)
  const login = await DesktopSshLogin.open(store, listener.port)
  const token = await login.rotate()
  const ssh = exchange(auth, token, desktopIndexVerifier(login.verifier, listener, socket)!)
  assert.ok(ssh.cookie)
  const name = cookieName(normal.cookie)
  const normalValue = normal.cookie.slice(name.length + 1)
  const sshValue = ssh.cookie.slice(name.length + 1)
  for (const cookie of [`${name}=${normalValue}; ${name}=${sshValue}`, `${name}=${sshValue}; ${name}=${normalValue}`]) {
    const result = connection.admit({ headers: { host, cookie } })
    assert.ok('rejection' in result, 'a duplicated session cookie must not be admitted')
    assert.equal(result.rejection, 401)
  }
})

it('aborts a limited peer signal when its owning context disposes', async () => {
  const ctx = new Context()
  owned.add(ctx)
  ctx.baseUrl = import.meta.url
  const { store } = memoryStore()
  const auth = await BrowserAuth.create({}, store, 30)
  const connection = new HostConnectionService(ctx, [], auth)
  const login = await DesktopSshLogin.open(store, listener.port)
  const token = await login.rotate()
  const cookie = exchange(auth, token, desktopIndexVerifier(login.verifier, listener, socket)!).cookie!
  const peer = admitPeer(connection, cookie)
  assert.notEqual(peer, connection.browserPeer)
  assert.equal(peer.signal.aborted, false)
  await ctx.fiber.dispose()
  assert.equal(peer.signal.aborted, true)
  assert.ok('rejection' in connection.admit({ headers: { host, cookie } }))
})
