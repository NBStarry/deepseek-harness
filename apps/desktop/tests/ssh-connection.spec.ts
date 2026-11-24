import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { expect, it, vi } from 'vitest'
import type { DesktopHostProcess, DesktopSshLoginResult } from '../src/host-process.ts'
import { en, zh } from '../src/locale.ts'
import { DesktopSshConnectionDialog } from '../src/ssh-connection.ts'

const token = `ssh_${'a'.repeat(64)}`
const ready = { kind: 'ready', port: 3080, revision: 1, hasToken: false } as const
const answer = (response: number): MessageBoxReturnValue => ({ response, checkboxChecked: false })

function fixture(status: DesktopSshLoginResult) {
  const host = { sshLogin: vi.fn<DesktopHostProcess['sshLogin']>().mockResolvedValueOnce(status) }
  const copy = vi.fn<(value: string) => void>()
  const show = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
  const dialog = new DesktopSshConnectionDialog(() => host, () => zh, copy)
  return { host, copy, show, dialog }
}

it('explains fixed-port opt-in without offering generation on an unconfigured Desktop', async () => {
  const { show, dialog, copy, host } = fixture({ kind: 'unconfigured' })
  show.mockResolvedValueOnce(answer(0))
  await dialog.show(show)
  expect(show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: zh.sshUnconfigured, buttons: [zh.sshClose] }))
  expect(host.sshLogin.mock.calls.map(([request]) => request)).toEqual([{ action: 'status' }])
  expect(copy).not.toHaveBeenCalled()
})

it.each([false, true])('does not write when the token confirmation is cancelled (already configured: %s)', async (hasToken) => {
  const { show, dialog, copy, host } = fixture({ ...ready, hasToken })
  show.mockResolvedValueOnce(answer(hasToken ? 1 : 0)).mockResolvedValueOnce(answer(1))
  await dialog.show(show)
  expect(show).toHaveBeenCalledWith(expect.objectContaining({
    message: hasToken ? zh.sshRotatePrompt : zh.sshGeneratePrompt,
    detail: zh.sshCookieNotice, defaultId: 1, cancelId: 1,
  }))
  expect(host.sshLogin.mock.calls.map(([request]) => request)).toEqual([{ action: 'status' }])
  expect(copy).not.toHaveBeenCalled()
})

it('shows the port and a saved result without disclosing the token until View, and copies only explicitly', async () => {
  const { show, dialog, copy, host } = fixture(ready)
  host.sshLogin.mockResolvedValueOnce({ ...ready, revision: 2, hasToken: true }).mockResolvedValueOnce({ kind: 'token', token })
  for (let step = 0; step < 4; step++) show.mockResolvedValueOnce(answer(0))
  await dialog.show(show)
  expect(host.sshLogin.mock.calls.map(([request]) => request)).toEqual([
    { action: 'status' }, { action: 'rotate', revision: 1 }, { action: 'view', revision: 2 },
  ])
  expect(show).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'Web 端口：3080', detail: zh.sshInstructions }))
  expect(show).toHaveBeenNthCalledWith(3, expect.objectContaining({ message: zh.sshSaved }))
  expect(JSON.stringify(show.mock.calls.slice(0, 3))).not.toContain(token)
  expect(show).toHaveBeenNthCalledWith(4, expect.objectContaining({
    detail: `${token}\n\n${zh.sshSecretNotice}`, buttons: [zh.sshCopyToken, zh.sshClose], defaultId: 1, cancelId: 1,
  }))
  expect(copy).toHaveBeenCalledExactlyOnceWith(token)
})

it('reports an unconfirmed refresh without showing a token or retrying', async () => {
  const { show, dialog, host, copy } = fixture({ ...ready, hasToken: true })
  host.sshLogin.mockResolvedValueOnce({ kind: 'unavailable' })
  show.mockResolvedValueOnce(answer(1)).mockResolvedValueOnce(answer(0)).mockResolvedValueOnce(answer(0))
  await dialog.show(show)
  expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', message: zh.sshWriteUnknown }))
  expect(host.sshLogin.mock.calls.map(([request]) => request)).toEqual([{ action: 'status' }, { action: 'rotate', revision: 1 }])
  expect(copy).not.toHaveBeenCalled()
})

it('discards a late SSH reveal reply on shutdown and never starts a second dialog flow', async () => {
  const { show, dialog, copy, host } = fixture({ ...ready, hasToken: true })
  const started = Promise.withResolvers<undefined>()
  const reply = Promise.withResolvers<DesktopSshLoginResult>()
  host.sshLogin.mockImplementationOnce(() => { started.resolve(undefined); return reply.promise })
  show.mockResolvedValueOnce(answer(0))
  const pending = dialog.show(show)
  await started.promise
  await dialog.show(show)
  dialog.cancel()
  reply.resolve({ kind: 'token', token })
  await pending
  expect(show).toHaveBeenCalledOnce()
  expect(show.mock.calls[0]?.[0].signal?.aborted).toBe(true)
  expect(host.sshLogin).toHaveBeenCalledTimes(2)
  expect(copy).not.toHaveBeenCalled()
})

it('leaves the clipboard untouched when a revealed token is closed', async () => {
  const { show, dialog, copy, host } = fixture({ ...ready, hasToken: true })
  host.sshLogin.mockResolvedValueOnce({ kind: 'token', token })
  show.mockResolvedValueOnce(answer(0)).mockResolvedValueOnce(answer(1))
  await dialog.show(show)
  expect(show).toHaveBeenCalledTimes(2)
  expect(copy).not.toHaveBeenCalled()
  expect(en.sshUnconfigured).toContain('webserver.config.port')
})
