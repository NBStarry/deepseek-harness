/** Native DSH Go SSH login dialogs. Neither their state nor their text enters a renderer. */
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopHostProcess } from './host-process.ts'
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'

type ShowBox = (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>

/** One native menu flow, cancelled when its Desktop Host stops or the application quits. */
export class DesktopSshConnectionDialog {
  private active: AbortController | undefined

  /**
   * @param host - The current Desktop Host's private control, absent during startup or shutdown.
   * @param messages - Current Desktop shell dictionary.
   * @param copy - Native clipboard write, invoked only after an explicit Copy token action.
   */
  constructor(
    private readonly host: () => Pick<DesktopHostProcess, 'sshLogin'> | undefined,
    private readonly messages: () => DesktopMessages,
    private readonly copy: (token: string) => void,
  ) {}

  /**
   * Present the current listener and token controls. Repeated menu actions never stack dialogs.
   * @param show - Native message box attached to the owning window, so cancellation can dismiss it.
   * @returns Completion after the user dismisses the flow or the owning Host changes.
   */
  async show(show: ShowBox): Promise<void> {
    if (this.active !== undefined) return
    const controller = this.active = new AbortController()
    const { signal } = controller
    try {
      await this.run(options => show({ ...options, signal, noLink: true }), signal)
    } finally { this.active = undefined }
  }

  /** Dismiss any pending native alert and discard late Host replies. */
  cancel(): void { this.active?.abort() }

  private async run(show: ShowBox, signal: AbortSignal): Promise<void> {
    const host = this.host()
    const current = (): boolean => !signal.aborted && this.host() === host
    const t = this.messages()
    const title = t.sshConnectionTitle
    const close = { buttons: [t.sshClose], defaultId: 0, cancelId: 0 }
    const notice = async (message: string, type: 'info' | 'error'): Promise<void> => {
      if (current()) await show({ type, title, message, ...close })
    }
    const status = await host?.sshLogin({ action: 'status' }, signal)
    if (!current()) return
    if (status?.kind === 'unconfigured') return notice(t.sshUnconfigured, 'info')
    if (host === undefined || status?.kind !== 'ready') return notice(t.sshUnavailable, 'error')

    const { port, hasToken, revision } = status
    const portLabel = formatDesktopMessage(t.sshPort, { port: String(port) })
    const write = hasToken ? t.sshRotate : t.sshGenerate
    const buttons = hasToken ? [t.sshView, write, t.sshClose] : [write, t.sshClose]
    const dismiss = buttons.length - 1
    const { response } = await show({ type: 'info', title, message: portLabel, detail: t.sshInstructions,
      buttons, defaultId: dismiss, cancelId: dismiss })
    if (!current()) return

    const reveal = async (expected: number): Promise<void> => {
      const result = await host.sshLogin({ action: 'view', revision: expected }, signal)
      if (!current()) return
      if (result.kind !== 'token') return notice(t.sshUnavailable, 'error')
      const answer = await show({ type: 'info', title, message: portLabel, detail: `${result.token}\n\n${t.sshSecretNotice}`,
        buttons: [t.sshCopyToken, t.sshClose], defaultId: 1, cancelId: 1 })
      if (answer.response === 0 && current()) {
        try { this.copy(result.token) } catch (_error) { await notice(t.sshCopyFailed, 'error') }
      }
    }
    if (hasToken && response === 0) return reveal(revision)
    if (response !== (hasToken ? 1 : 0)) return
    const approved = await show({ type: hasToken ? 'warning' : 'info', title,
      message: hasToken ? t.sshRotatePrompt : t.sshGeneratePrompt, detail: t.sshCookieNotice,
      buttons: [write, t.cancel], defaultId: 1, cancelId: 1 })
    if (approved.response !== 0 || !current()) return

    const saved = await host.sshLogin({ action: 'rotate', revision }, signal)
    if (!current()) return
    if (saved.kind !== 'ready' || !saved.hasToken) return notice(t.sshWriteUnknown, 'error')
    const next = await show({ type: 'info', title, message: t.sshSaved, detail: portLabel,
      buttons: [t.sshView, t.sshClose], defaultId: 1, cancelId: 1 })
    if (next.response === 0 && current()) await reveal(saved.revision)
  }
}
