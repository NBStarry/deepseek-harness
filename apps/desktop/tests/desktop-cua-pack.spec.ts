/** Pure fixtures for the opt-in Desktop CUA packing path. */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { create } from 'tar'
import { cuaApplicationDigest } from '../../../scripts/cua-helper/payload.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { releaseFamily, tarballName } from '../../../scripts/release/families.ts'
import { cuaPackArguments, localCuaEnabled, replaceCuaTarball, stageCuaProvider, validatePackedCua } from '../scripts/pack-local-packages.ts'
import { resolveDesktopPackageTarget, validateDesktopCuaOption } from '../scripts/package-target.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cua-pack-fixture-'))
  roots.push(root)
  return root
}
function write(root: string, path: string, value: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('accepts only the explicit unsigned mac-arm64 option', () => {
  const target = resolveDesktopPackageTarget('mac-arm64', 'darwin', 'arm64')
  expect(validateDesktopCuaOption(undefined, target, false)).toBe(false)
  expect(validateDesktopCuaOption('1', target, true)).toBe(true)
  for (const invalid of ['', '0', 'true', '2']) expect(() => validateDesktopCuaOption(invalid, target, true)).toThrow(/must be 1/)
  expect(() => validateDesktopCuaOption('1', target, false)).toThrow(/unsigned mac-arm64/)
  const x64 = resolveDesktopPackageTarget('mac-x64', 'darwin', 'arm64')
  expect(() => validateDesktopCuaOption('1', x64, true)).toThrow(/unsigned mac-arm64/)
  const env = { DSH_DESKTOP_INCLUDE_CUA: '1', DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
  expect(localCuaEnabled(env, 'darwin', 'arm64')).toBe(true)
  expect(localCuaEnabled({}, 'linux', 'x64')).toBe(false)
  expect(() => localCuaEnabled({ ...env, DSH_DESKTOP_UNSIGNED: '0' }, 'darwin', 'arm64')).toThrow()
  expect(() => localCuaEnabled({ ...env, DSH_DESKTOP_TARGET_ARCH: 'x64' }, 'darwin', 'arm64')).toThrow()
  expect(() => localCuaEnabled(env, 'linux', 'arm64')).toThrow()
  expect(() => localCuaEnabled({ ...env, DSH_DESKTOP_INCLUDE_CUA: '0' }, 'darwin', 'arm64')).toThrow()
})

it('stages only the provider and the workspace dependency manifests without touching source native/bin', () => {
  const root = fixture()
  const provider = 'packages/experimental/cua-macos'
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*/*\n  - vendor/*\n')
  const manifest = { name: '@deepseek-ai/dsh-experimental-cua-macos', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-dep': 'workspace:*' }, peerDependencies: { '@deepseek-ai/cordis': 'workspace:~' }, devDependencies: { '@deepseek-ai/dsh-dep': 'workspace:*' } }
  write(root, `${provider}/package.json`, JSON.stringify(manifest))
  write(root, `${provider}/lib/index.js`, 'provider')
  write(root, `${provider}/native/bin/sentinel`, 'source helper')
  write(root, `${provider}/node_modules/ignored`, 'ignored')
  write(root, `${provider}/src/ignored.ts`, 'ignored')
  write(root, `${provider}/native/.build/ignored`, 'ignored')
  write(root, 'packages/util/dep/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-dep', version: '1.0.0' }))
  write(root, 'vendor/cordis/package.json', JSON.stringify({ name: '@deepseek-ai/cordis', version: '3.0.0' }))
  const family = releaseFamily('dsh')
  const member = family.members(root).find(value => value.name === manifest.name)
  if (member === undefined) throw new Error('provider fixture missing')
  const stage = join(root, 'stage')
  mkdirSync(stage)
  const staged = stageCuaProvider(root, stage, member)
  expect(readFileSync(join(staged, 'lib/index.js'), 'utf8')).toBe('provider')
  expect(existsSync(join(staged, 'native/bin'))).toBe(false)
  expect(existsSync(join(staged, 'node_modules'))).toBe(false)
  expect(existsSync(join(staged, 'src'))).toBe(false)
  expect(existsSync(join(staged, 'native/.build'))).toBe(false)
  expect(readFileSync(join(root, provider, 'native/bin/sentinel'), 'utf8')).toBe('source helper')
  expect(readdirSync(join(stage, 'dependencies'))).toHaveLength(2)
  const dependencies = readdirSync(join(stage, 'dependencies')).map(name => (
    JSON.parse(readFileSync(join(stage, 'dependencies', name, 'package.json'), 'utf8')) as Record<string, string | boolean>
  ))
  expect(dependencies).toEqual(expect.arrayContaining([
    { name: '@deepseek-ai/dsh-dep', version: '1.0.0', private: true },
    { name: '@deepseek-ai/cordis', version: '3.0.0', private: true },
  ]))
})

it('rejects tarballs that omit or modify any selected helper bytes before replacement', async () => {
  const root = fixture()
  const provider = join(root, 'provider')
  const bin = join(provider, 'native/bin/darwin-arm64')
  const temporary = join(bin, 'generation/DSH Computer Use.app')
  for (const path of ['Contents/Info.plist', 'Contents/MacOS/dsh-cua-native', 'Contents/Resources/DSHComputerUse.icns', 'Contents/_CodeSignature/CodeResources']) {
    write(temporary, path, path)
  }
  chmodSync(join(temporary, 'Contents/MacOS/dsh-cua-native'), 0o755)
  const digest = cuaApplicationDigest(temporary)
  renameSync(join(bin, 'generation'), join(bin, digest))
  write(bin, 'current.json', JSON.stringify({ bundle: digest }))
  const packed = join(root, 'package')
  mkdirSync(join(packed, 'native/bin'), { recursive: true })
  cpSync(join(provider, 'native/bin/darwin-arm64'), join(packed, 'native/bin/darwin-arm64'), { recursive: true })
  const tarball = join(root, 'provider.tgz')
  await create({ cwd: root, file: tarball, gzip: true }, ['package'])
  await expect(validatePackedCua(tarball, provider)).resolves.toBeUndefined()
  write(packed, `native/bin/darwin-arm64/${digest}/DSH Computer Use.app/Contents/Info.plist`, 'modified')
  await create({ cwd: root, file: tarball, gzip: true }, ['package'])
  await expect(validatePackedCua(tarball, provider)).rejects.toThrow(/changed/)
  cpSync(join(provider, 'native/bin/darwin-arm64'), join(packed, 'native/bin/darwin-arm64'), { recursive: true, force: true })
  rmSync(join(packed, 'native/bin/darwin-arm64', digest, 'DSH Computer Use.app/Contents/Info.plist'))
  await create({ cwd: root, file: tarball, gzip: true }, ['package'])
  await expect(validatePackedCua(tarball, provider)).rejects.toThrow(/omits/)
})

it('replaces only the matched provider family tarball after validating identity and payload', async () => {
  const root = fixture()
  const manifest = { name: '@deepseek-ai/dsh-experimental-cua-macos', version: '1.0.0' }
  write(root, 'packages/experimental/cua-macos/package.json', JSON.stringify(manifest))
  const family = releaseFamily('dsh')
  const member = family.members(root)[0]
  if (member === undefined) throw new Error('provider fixture missing')
  const filename = tarballName(member)
  const destination = join(root, 'destination')
  const staged = join(root, 'staged')
  mkdirSync(destination)
  mkdirSync(staged)
  write(root, 'original-package/package/package.json', JSON.stringify(manifest))
  await create({ cwd: join(root, 'original-package'), file: join(destination, filename), gzip: true }, ['package'])
  const original = readFileSync(join(destination, filename))
  write(destination, 'other.tgz', 'other')
  write(root, 'package/package.json', JSON.stringify({ ...manifest, version: 'wrong' }))
  await create({ cwd: root, file: join(staged, filename), gzip: true }, ['package'])
  expect(() => { replaceCuaTarball(family, member, join(staged, filename), destination, []) }).toThrow(/exactly one/)
  expect(() => { replaceCuaTarball(family, member, join(staged, filename), destination, [filename]) }).toThrow(/packed identity/)
  expect(readFileSync(join(destination, filename))).toEqual(original)
  write(root, 'package/package.json', JSON.stringify({ ...manifest, dependencies: { extra: '1.0.0' } }))
  await create({ cwd: root, file: join(staged, filename), gzip: true }, ['package'])
  expect(() => { replaceCuaTarball(family, member, join(staged, filename), destination, [filename]) }).toThrow(/differs from family pack/)
  expect(readFileSync(join(destination, filename))).toEqual(original)
  write(root, 'package/package.json', JSON.stringify(manifest))
  await create({ cwd: root, file: join(staged, filename), gzip: true }, ['package'])
  const bytes = readFileSync(join(staged, filename))
  replaceCuaTarball(family, member, join(staged, filename), destination, [filename])
  expect(readFileSync(join(destination, filename))).toEqual(bytes)
  expect(readFileSync(join(destination, 'other.tgz'), 'utf8')).toBe('other')
})

it('packs the staged provider with all pack lifecycle scripts disabled by the supported pnpm config', () => {
  const root = fixture()
  const stage = join(root, 'stage')
  const provider = join(stage, 'provider')
  const output = join(root, 'packed')
  const sentinels = join(root, 'sentinels')
  const scripts = ['prepack', 'prepare', 'postpack'] as const
  write(stage, 'pnpm-workspace.yaml', 'packages:\n  - provider\n')
  write(provider, 'index.js', 'export {}\n')
  write(provider, 'package.json', JSON.stringify({
    name: 'cua-pack-lifecycle', version: '1.0.0', files: ['index.js'],
    scripts: Object.fromEntries(scripts.map(script => [
      script,
      `node -e "require('node:fs').writeFileSync(require('node:path').join(process.env.CUA_PACK_SENTINELS, '${script}'), '1')"`,
    ])),
  }))
  mkdirSync(output)
  mkdirSync(sentinels)
  const invocation = pnpmInvocation(cuaPackArguments(provider, output))
  execFileSync(invocation.command, invocation.args, {
    cwd: stage, stdio: 'pipe', env: { ...process.env, CUA_PACK_SENTINELS: sentinels },
  })
  expect(existsSync(join(output, 'cua-pack-lifecycle-1.0.0.tgz'))).toBe(true)
  for (const script of scripts) expect(existsSync(join(sentinels, script))).toBe(false)
})
