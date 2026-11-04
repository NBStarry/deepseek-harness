import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../scripts/snapshot-workspace-parent.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

describe.skipIf(webSnapshotMode() === 'record')('hybrid replay', () => {
  let scaffold: WebScaffold
  let handle: Awaited<ReturnType<WebScaffold['ctx']['agents']['create']>>
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
  let tempDir: string | undefined
  const patch = '*** Begin Patch\n*** Add File: direct.txt\n+direct\n*** End Patch'
  const nested = '*** Begin Patch\n*** Add File: nested.txt\n+nested\n*** End Patch'
  const toolChunk = (id: string, name: string, args: unknown, index: number) => {
    const call = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
    return [ { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: call.arguments },
      { type: 'block-end', index, block: call } ]
  }
  beforeAll(async () => {
    const entries = [
      { kind: 'chunks', chunks: [
        ...toolChunk('patch-direct', 'apply_patch', { input: patch }, 0),
        ...toolChunk('code-nested', 'run_code', { description:'Apply nested patch',code: `return await tools.apply_patch({input: ${JSON.stringify(nested)}})` }, 1),
        { type:'finish', reason:'tool_use' } ] },
      { kind:'chunks',chunks:[{ type:'block-start',index:0,blockType:'text' },
        { type:'text-delta',index:0,text:'HYBRID_DONE' },
        { type:'block-end',index:0,block:{ type:'text',text:'HYBRID_DONE' } },
        { type:'finish',reason:'stop' }] },
    ]
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-hybrid-replay-'))
    const overridePath = join(tempDir, 'replay.json')
    await writeFile(overridePath, JSON.stringify(entries))
    scaffold = await launchWebScaffold({ ...process.env.DSH_HYBRID_TEST_OVERLAY === undefined ? {} : { extraOverlayPath: process.env.DSH_HYBRID_TEST_OVERLAY }, replayFixture: join(repoRoot,'snapshots/web/auto-review-denial/session.v3.jsonl'),replayOverride: overridePath, compareReplaySession: false })
    handle = await scaffold.ctx.agents.create({ sessionId:SessionId('hybrid-built-smoke'),
      meta:{ cwd:scaffold.workspaceCwd,agentPreset:'standard' },
      agentOptions:{ provider:'deepseek-official',model:'deepseek-v4-flash' },
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx,'standard') } })
    handle.agent.followup(createUserMessage({ content:[{ type:'text',text:'Apply the test patches.' }],source:{ kind:'user' } }))
    await handle.agent.whenIdle()
  }, 120000)
  afterAll(async () => {
    try { await handle?.dispose(); await scaffold?.close() } finally {
      if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
    }
  }, 120000)
  it('exposes all three tools in a model request and executes both routes', async () => {
    const events=handle.agent.session.snapshotEvents()
    const header=events.find(event=>event.type==='request/header' && event.data.header.tools?.length)
    expect(header?.type).toBe('request/header')
    if (!header || header.type !== 'request/header') throw new Error('missing model request')
    const names=header.data.header.tools?.map(tool=>tool.name) ?? []
    expect(names).toEqual(expect.arrayContaining(['edit','apply_patch','run_code']))
    const results=events.filter(event=>event.type==='tool/result')
    expect(results).toHaveLength(2)
    expect(results.every(event=>event.type==='tool/result' && !event.data.message.isError)).toBe(true)
    const directResult=results.find(event=>event.type==='tool/result' && event.data.message.toolCallId==='patch-direct')
    expect(directResult?.type).toBe('tool/result')
    if (directResult?.type !== 'tool/result') throw new Error('missing direct result')
    expect(directResult.data.meta).toMatchObject({ stopped: false })
    const nestedResult=results.find(event=>event.type==='tool/result' && event.data.message.toolCallId==='code-nested')
    const nestedText=nestedResult?.type === 'tool/result' ? nestedResult.data.message.content.find(block=>block.type==='text') : undefined
    if (nestedText?.type !== 'text') throw new Error('missing nested output')
    const nestedValue = JSON.parse(nestedText.text) as { phase: string; operations: { status: string }[] }
    expect(nestedValue.phase).toBe('commit')
    expect(nestedValue.operations.map((operation: { status: string })=>operation.status)).toEqual(['completed'])
    expect(await readFile(join(scaffold.workspaceCwd,'direct.txt'),'utf8')).toBe('direct\n')
    expect(await readFile(join(scaffold.workspaceCwd,'nested.txt'),'utf8')).toBe('nested\n')
    expect(events.some(event=>event.type==='tool/ptc-dispatch' && event.data.name==='apply_patch' && !event.data.isError)).toBe(true)
  }, 120000)

  it('confines direct Node writes in both standing sandbox modes', async () => {
    const agent = handle.agent
    const directWrite = async (id: string, target: string) => {
      const code = `try { await (await import('node:fs/promises')).writeFile(${JSON.stringify(target)}, 'ok'); return 'written' } catch (error) { return 'denied:' + error.code }`
      const batch = await scaffold.ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
        type: 'tool-call', id: ToolCallId(id), name: 'run_code', arguments: JSON.stringify({ description: 'Check sandbox file policy', code }),
      }] })
      expect(batch.results[0]?.result.isError).toBe(false)
      return batch.results[0]?.result.value
    }
    const allowed = join(scaffold.workspaceCwd, 'program-write.txt')
    const outsideDir = await mkdtemp(join(outsideTempWorkspaceParent(), 'dsh-hybrid-outside-'))
    try {
      assertWorkspaceOutsideTemp(outsideDir)
      const outside = join(outsideDir, 'sandbox-outside-probe-' + randomUUID() + '.txt')
      setSandboxMode(agent.session, 'workspace-write')
      expect(await directWrite('allowed-write', allowed)).toMatchObject({ result: 'written' })
      expect(await readFile(allowed, 'utf8')).toBe('ok')
      const outsideResult = await directWrite('outside-write', outside)
      expect(JSON.stringify(outsideResult)).toMatch(/"result":"denied:(EACCES|EPERM|EROFS)"/)
      await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      setSandboxMode(agent.session, 'read-only')
      const denied = join(scaffold.workspaceCwd, 'program-denied.txt')
      const deniedResult = await directWrite('readonly-write', denied)
      expect(JSON.stringify(deniedResult)).toMatch(/"result":"denied:(EACCES|EPERM|EROFS)"/)
      await expect(readFile(denied, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  }, 120000)
})
