/** Desktop staging and ASAR publication preserve a complete signed application. */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopCuaHelperPath, prepareDesktopCua, readDesktopCuaApplication, verifyDesktopCua, verifyDesktopCuaUnpacked } from '../scripts/desktop-cua-native.mjs'
import { verifyMacOSRuntimeCode } from '../scripts/verify-macos-signature.mjs'
import { readCuaApplication } from '../../../scripts/cua-helper/payload.ts'

vi.mock('../scripts/verify-macos-signature.mjs', () => ({ verifyMacOSRuntimeCode: vi.fn() }))
const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cua-test-'))
  roots.push(root)
  return root
}
const sourceNative = resolve(import.meta.dirname, '../../../packages/experimental/cua-macos/native')
const identity = { signingIdentity: 'Example (TEAMID1234)', teamId: 'TEAMID1234' }
const run = vi.fn<(command: string, args: string[]) => void>()
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function publish(directory: string, content = 'helper'): string {
  const application = join(directory, 'temporary', 'DSH Computer Use.app')
  const entries = [
    ['Contents/Info.plist', 'plist'],
    ['Contents/MacOS/dsh-cua-native', content],
    ['Contents/Resources/DSHComputerUse.icns', 'icon'],
    ['Contents/_CodeSignature/CodeResources', 'signature'],
  ] as const
  const digest = createHash('sha256')
  for (const [path, bytes] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const file = join(application, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes, { mode: path.includes('/MacOS/') ? 0o755 : 0o644 })
    digest.update(`${path}\0`).update(createHash('sha256').update(bytes).digest())
      .update(Buffer.from([path.includes('/MacOS/') ? 1 : 0]))
  }
  const bundle = digest.digest('hex')
  renameSync(join(directory, 'temporary'), join(directory, bundle))
  writeFileSync(join(directory, 'current.json'), JSON.stringify({ bundle }))
  return join(directory, bundle, 'DSH Computer Use.app')
}

it.each(['arm64', 'x64'] as const)('preserves and verifies a distributed %s release application', (arch) => {
  const root = fixture()
  const directory = join(root, desktopCuaHelperPath(arch))
  const application = publish(directory)
  expect(readDesktopCuaApplication(directory)).toEqual(readCuaApplication(directory))
  prepareDesktopCua(root, { platform: 'darwin', arch }, sourceNative, identity, run)
  expect(verifyMacOSRuntimeCode).toHaveBeenCalledWith(application, identity)
  expect(run).toHaveBeenCalledWith('/usr/bin/lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', join(application, 'Contents/MacOS/dsh-cua-native')])
  expect(run).toHaveBeenCalledWith('/usr/bin/xcrun', ['stapler', 'validate', application])
  expect(run).not.toHaveBeenCalledWith('/usr/bin/xcrun', expect.arrayContaining(['python3']))
  const resources = join(root, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked/dsh', desktopCuaHelperPath(arch))
  mkdirSync(dirname(unpacked), { recursive: true })
  cpSync(directory, unpacked, { recursive: true })
  verifyDesktopCuaUnpacked(root, resources, arch, identity, run)
  writeFileSync(join(unpacked, readDesktopCuaApplication(unpacked).bundle, 'DSH Computer Use.app/Contents/Info.plist'), 'changed')
  expect(() => { verifyDesktopCuaUnpacked(root, resources, arch, identity, run) }).toThrow('digest')
})

it('requires every staged architecture to survive unpacking', () => {
  const root = fixture()
  const resources = join(root, 'resources')
  for (const arch of ['arm64', 'x64'] as const) publish(join(root, desktopCuaHelperPath(arch)), arch)
  const relative = desktopCuaHelperPath('arm64')
  const unpacked = join(resources, 'app.asar.unpacked/dsh', relative)
  mkdirSync(dirname(unpacked), { recursive: true })
  cpSync(join(root, relative), unpacked, { recursive: true })
  expect(() => { verifyDesktopCuaUnpacked(root, resources, 'arm64', identity, run) }).toThrow('ENOENT')
  const intel = desktopCuaHelperPath('x64')
  cpSync(join(root, intel), join(resources, 'app.asar.unpacked/dsh', intel), { recursive: true })
  expect(() => { verifyDesktopCuaUnpacked(root, resources, 'arm64', identity, run) }).not.toThrow()
})

it('skips an absent optional provider without creating helper output', () => {
  const root = fixture()
  const resources = join(root, 'resources')
  const directory = join(root, desktopCuaHelperPath('arm64'))
  for (const expected of [undefined, identity]) {
    prepareDesktopCua(root, { platform: 'darwin', arch: 'arm64' }, sourceNative, expected, run)
    verifyDesktopCuaUnpacked(root, resources, 'arm64', expected, run)
  }
  expect(existsSync(directory)).toBe(false)
  expect(run).not.toHaveBeenCalled()
  publish(join(resources, 'app.asar.unpacked/dsh', desktopCuaHelperPath('x64')))
  expect(() => { verifyDesktopCuaUnpacked(root, resources, 'arm64', undefined, run) }).toThrow('unexpected unpacked helper')
})

it('builds an ad-hoc helper only when an unsigned provider lacks a payload', () => {
  const root = fixture()
  const directory = join(root, desktopCuaHelperPath('arm64'))
  mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh-experimental-cua-macos'), { recursive: true })
  expect(() => { prepareDesktopCua(root, { platform: 'darwin', arch: 'arm64' }, sourceNative, identity, run) }).toThrow('requires a distributed release helper')
  expect(run).not.toHaveBeenCalled()
  expect(() => { verifyDesktopCuaUnpacked(root, root, 'arm64', identity, run) }).toThrow('ENOENT')
  run.mockImplementation((command, args) => { if (command.endsWith('/xcrun') && args[0] === 'python3') publish(args[args.indexOf('--output-directory') + 1]!) })
  prepareDesktopCua(root, { platform: 'darwin', arch: 'arm64' }, sourceNative, undefined, run)
  expect(run).toHaveBeenCalledWith('/usr/bin/xcrun', [
    'python3', join(sourceNative, 'build_app.py'), '--scratch-path', expect.any(String),
    '--output-directory', directory, '--arch', 'arm64',
  ])
  expect(readDesktopCuaApplication(directory).application).toContain('DSH Computer Use.app')
  expect(run).toHaveBeenCalledWith('/usr/bin/codesign', expect.arrayContaining(['--strict']))
})

it('rejects corrupt receipts, missing resources, non-executable helpers and extra generations', () => {
  const root = fixture()
  const directory = join(root, desktopCuaHelperPath('arm64'))
  const app = publish(directory)
  const executable = join(app, 'Contents/MacOS/dsh-cua-native')
  chmodSync(executable, 0o644)
  expect(() => readDesktopCuaApplication(directory)).toThrow('not executable')
  chmodSync(executable, 0o755)
  writeFileSync(join(app, 'Contents/Info.plist'), 'modified')
  expect(() => readDesktopCuaApplication(directory)).toThrow('digest')
  writeFileSync(join(app, 'Contents/Info.plist'), 'plist')
  mkdirSync(join(directory, 'extra'))
  expect(() => readDesktopCuaApplication(directory)).toThrow('unselected')
  rmSync(join(directory, 'extra'), { recursive: true })
  rmSync(join(app, 'Contents/Resources/DSHComputerUse.icns'))
  expect(() => readDesktopCuaApplication(directory)).toThrow('omits')
  writeFileSync(join(directory, 'current.json'), '{"bundle":"../outside"}')
  expect(() => readDesktopCuaApplication(directory)).toThrow('invalid receipt')
})

it('fails closed on architecture, signing, and unpacking errors', () => {
  const root = fixture()
  const directory = join(root, desktopCuaHelperPath('arm64'))
  publish(directory)
  run.mockImplementation(() => { throw new Error('architecture mismatch') })
  expect(() => verifyDesktopCua(directory, 'arm64', identity, run)).toThrow('architecture mismatch')
  run.mockReset()
  vi.mocked(verifyMacOSRuntimeCode).mockImplementation(() => { throw new Error('bad signature') })
  expect(() => { prepareDesktopCua(root, { platform: 'darwin', arch: 'arm64' }, sourceNative, identity, run) }).toThrow('bad signature')
  vi.mocked(verifyMacOSRuntimeCode).mockReset()
  expect(() => { verifyDesktopCuaUnpacked(root, root, 'arm64', identity, run) }).toThrow('ENOENT')
  expect(() => desktopCuaHelperPath('ia32' as 'arm64')).toThrow('unsupported')
  prepareDesktopCua(root, { platform: 'win32', arch: 'x64' }, sourceNative, undefined, run)
})
