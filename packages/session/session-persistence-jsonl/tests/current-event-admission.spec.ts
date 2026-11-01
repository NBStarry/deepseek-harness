import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath, scanLog, SessionLogScanner } from '../src/format.ts'

const id = SessionId('current-admission')
const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 }
const start = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
const prefix = [header, start].map(row => JSON.stringify(row)).join('\n') + '\n'
const obsoleteTypes = ['tool/code-dispatch-start', 'tool/code-dispatch'] as const

function obsoleteEvent(type: string, ignorable?: true) {
  return {
    type, seq: 1, time: 2,
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: {} },
    ...(ignorable ? { ignorable } : {}),
  }
}

describe('current event admission at EOF', () => {
  let root: string
  let ctx: Context

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-current-admission-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  })

  async function store(bytes: Buffer): Promise<string> {
    const path = generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return path
  }

  it.each(['strict', 'recoverable'] as const)('preserves priority on/off across committed turns and resume in %s scans', async (recovery) => {
    const route = { provider: 'openai-codex', model: 'gpt-5.4' }
    const priority = { ...route, serviceTier: 'priority' }
    const events = [
      { type: 'model/selection', data: priority },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'request/header', data: { header: { config: priority }, reason: 'initial' } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', data: {} },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { turn: 2, step: 1 } },
      { type: 'request/header', data: { header: { config: priority }, reason: 'resume' } },
      { type: 'step/end', data: { turn: 2, step: 1 } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'model/selection', data: route },
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'step/start', data: { turn: 3, step: 1 } },
      { type: 'request/header', data: { header: { config: route }, reason: 'change' } },
      { type: 'step/end', data: { turn: 3, step: 1 } },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
    const headerBytes = Buffer.from(JSON.stringify(header) + '\n')
    const eventBytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    const bytes = Buffer.concat([headerBytes, eventBytes])
    const scanner = new SessionLogScanner(headerBytes, recovery)
    scanner.write(eventBytes)
    const scanned = scanner.finish()
    expect(scanned.events).toEqual(events)
    expect(scanned.committedBytes).toBe(bytes.length)
    const restored = Session.fromRestore(id, scanned.events, scanned.meta, scanned.inheritedEventCount, 'detached')
    for (const event of events) expect(restored.eventAt(SessionSeq(event.seq))).toEqual(event)
    expect(restored.eventAt(SessionSeq(0))?.data).toHaveProperty('serviceTier', 'priority')
    expect(restored.eventAt(SessionSeq(12))?.data).not.toHaveProperty('serviceTier')

    const path = await store(bytes)
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      const stored = await handle.read()
      expect(stored.events).toEqual(events)
      const resumed = Session.fromRestore(id, stored.events, handle.header, handle.inheritedEventCount, stored.eventState)
      expect(resumed.eventAt(SessionSeq(9))).toEqual(events[9])
      expect(resumed.eventAt(SessionSeq(15))).toEqual(events[15])
    } finally {
      await handle.close()
    }
    expect(await readFile(path)).toEqual(bytes)
  })

  it.each([{ surfaceOp: 'append' }, { sourceEventSeqs: [] }])('refuses unknown required metadata %j without truncating a provider append', async (metadata) => {
    const event = { type: 'future/required', seq: 0, time: 1, data: {}, ...metadata }
    const bytes = Buffer.from([header, event].map(row => JSON.stringify(row)).join('\n') + '\n')
    expect(scanLog(bytes)).toMatchObject({ events: [event], committedBytes: bytes.length })
    const path = await store(bytes)
    const sourceStat = await stat(path)
    for (const access of ['read', 'write'] as const) {
      const operation = async () => {
        const handle = await ctx.sessionPersistence.open(id, access)
        try {
          if (access === 'read') await handle.read()
          else await handle.append([{ type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } }])
        } finally {
          await handle.close()
        }
      }
      await expect(operation()).rejects.toThrow('unknown to this harness and not marked ignorable')
      expect(await readFile(path)).toEqual(bytes)
      expect(await stat(path)).toMatchObject({ dev: sourceStat.dev, ino: sourceStat.ino })
    }
  })

  it.each(obsoleteTypes)('retains ignorable %s through scanning and a provider append', async (type) => {
    const event = obsoleteEvent(type, true)
    const bytes = Buffer.from(prefix + JSON.stringify(event) + '\n')
    expect(scanLog(bytes)).toMatchObject({ events: [start, event], committedBytes: bytes.length })
    const path = await store(bytes)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual([start, event])
      await writer.append([{
        type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } },
      }])
    } finally {
      await writer.close()
    }
    expect((await readFile(path)).subarray(0, bytes.length)).toEqual(bytes)
  })

})
