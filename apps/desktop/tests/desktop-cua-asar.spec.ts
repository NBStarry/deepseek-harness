/** Exercise electron-builder's actual ASAR matcher and physical unpacker. */
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import type { Configuration } from 'app-builder-lib'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { afterEach, expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { desktopCuaHelperPath, verifyDesktopCuaUnpacked } from '../scripts/desktop-cua-native.mjs'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js') as {
  AsarPackager: new (packager: object, configuration: object) => {
    pack(files: { src: string; destination: string; files: string[]; metadata: Map<string, Stats> }[]): Promise<void>
  }
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('physically unpacks complete helpers and receipts from both architectures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-cua-asar-'))
  roots.push(root)
  const source = join(root, 'dsh')
  const resources = join(root, 'resources')
  const destination = join(resources, 'app')
  await mkdir(resources, { recursive: true })
  for (const arch of ['arm64', 'x64'] as const) {
    const directory = join(source, desktopCuaHelperPath(arch))
    const entries = [
      ['Contents/Info.plist', 'plist'], ['Contents/MacOS/dsh-cua-native', `binary-${arch}`],
      ['Contents/Resources/DSHComputerUse.icns', 'icon'], ['Contents/_CodeSignature/CodeResources', 'signature'],
      ['Contents/CodeResources/ticket', 'ticket'],
    ] as const
    const digest = createHash('sha256')
    for (const [name, bytes] of entries.toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      digest.update(`${name}\0`).update(createHash('sha256').update(bytes).digest())
        .update(Buffer.from([name.includes('/MacOS/') ? 1 : 0]))
    }
    const bundle = digest.digest('hex')
    for (const [name, bytes] of entries) {
      const file = join(directory, bundle, 'DSH Computer Use.app', name)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes, { mode: name.includes('/MacOS/') ? 0o755 : 0o644 })
    }
    await writeFile(join(directory, 'current.json'), JSON.stringify({ bundle }))
  }
  const config = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'com.example.desktop' }, 'darwin', 'arm64', source)
  const matcherConfig = { asarUnpack: [...config.asarUnpack] } satisfies Configuration
  const matchers = getFileMatchers(matcherConfig, 'asarUnpack', destination, {
    defaultSrc: root, globalOutDir: root, customBuildOptions: {}, macroExpander: value => value.replaceAll('${arch}', 'arm64'),
  })!
  const files: string[] = []
  const metadata = new Map<string, Stats>()
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const file = join(directory, name)
      const stat = await lstat(file)
      if (stat.isDirectory()) await visit(file)
      else { files.push(file); metadata.set(file, stat) }
    }
  }
  await visit(source)
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: destination, resourcePath: resources, options: {}, unpackPattern: matchers[0]!.createFilter(),
  }).pack([{ src: source, destination: join(destination, 'dsh'), files, metadata }])
  expect(() => { verifyDesktopCuaUnpacked(source, resources, 'arm64', undefined, () => {}) }).not.toThrow()
})
