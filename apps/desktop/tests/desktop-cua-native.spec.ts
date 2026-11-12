/** Pure fixture coverage for opt-in CUA payload verification. */
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { readDesktopCuaApplication, resolveDesktopCua, verifyDesktopCuaPackage, verifyDesktopCuaUnpacked } from '../scripts/desktop-cua-native.mjs'

vi.mock('/apps/desktop/lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime: async () => undefined }))

const names = ['@deepseek-ai/dsh-experimental-cua-macos', '@deepseek-ai/dsh-cua', '@deepseek-ai/dsh-computer-use', '@deepseek-ai/dsh-cua-bundle']
const provider = `node_modules/${names[0]}`
const helper = `${provider}/native/bin/darwin-arm64`
const app = 'DSH Computer Use.app'
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const asar = builderRequire('@electron/asar') as { createPackage: (source: string, archive: string) => Promise<void> }

function makeHelper(directory: string, contents = 'helper'): string {
  const files = new Map([
    ['Contents/Info.plist', 'plist'],
    ['Contents/MacOS/dsh-cua-native', contents],
    ['Contents/Resources/DSHComputerUse.icns', 'icon'],
    ['Contents/_CodeSignature/CodeResources', 'signature'],
  ])
  const digest = createHash('sha256')
  for (const [path, body] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    digest.update(`${path}\0`).update(createHash('sha256').update(body).digest())
      .update(Buffer.from([path.includes('/MacOS/') ? 1 : 0]))
  }
  const bundle = digest.digest('hex')
  for (const [path, body] of files) {
    const file = join(directory, bundle, app, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body, { mode: path.includes('/MacOS/') ? 0o755 : 0o644 })
  }
  writeFileSync(join(directory, 'current.json'), JSON.stringify({ bundle }))
  return bundle
}

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'desktop-cua-fixture-'))
  const root = join(base, 'staged')
  const resources = join(base, 'resources')
  const source = join(base, 'archive-source')
  try {
    for (const name of names) {
      const directory = join(root, 'node_modules', name)
      mkdirSync(directory, { recursive: true })
      const dependencies = name === names[0] ? { [names[1]!]: '1.0.0' }
        : name === names[1] ? { [names[2]!]: '1.0.0' }
          : name === names[3] ? { [names[1]!]: '1.0.0', [names[2]!]: '1.0.0' } : {}
      const manifest = {
        name, version: '1.0.0', dependencies,
        ...(name === names[0] ? { peerDependencies: { [names[2]!]: '1.0.0' } } : {}),
        ...(name === names[3] ? {
          optionalDependencies: { [names[0]!]: '1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
        } : {}),
      }
      writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) }))
    writeFileSync(join(root, 'node_modules', names[3]!, 'cordis.patch.yml'), readFileSync(new URL('../../../packages/experimental/cua-bundle/cordis.patch.yml', import.meta.url)))
    mkdirSync(join(root, helper), { recursive: true })
    const bundle = makeHelper(join(root, helper))
    mkdirSync(source, { recursive: true })
    mkdirSync(resources, { recursive: true })
    cpSync(root, join(source, 'dsh'), { recursive: true })
    rmSync(join(source, 'dsh', provider, 'native'), { recursive: true })
    await asar.createPackage(source, join(resources, 'app.asar'))
    cpSync(join(root, helper), join(resources, 'app.asar.unpacked', 'dsh', helper), { recursive: true })
    return { base, root, resources, source, bundle }
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    throw error
  }
}

it('requires an explicit supported unsigned opt-in and leaves defaults unchanged', () => {
  const target = { platform: 'darwin', arch: 'arm64', unsigned: true }
  expect(resolveDesktopCua({}, target)).toBe(false)
  expect(resolveDesktopCua({ DSH_DESKTOP_INCLUDE_CUA: '1' }, target)).toBe(true)
  for (const value of ['', '0', 'true', '2']) expect(() => resolveDesktopCua({ DSH_DESKTOP_INCLUDE_CUA: value }, target)).toThrow(/must be 1/u)
  for (const change of [{ platform: 'win32' }, { arch: 'x64' }, { unsigned: false }]) {
    expect(() => resolveDesktopCua({ DSH_DESKTOP_INCLUDE_CUA: '1' }, { ...target, ...change })).toThrow(/unsigned mac-arm64/u)
  }
  const normal = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.fixture', DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  const enabled = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.fixture', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_INCLUDE_CUA: '1' }, 'darwin', 'arm64')
  expect(normal.asarUnpack.some(pattern => pattern.includes('dsh-experimental-cua-macos'))).toBe(false)
  expect(enabled.asarUnpack.some(pattern => pattern.includes('dsh-experimental-cua-macos'))).toBe(true)
  expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.fixture', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_INCLUDE_CUA: '1', npm_config_arch: 'x64' }, 'darwin', 'arm64')).toThrow(/unsigned mac-arm64/u)
})

it('reads the actual ASAR and checks both helper copies with lipo and codesign', async () => {
  const input = await fixture()
  try {
    const commands: string[] = []
    await verifyDesktopCuaPackage(input.root, input.resources, (command, args) => { commands.push(`${command} ${args.join(' ')}`) })
    expect(commands).toHaveLength(4)
    expect(commands.filter(value => value.includes('lipo') && value.endsWith('-verify_arch arm64'))).toHaveLength(2)
    expect(commands.filter(value => value.includes('codesign --verify --strict'))).toHaveLength(2)
    expect(readDesktopCuaApplication(join(input.root, helper)).bundle).toBe(input.bundle)
  } finally { rmSync(input.base, { recursive: true, force: true }) }
})

it('rejects missing and altered ASAR manifests, dependency fields and bundle patches', async () => {
  for (const change of ['missing-provider', 'manifest-version', 'dependencies', 'runtime-dependency', 'missing-patch', 'altered-patch']) {
    const input = await fixture()
    try {
      const manifest = join(input.source, 'dsh/node_modules', names[change === 'missing-provider' ? 0 : 3]!, 'package.json')
      const patch = join(input.source, 'dsh/node_modules', names[3]!, 'cordis.patch.yml')
      if (change === 'missing-provider') rmSync(manifest)
      if (change === 'manifest-version') writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '2.0.0' }))
      if (change === 'dependencies') writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), dependencies: {} }))
      if (change === 'runtime-dependency') {
        const runtime = join(input.source, 'dsh/package.json')
        const value = JSON.parse(readFileSync(runtime, 'utf8')) as { dependencies: Record<string, string> }
        delete value.dependencies['@deepseek-ai/dsh-experimental-cua-macos']
        writeFileSync(runtime, JSON.stringify(value))
      }
      if (change === 'missing-patch') rmSync(patch)
      if (change === 'altered-patch') writeFileSync(patch, '- insert: [unexpected]\n')
      await asar.createPackage(input.source, join(input.resources, 'app.asar'))
      await expect(verifyDesktopCuaPackage(input.root, input.resources, () => {})).rejects.toThrow(change === 'runtime-dependency' ? /packaged runtime manifest differs from staged/u : /./u)
    } finally { rmSync(input.base, { recursive: true, force: true }) }
  }
})

it('rejects broken receipts, content, execution bits, links, extra generation content and platform failures', async () => {
  for (const change of ['receipt', 'receipt-bytes', 'content', 'executable', 'link', 'generation', 'architecture', 'signature']) {
    const input = await fixture()
    try {
      const directory = join(input.resources, 'app.asar.unpacked', 'dsh', helper)
      const executable = join(directory, input.bundle, app, 'Contents/MacOS/dsh-cua-native')
      if (change === 'receipt') writeFileSync(join(directory, 'current.json'), JSON.stringify({ bundle: '../escape' }))
      if (change === 'receipt-bytes') writeFileSync(join(directory, 'current.json'), `${JSON.stringify({ bundle: input.bundle })}\n`)
      if (change === 'content') writeFileSync(executable, 'modified')
      if (change === 'executable') chmodSync(executable, 0o644)
      if (change === 'link') { rmSync(executable); symlinkSync('/tmp/unsafe', executable) }
      if (change === 'generation') mkdirSync(join(directory, input.bundle, 'extra'))
      const run = (command: string) => {
        if ((change === 'architecture' && command.endsWith('lipo')) || (change === 'signature' && command.endsWith('codesign'))) throw new Error(change)
      }
      expect(() => { verifyDesktopCuaUnpacked(input.root, input.resources, run) }).toThrow()
    } finally { rmSync(input.base, { recursive: true, force: true }) }
  }
})

it('rejects a valid but different unpacked helper generation', async () => {
  const input = await fixture()
  try {
    const unpacked = join(input.resources, 'app.asar.unpacked', 'dsh', helper)
    rmSync(unpacked, { recursive: true })
    mkdirSync(unpacked, { recursive: true })
    makeHelper(unpacked, 'different helper')
    expect(() => { verifyDesktopCuaUnpacked(input.root, input.resources, () => {}) }).toThrow(/differs from staged/u)
  } finally { rmSync(input.base, { recursive: true, force: true }) }
})

it('rejects incomplete staged dependency edges even when ASAR matches', async () => {
  for (const index of [0, 1, 3]) {
    const input = await fixture()
    try {
      const staged = join(input.root, 'node_modules', names[index]!, 'package.json')
      const archived = join(input.source, 'dsh/node_modules', names[index]!, 'package.json')
      const manifest = JSON.parse(readFileSync(staged, 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies = {}
      writeFileSync(staged, JSON.stringify(manifest))
      writeFileSync(archived, JSON.stringify(manifest))
      await asar.createPackage(input.source, join(input.resources, 'app.asar'))
      await expect(verifyDesktopCuaPackage(input.root, input.resources, () => {})).rejects.toThrow(/dependencies are incomplete/u)
    } finally { rmSync(input.base, { recursive: true, force: true }) }
  }
})

it('rejects versions inconsistent with the runtime release even when the ASAR matches', async () => {
  for (const change of ['package', 'dependency', 'optional', 'peer']) {
    const input = await fixture()
    try {
      const index = change === 'optional' ? 3 : 0
      const staged = join(input.root, 'node_modules', names[index]!, 'package.json')
      const archived = join(input.source, 'dsh/node_modules', names[index]!, 'package.json')
      const manifest = JSON.parse(readFileSync(staged, 'utf8')) as {
        version: string
        dependencies: Record<string, string>
        optionalDependencies: Record<string, string>
        peerDependencies: Record<string, string>
      }
      if (change === 'package') manifest.version = '2.0.0'
      if (change === 'dependency') manifest.dependencies[names[1]!] = '2.0.0'
      if (change === 'optional') manifest.optionalDependencies[names[0]!] = '2.0.0'
      if (change === 'peer') manifest.peerDependencies[names[2]!] = '2.0.0'
      writeFileSync(staged, JSON.stringify(manifest))
      writeFileSync(archived, JSON.stringify(manifest))
      await asar.createPackage(input.source, join(input.resources, 'app.asar'))
      await expect(verifyDesktopCuaPackage(input.root, input.resources, () => {})).rejects.toThrow()
    } finally { rmSync(input.base, { recursive: true, force: true }) }
  }
})

it('rejects an unselected helper generation in the packaged payload', async () => {
  const input = await fixture()
  try {
    mkdirSync(join(input.root, helper, 'previous-generation'))
    expect(() => readDesktopCuaApplication(join(input.root, helper))).toThrow(/unselected application generations/u)
  } finally { rmSync(input.base, { recursive: true, force: true }) }
})

it('rereads an ASAR rewritten after the first inspection', async () => {
  const input = await fixture()
  try {
    await verifyDesktopCuaPackage(input.root, input.resources, () => {})
    rmSync(join(input.source, 'dsh/node_modules', names[0]!, 'package.json'))
    await asar.createPackage(input.source, join(input.resources, 'app.asar'))
    await expect(verifyDesktopCuaPackage(input.root, input.resources, () => {})).rejects.toThrow()
  } finally { rmSync(input.base, { recursive: true, force: true }) }
})

it('fails both packaging hooks for an incomplete opt-in payload', async () => {
  const input = await fixture()
  try {
    rmSync(join(input.resources, 'app.asar.unpacked', 'dsh', helper, 'current.json'))
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.fixture', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_INCLUDE_CUA: '1' }, 'darwin', 'arm64', input.root)
    const context = { appOutDir: input.base, electronPlatformName: 'darwin', packager: { getResourcesDir: () => input.resources } }
    const missingReceipt = join(input.resources, 'app.asar.unpacked', 'dsh', helper, 'current.json')
    await expect(config.afterPack(context as never)).rejects.toThrow(missingReceipt)
    await expect(config.afterSign(context as never)).rejects.toThrow(missingReceipt)
  } finally { rmSync(input.base, { recursive: true, force: true }) }
})
