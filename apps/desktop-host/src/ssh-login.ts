/** Binds private Desktop SSH login controls to the current Web listener and credential provider. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { DesktopSshLogin } from '@deepseek-ai/dsh-client-connection'

/** A native-menu request; an action from an older dialog must not affect a replacement binding. */
export type DesktopSshLoginRequest = { action: 'status' } | { action: 'view' | 'rotate'; revision: number }

type LoginReply =
  | { kind: 'unconfigured' | 'unavailable' | 'changed' }
  | { kind: 'ready'; port: number; revision: number; hasToken: boolean }
  | { kind: 'token'; token: string }

interface Binding {
  scope: Context
  port: number
  revision: number
  opened: Promise<DesktopSshLogin | undefined>
  writing?: Promise<boolean>
  writeFailed: boolean
}

function fixedPort(server: Context['webServer']): number | undefined {
  const { host, protocol, port, configuredPort } = server
  // HTTP clients can omit :80 from Host; the grant requires an explicit authority.
  if (host === '127.0.0.1' && protocol === 'http:' && configuredPort > 0 && configuredPort !== 80 && port === configuredPort) {
    return configuredPort
  }
}

/**
 * Read the stored grant only for an explicitly configured Desktop loopback listener.
 * @param ctx - Desktop Host context owning the listener and credential subscriptions.
 * @returns Private IPC control. Only `view` discloses the grant; failures return no credential or diagnostic detail.
 */
export function installDesktopSshLogin(ctx: Context): (request: DesktopSshLoginRequest) => Promise<LoginReply> {
  let current: Binding | undefined
  let revision = 0
  const isCurrent = (binding: Binding): boolean => current === binding && binding.scope.fiber.state === FiberState.ACTIVE
  ctx.inject(['webServer', 'credentials'], (scope) => {
    const port = fixedPort(scope.webServer)
    if (port === undefined) return
    scope.effect(() => {
      const opened = DesktopSshLogin.open(scope.credentials, port).then((login) => {
        if (current !== binding) return undefined
        scope.provide('desktopSshLogin', login.verifier)
        return login
      }).catch((_error: unknown) => undefined)
      const binding: Binding = { scope, port, revision: ++revision, opened, writeFailed: false }
      current = binding
      return async () => {
        if (current === binding) current = undefined
        await opened
        await binding.writing
      }
    }, 'desktop SSH login')
  })

  return async (request) => {
    const server = ctx.get('webServer')
    if (server === undefined) return { kind: 'unavailable' }
    const port = fixedPort(server)
    if (port === undefined) return { kind: 'unconfigured' }
    const binding = current
    if (binding === undefined || binding.port !== port || !isCurrent(binding)) return { kind: 'unavailable' }
    const login = await binding.opened
    if (!isCurrent(binding) || (request.action !== 'status' && request.revision !== binding.revision)) return { kind: 'changed' }
    if (login === undefined || binding.writing !== undefined || binding.writeFailed) return { kind: 'unavailable' }
    if (request.action === 'view') {
      const token = login.read()
      return token === undefined ? { kind: 'changed' } : { kind: 'token', token }
    }
    if (request.action === 'rotate') {
      binding.revision = ++revision
      const writing = login.rotate().then(() => true, (_error: unknown) => false)
      binding.writing = writing
      binding.writeFailed = !await writing
      delete binding.writing
      if (!isCurrent(binding)) return { kind: 'changed' }
      if (binding.writeFailed) return { kind: 'unavailable' }
    }
    return { kind: 'ready', port: binding.port, revision: binding.revision, hasToken: login.read() !== undefined }
  }
}
