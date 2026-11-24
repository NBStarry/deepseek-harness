/** Desktop interactive-input admission for computer use. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NativeError } from './native-client.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'

/** Context producers observed as harmless, non-task input; every other source fails closed. */
const HARMLESS_CONTEXT = new Set([
  'runtime-context', 'agent-instructions', 'time-context', 'skill-catalog', 'session-reference',
  'tmux-context', 'tool-registry', 'skill-invocation', 'compaction-basic', 'compact-checkpoint',
])

/** Admitted-input view available only on the reserved Desktop host. */
export interface InteractiveAdmission {
  /** Whether the preparing step may offer the tool. */
  visible(agent: Agent): boolean
  /** Hard check at the tool entry; arguments never participate. */
  require(execution: Readonly<Pick<ToolExecution, 'agent' | 'toolSet'>>, tool: ToolDefinition): void
  /** Release every subscription and drop the per-Agent notice queues. */
  dispose(): void
}

/** One open turn's admitted browser notices and accepted prompts. */
interface TurnRecord {
  readonly turn: number
  readonly browser: Set<MessageId>
  readonly accepted: Set<MessageId>
  denied: boolean
}

/** One structured rejection for unattended desktop control. */
function reject(message: string): never {
  throw new NativeError('CUA_INTERACTIVE_INPUT_REQUIRED', message)
}

/** The live root Agent's open turn start, or undefined outside one. */
function openTurn(ctx: Context, agent: Agent): number | undefined {
  if (agent.session.header.origin === 'subagent') return undefined
  if (ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) return undefined
  const boundary = ctx.agents.turnBoundaryOf(agent.session)
  return boundary.openTurnStartSeq === null ? undefined : boundary.openTurnStartSeq
}

/** Apply one committed event to the Agent's open-turn record. */
function observe(
  ctx: Context,
  turns: WeakMap<Agent, TurnRecord>,
  pending: WeakMap<Agent, Set<MessageId>>,
  session: Session,
  event: SessionEvent,
): void {
  const agent = ctx.agents.get(session.id)
  if (agent === undefined || agent.session !== session) return
  if (event.type === 'turn/start') {
    turns.set(agent, { turn: event.data.turn, browser: new Set(), accepted: new Set(), denied: false })
    return
  }
  if (event.type === 'turn/end') {
    turns.delete(agent)
    return
  }
  if (event.type !== 'user/message') return
  const record = turns.get(agent)
  // A turn opened before this subscription stays unknown: drop its stale notice and return.
  if (record === undefined) {
    pending.get(agent)?.delete(event.data.id)
    return
  }
  const kind = event.data.source.kind
  if (HARMLESS_CONTEXT.has(kind)) return
  if (kind !== 'user' || !record.browser.has(event.data.id)) {
    record.denied = true
    return
  }
  record.accepted.add(event.data.id)
}

/**
 * Build the Desktop admission policy, or `undefined` on every other host.
 * The Session Controller emits `api-session/browser-prompt` inside the verified
 * browser submission's committed insertion, before its first claim.
 * @param ctx - Host context with the launcher profile, Agent registry, and controller events.
 * @returns the policy, or undefined outside the packaged Desktop application.
 */
export function desktopInteractiveAdmission(ctx: Context): InteractiveAdmission | undefined {
  if (ctx.get('profileContext')?.name !== 'desktop') return undefined
  const pending = new WeakMap<Agent, Set<MessageId>>()
  const turns = new WeakMap<Agent, TurnRecord>()
  const stopPrompt = ctx.on('api-session/browser-prompt', (agent, messageId) => {
    const queue = pending.get(agent)
    if (queue === undefined) pending.set(agent, new Set([messageId]))
    else queue.add(messageId)
  })
  const stopClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = turns.get(agent)
    if (record === undefined || record.turn !== turn) {
      pending.get(agent)?.delete(message.id)
      return
    }
    const notified = pending.get(agent)?.delete(message.id) === true
    if (notified) record.browser.add(message.id)
    else if (!HARMLESS_CONTEXT.has(message.source.kind)) record.denied = true
  })
  const stopDiscarded = ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    pending.get(agent)?.delete(message.id)
  })
  const stopSession = ctx.on('session/event', (session, event) => { observe(ctx, turns, pending, session, event) })
  const admit = (agent: Agent, requireAccepted: boolean): boolean => {
    if (openTurn(ctx, agent) === undefined) return false
    const record = turns.get(agent)
    if (record === undefined || record.turn !== ctx.agents.turnBoundaryOf(agent.session).lastTurn) return false
    if (record.denied || record.browser.size === 0) return false
    return !requireAccepted || record.accepted.size > 0
  }
  return {
    visible(agent) { return admit(agent, false) },
    require(execution, tool) {
      const agent = execution.agent
      if (agent === undefined) reject('computer use requires an agent-owned execution')
      if (agent.session.header.origin === 'subagent') reject('delegated sessions cannot drive the desktop')
      if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
        || ctx.agents.currentInitiator() !== agent || !ctx.agents.roots().includes(agent)) {
        reject('computer use requires the live calling agent inside its active driver')
      }
      const toolSet: ResolvedToolSet | undefined = execution.toolSet
      if (toolSet === undefined || toolSet.view(agent).get(tool.name) !== tool) {
        reject('computer use requires the admitting tool set of this step')
      }
      if (!admit(agent, true)) reject('computer use requires a verified browser prompt accepted in this turn')
    },
    dispose() {
      stopPrompt()
      stopClaimed()
      stopDiscarded()
      stopSession()
    },
  }
}
