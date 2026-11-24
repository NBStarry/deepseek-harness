/** Private Desktop controls for the SSH browser-login grant; only its verifier enters Cordis. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionIndexSocket } from './rpc.ts'

const KEY = credentialKey('client-connection', 'desktop-ssh-login')
const TOKEN_FORMAT = /^ssh_[0-9a-f]{64}$/u

type LoginStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>

/** Verification-only capability, scoped to one Desktop listener. */
interface DesktopSshVerifier {
  readonly port: number
  matches(token: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopSshLogin: DesktopSshVerifier
  }
}

function storedToken(record: CredentialRecord | undefined, port: number): string | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null
    && 'version' in record.payload && record.payload.version === 1 && 'token' in record.payload
    && typeof record.payload.token === 'string' && TOKEN_FORMAT.test(record.payload.token)
    && 'port' in record.payload && typeof record.payload.port === 'number'
    && Number.isInteger(record.payload.port) && record.payload.port > 0 && record.payload.port <= 65535) {
    return record.payload.port === port ? record.payload.token : undefined
  }
  throw new Error('client-connection: invalid Desktop SSH login record')
}

/** One control handle for the single Desktop Host. Keep it private to native IPC handlers. */
export class DesktopSshLogin {
  #token: string | undefined
  #writing = false
  readonly #store: LoginStore
  /** Port-bound verifier for Connection; it exposes neither the token nor rotation. */
  readonly verifier: DesktopSshVerifier

  private constructor(store: LoginStore, port: number, token: string | undefined) {
    this.#store = store
    this.#token = token
    this.verifier = {
      port,
      matches: candidate => this.#token !== undefined && TOKEN_FORMAT.test(candidate)
        && timingSafeEqual(Buffer.from(candidate), Buffer.from(this.#token)),
    }
  }

  /**
   * Load the existing grant without generating one. Open once per active Desktop listener.
   * @param store - Desktop Host credential provider; read failures reject initialization.
   * @param port - bound port of the Desktop HTTP listener at 127.0.0.1.
   * @returns native controls and the verification-only capability to provide on the Host context.
   */
  static async open(store: LoginStore, port: number): Promise<DesktopSshLogin> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Desktop SSH login requires a bound port')
    return new DesktopSshLogin(store, port, storedToken(await store.readRecord(KEY), port))
  }

  /**
   * Read the current token for an explicit native display action.
   * @returns the token, or undefined before creation or while writes are unconfirmed.
   */
  read(): string | undefined {
    return this.#token
  }

  /**
   * Create or replace the grant on explicit user request. Concurrent rotations are refused.
   * @returns the confirmed stored token. On storage failure, login stays disabled until reopened or rotated.
   */
  async rotate(): Promise<string> {
    if (this.#writing) throw new Error('Desktop SSH login rotation in progress')
    const token = `ssh_${randomBytes(32).toString('hex')}`
    this.#writing = true
    this.#token = undefined
    try {
      const port = this.verifier.port
      const record = await this.#store.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1, port, token } }))
      if (storedToken(record, port) !== token) throw new Error('Desktop SSH login rotation was not confirmed')
      this.#token = token
      return token
    } finally {
      this.#writing = false
    }
  }
}

/**
 * Select the verifier only for a root request from the actual opted-in loopback socket.
 * @param verifier - Desktop-owned capability; absent in ordinary Web/CLI compositions.
 * @param listener - currently bound Web carrier, absent when unmounted.
 * @param socket - facts supplied only by the TCP adapter, never synthesized from request headers or a Fetch URL.
 * @returns the active verifier for this listener and socket, or undefined.
 */
export function desktopIndexVerifier(verifier: DesktopSshVerifier | undefined,
  listener: { readonly host: string; readonly port: number | undefined; readonly protocol: string } | undefined,
  socket: ConnectionIndexSocket | undefined): DesktopSshVerifier | undefined {
  return verifier !== undefined && socket?.originFormRoot === true && listener?.protocol === 'http:'
    && listener.host === '127.0.0.1' && socket.localAddress === listener.host
    && listener.port === verifier.port && socket.localPort === verifier.port ? verifier : undefined
}
