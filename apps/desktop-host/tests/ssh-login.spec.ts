import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { installDesktopSshLogin } from '../src/ssh-login.ts'

type Store = Pick<Context['credentials'], 'readRecord' | 'modifyRecord'>
type RecordValue = Awaited<ReturnType<Store['readRecord']>>
const fixed = { host: '127.0.0.1', protocol: 'http:', port: 3080, configuredPort: 3080 } as const
const token = `ssh_${'a'.repeat(64)}`
const saved = { kind: 'grant', payload: { version: 1, port: 3080, token } } as const

function memoryStore(record?: RecordValue): Store {
  return {
    readRecord: vi.fn(async () => record),
    modifyRecord: vi.fn<Store['modifyRecord']>(async (_key, mutate) => { record = await mutate(record); return record }),
  }
}

it.each([
  { configuredPort: 0 }, { configuredPort: 3081 }, { port: undefined }, { port: 80, configuredPort: 80 },
  { host: '192.0.2.1' }, { protocol: 'https:' },
])('does not read or activate a token without an opted-in bound listener: %j', async (override) => {
  const ctx = new Context()
  const credentials = memoryStore(saved)
  const handle = installDesktopSshLogin(ctx)
  try {
    await ctx.plugin((scope) => {
      scope.provide('webServer', { ...fixed, ...override })
      scope.provide('credentials', credentials)
    })
    expect(await handle({ action: 'status' })).toEqual({ kind: 'unconfigured' })
    expect(credentials.readRecord).not.toHaveBeenCalled()
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
    expect(ctx.get('desktopSshLogin')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('activates one stored token without writing, and rejects an old dialog after credentials are replaced', async () => {
  const ctx = new Context()
  const credentials = memoryStore(saved)
  const handle = installDesktopSshLogin(ctx)
  try {
    await ctx.plugin((scope) => { scope.provide('webServer', fixed) })
    const first = await ctx.plugin((scope) => { scope.provide('credentials', credentials) })
    const status = await handle({ action: 'status' })
    if (status.kind !== 'ready') throw new Error('expected fixed-port status')
    expect(status).toEqual({ kind: 'ready', port: 3080, revision: 1, hasToken: true })
    expect(ctx.get('desktopSshLogin')?.matches(token)).toBe(true)
    expect(credentials.modifyRecord).not.toHaveBeenCalled()
    expect(await handle({ action: 'view', revision: status.revision })).toEqual({ kind: 'token', token })
    await first.dispose()
    expect(ctx.get('desktopSshLogin')).toBeUndefined()
    const replacement = memoryStore()
    await ctx.plugin((scope) => { scope.provide('credentials', replacement) })
    expect(await handle({ action: 'rotate', revision: status.revision })).toEqual({ kind: 'changed' })
    expect(replacement.modifyRecord).not.toHaveBeenCalled()
    expect(await handle({ action: 'status' })).toEqual({ kind: 'ready', port: 3080, revision: 2, hasToken: false })
  } finally { await ctx.fiber.dispose() }
})

it('drains an approved write before releasing its provider and suppresses its stale reply', async () => {
  const ctx = new Context()
  const began = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const credentials = memoryStore(saved)
  const commit = credentials.modifyRecord
  credentials.modifyRecord = async (key, mutate) => {
    began.resolve(undefined)
    await release.promise
    return commit(key, mutate)
  }
  const handle = installDesktopSshLogin(ctx)
  try {
    await ctx.plugin((scope) => { scope.provide('webServer', fixed) })
    const provider = await ctx.plugin((scope) => { scope.provide('credentials', credentials) })
    const status = await handle({ action: 'status' })
    if (status.kind !== 'ready') throw new Error('expected fixed-port status')
    const write = handle({ action: 'rotate', revision: status.revision })
    await began.promise
    let disposed = false
    const dispose = provider.dispose().then(() => { disposed = true })
    expect(ctx.get('desktopSshLogin')?.matches(token)).not.toBe(true)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    expect(await write).toEqual({ kind: 'changed' })
    await dispose
    expect(ctx.get('desktopSshLogin')).toBeUndefined()
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  }
})

it('disables a grant after unconfirmed persistence without reporting storage diagnostics', async () => {
  const ctx = new Context()
  const credentials = memoryStore(saved)
  credentials.modifyRecord = () => Promise.reject(new Error('synthetic credential diagnostics'))
  const handle = installDesktopSshLogin(ctx)
  try {
    await ctx.plugin((scope) => {
      scope.provide('webServer', fixed)
      scope.provide('credentials', credentials)
    })
    const status = await handle({ action: 'status' })
    if (status.kind !== 'ready') throw new Error('expected fixed-port status')
    expect(await handle({ action: 'rotate', revision: status.revision })).toEqual({ kind: 'unavailable' })
    expect(await handle({ action: 'status' })).toEqual({ kind: 'unavailable' })
    expect(ctx.get('desktopSshLogin')?.matches(token)).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
