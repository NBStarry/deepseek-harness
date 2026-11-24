/** Built Web login over the OS-assigned loopback port, with a private Desktop opt-in. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREDENTIALS_FILENAME, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { expect, it } from 'vitest'
import { webGet, withDefaultWeb } from './default-web-process.ts'

const patch = fileURLToPath(new URL('./fixtures/desktop-ssh.patch.yml', import.meta.url))

/** Independently read the committed grant from the test home, not the Host's in-memory provider. */
async function savedToken(root: string): Promise<string> {
  const file = join(root, 'home', CREDENTIALS_FILENAME)
  const { records } = parseCredentialsDocument(await readFile(file, 'utf8'), file)
  const grant = records.get('client-connection/desktop-ssh-login')
  const payload = grant?.kind === 'grant' ? grant.payload : undefined
  if (!payload || typeof payload !== 'object' || !('token' in payload) || typeof payload.token !== 'string') {
    throw new Error('Test home has no committed Desktop SSH token')
  }
  return payload.token
}

it('accepts the reopened SSH grant and rotates fresh logins without revoking browser cookies', async (test) => {
  await withDefaultWeb(test, async ({ root, url, acknowledge }) => {
    const index = new URL('/', url)
    const exchange = async (entry: string | URL) => {
      const response = await webGet(entry, test.signal)
      expect(response.status).toBe(303)
      expect(response.headers.location === './').toBe(true)
      const cookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0]
      if (!cookie) throw new Error('Login did not issue a browser cookie')
      return cookie
    }
    const browser = await exchange(url)
    expect((await webGet(index, test.signal)).status).toBe(401)

    await acknowledge('ssh-rotate')
    const first = new URL(index)
    first.searchParams.set('token', await savedToken(root))
    expect((await webGet(first, test.signal)).status).toBe(401)
    await acknowledge('ssh-reopen')
    const attached = await exchange(first)
    await acknowledge('ssh-rotate')
    const second = new URL(index)
    second.searchParams.set('token', await savedToken(root))
    const refused = await webGet(first, test.signal)
    expect(refused.status).toBe(401)
    expect(refused.headers['set-cookie'] === undefined).toBe(true)
    const rotated = await exchange(second)
    for (const cookie of [browser, attached, rotated]) {
      expect((await webGet(index, test.signal, { cookie })).status).toBe(200)
    }
  }, { patches: [patch], privateOutput: true })
})
