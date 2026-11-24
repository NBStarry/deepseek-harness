/** Private controls for the built Web test, never an HTTP route. */
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DesktopSshLogin } from '../../../../../../../packages/client/connection/lib/index.js'

export const inject = ['credentials', 'webServer', 'connection']

export async function apply(ctx) {
  const server = ctx.webServer
  if (!process.send || !process.env.DSH_HOME || await realpath(process.env.DSH_HOME) !== await realpath(join(process.cwd(), 'home'))
    || server.host !== '127.0.0.1' || server.configuredPort !== 0 || server.protocol !== 'http:') {
    throw new Error('Desktop SSH fixture requires the private Web test process')
  }
  const open = () => DesktopSshLogin.open(ctx.credentials, server.port)
  let login = await open()
  if (login.read() !== undefined || ctx.get('desktopSshLogin') !== undefined) throw new Error('Expected fresh Web profile')
  const receive = command => {
    if (command !== 'ssh-reopen' && command !== 'ssh-rotate') return
    void (async () => {
      if (command === 'ssh-rotate') await login.rotate()
      else {
        login = await open()
        ctx.provide('desktopSshLogin', login.verifier)
      }
    })().then(
      () => process.send({ command, acknowledged: true }),
      () => process.send({ command, error: 'SSH fixture operation failed' }),
    )
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => process.off('message', receive)
  })
}
