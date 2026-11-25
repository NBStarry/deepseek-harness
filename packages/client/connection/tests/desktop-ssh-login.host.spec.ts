/** Isolated Desktop credential lifecycle and fresh browser-cookie exchanges. */
import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import { DesktopSshLogin, desktopIndexVerifier } from '../src/desktop-ssh-login.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'

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
