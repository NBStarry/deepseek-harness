/** Request-local OAuth selection for native Codex SSE inference. */
import type { AssistantMessageEvent, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Host-only access to the selected grant; isCurrent reads committed selection synchronously. */
export interface CodexAccountDispatch {
  resolveSelected(): Promise<{ apiKey: string; isCurrent: () => boolean }>
}

/**
 * Drop account-bound replay metadata, never the local conversation or tool results.
 * @param request - immutable Harness request with projected local history.
 * @returns provider-neutral assistant history for any selected account.
 */
export function localCodexRequest(request: GenerateOptions): GenerateOptions {
  return { ...request, messages: request.messages.map(message => message.role === 'assistant'
    ? { ...message, source: { kind: message.source.kind, model: message.source.model, provider: message.source.provider } }
    : message) }
}

/**
 * Rebuild an unsent SDK request when the selection changes. Once fetch begins, its result is final.
 * @param accounts - selected grant resolver for this plugin instance.
 * @param options - request-owned headers, cancellation and model knobs.
 * @param stream - native SDK stream for the frozen model and local history.
 * @param send - actual HTTP transport; tests supply a request-local fake.
 * @returns events from the dispatched attempt, or the original failure.
 */
export async function* streamSelectedCodex(
  accounts: CodexAccountDispatch,
  options: SimpleStreamOptions,
  stream: (options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>,
  send: typeof globalThis.fetch = globalThis.fetch,
): AsyncIterable<AssistantMessageEvent> {
  for (;;) {
    options.signal?.throwIfAborted()
    const grant = await accounts.resolveSelected()
    let sent = false
    let stale = false
    const events = stream({ ...options, apiKey: grant.apiKey, transport: 'sse', cacheRetention: 'none', maxRetries: 0,
      fetch: (input, init) => {
        if (input !== 'https://chatgpt.com/backend-api/codex/responses') {
          throw new LlmError('Refusing to send Codex OAuth credentials to a non-native endpoint', 'INVALID_CONFIG')
        }
        const headers = new Headers(init?.headers)
        headers.delete('session-id')
        headers.delete('x-client-request-id')
        if (!grant.isCurrent()) {
          stale = true
          throw new Error('Codex account changed before dispatch')
        }
        sent = true
        return send(input, { ...init, headers, redirect: 'error' })
      },
    })
    // SDK setup failures and fetch refusals are terminal events. Only a stale, unsent attempt may be rebuilt.
    for await (const event of events) {
      if (!sent && event.type === 'error') stale ||= !grant.isCurrent()
      if (stale) break
      yield event
    }
    if (!stale) return
  }
}
