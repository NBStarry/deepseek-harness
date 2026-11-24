import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { readProfileManifest, readProfilePlugins, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'
import { readDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}
function seedPlugin(manager: DesktopProjectManager): void {
  const path = join(manager.paths.profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dependencies.plugin = '1.0.0'
  manifest.dsh.profile.bundles.push('plugin')
  writeFileSync(path, JSON.stringify(manifest))
  const directory = join(manager.paths.profile, 'node_modules/plugin')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'plugin', version: '1.0.0', dsh: { bundle: { patch: 'bundle.yml' } } }))
  writeFileSync(join(directory, 'bundle.yml'), '[]\n')
}
function plugins(manager: DesktopProjectManager) {
  return readProfilePlugins({ binName: 'dsh', profileDir: manager.paths.profile,
    installAnchor: join(manager.runtime.dsh, 'node_modules/@deepseek-ai/dsh/package.json') }).dependencies
    .map(({ name, version, enabled }) => ({ name, version, enabled }))
}
function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh }) }
}
const cua = '@deepseek-ai/dsh-cua-bundle'
const cuaProvider = '@deepseek-ai/dsh-experimental-cua-macos'
const cuaGeneration = 'b'.repeat(64)
const cuaBin = `node_modules/${cuaProvider}/native/bin/darwin-arm64`
const cuaExecutable = `${cuaBin}/${cuaGeneration}/DSH Computer Use.app/Contents/MacOS/dsh-cua-native`
const cuaReceipt = `${cuaBin}/current.json`
function seedComputerUse(dsh: string, target: { platform: NodeJS.Platform; arch: string } = { platform: 'darwin', arch: 'arm64' }) {
  const modules = join(dsh, 'node_modules')
  const bundle = writePackage(modules, cua, { dsh: { bundle: { patch: './bundle.yml' } } })
  writeFileSync(join(bundle, 'bundle.yml'), '[]\n')
  const bin = join(writePackage(modules, cuaProvider), 'native/bin/darwin-arm64')
  const executable = join(bin, cuaGeneration, 'DSH Computer Use.app/Contents/MacOS/dsh-cua-native')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, 'fixture only', { mode: 0o755 })
  writeFileSync(join(bin, 'current.json'), JSON.stringify({ bundle: cuaGeneration }))
  const runtime = readDesktopRuntime(dsh)
  writeDesktopRuntime(dsh, runtime.release, [...runtime.sharedPackages.map(pkg => pkg.name), cua, cuaProvider], target)
  return { receipt: join(dsh, cuaReceipt), executable: join(dsh, cuaExecutable) }
}
function packagedCua(target: { platform: NodeJS.Platform; arch: string } = { platform: 'darwin', arch: 'arm64' }) {
  const { manager } = setup()
  const { dsh } = manager.runtime
  const seeded = seedComputerUse(dsh, target)
  return { manager: new DesktopProjectManager(manager.paths, { dsh, packaged: true }), ...seeded }
}
/**
 * Build an archive-shaped runtime: the logical dsh tree lives inside app.asar while
 * the helper payload exists on the physical app.asar.unpacked sibling.
 * @param mutate - edits the unpacked physical tree before release application.
 * @returns the manager under test plus the physical and logical roots.
 */
function packagedCuaInArchive(mutate?: (paths: { unpacked: string; executable: string }) => void) {
  const { manager } = setup()
  const { dsh } = manager.runtime
  seedComputerUse(dsh)
  const resources = dirname(dsh)
  const archive = join(resources, 'app.asar')
  mkdirSync(archive, { recursive: true })
  const archived = join(archive, 'dsh')
  renameSync(dsh, archived)
  const unpacked = join(resources, 'app.asar.unpacked', 'dsh')
  cpSync(archived, unpacked, { recursive: true })
  // The logical archive alone has no physical receipt; only the unpacked sibling is readable by plain Node.
  unlinkSync(join(archived, cuaReceipt))
  const executable = join(unpacked, cuaExecutable)
  mutate?.({ unpacked, executable })
  return { manager: new DesktopProjectManager(manager.paths, { dsh: archived, packaged: true }), executable }
}
function selectedBundles(manager: DesktopProjectManager): string[] {
  return (JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as
    { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop external plugin profile', () => {
  it.skipIf(process.platform === 'win32').each(['deselect', 'recover'])('preserves %s after first selecting embedded Computer Use', async (action) => {
    const { manager } = packagedCua()
    await manager.applyRelease()
    expect(selectedBundles(manager)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', cua])
    if (action === 'recover') await manager.disableAllPlugins()
    else {
      const profile = manager.paths.profile
      writeProfileBundles(profile, readProfileManifest('dsh', profile), selectedBundles(manager).filter(name => name !== cua))
    }
    await manager.applyRelease()
    expect(selectedBundles(manager)).not.toContain(cua)
  })

  it.skipIf(process.platform === 'win32')('reads the physical helper beside app.asar exactly as an unpacked feature', async () => {
    const { manager } = packagedCuaInArchive()
    await manager.applyRelease()
    expect(selectedBundles(manager)).toContain(cua)
  })

  it.skipIf(process.platform === 'win32').each([
    ['an empty file', (executable: string) => { writeFileSync(executable, '') }],
    ['a file without an executable bit', (executable: string) => { chmodSync(executable, 0o644) }],
  ])('does not select Computer Use when app.asar.unpacked carries %s', async (_condition, mutate) => {
    const { manager } = packagedCuaInArchive(({ executable }) => { mutate(executable) })
    await manager.applyRelease()
    expect(selectedBundles(manager)).not.toContain(cua)
  })

  it('does not backfill an existing unselected profile on upgrade from development or a build without CUA', async () => {
    const { manager } = packagedCua()
    await new DesktopProjectManager(manager.paths, { dsh: manager.runtime.dsh }).applyRelease()
    expect(selectedBundles(manager)).not.toContain(cua)
    const before = readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')).toBe(before)
  })

  it.each(['no executable', 'no receipt', 'invalid receipt', 'wrong generation', 'no embedded package', 'Intel', 'Windows'])
  ('does not select Computer Use when the build has %s', async (condition) => {
    const target = { platform: condition === 'Windows' ? 'win32' as const : 'darwin' as const, arch: condition === 'Intel' ? 'x64' : 'arm64' }
    const { manager, receipt, executable } = packagedCua(target)
    if (condition === 'no executable') unlinkSync(executable)
    if (condition === 'no receipt') unlinkSync(receipt)
    if (condition === 'invalid receipt') writeFileSync(receipt, 'broken')
    if (condition === 'wrong generation') writeFileSync(receipt, JSON.stringify({ bundle: '../invalid' }))
    if (condition === 'no embedded package') runtimeFixture(manager.runtime.dsh)
    await manager.applyRelease()
    expect(selectedBundles(manager)).not.toContain(cua)
  })

  it('preserves installed packages, profile state, and the lockfile when preparing a launch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const profile = manager.paths.profile
    const name = '@deepseek-ai/dsh-web-app'
    const path = join(profile, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    const manifestPath = join(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies[name] = '1.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(join(profile, 'desktop-runtime-state.json'), JSON.stringify({ links: [] }))
    writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    const files = [
      'package.json',
      'pnpm-workspace.yaml',
      'desktop-runtime-state.json',
      'pnpm-lock.yaml',
      `node_modules/${name}/package.json`,
      'node_modules/plugin/package.json',
      'node_modules/plugin/bundle.yml',
    ]
    const before = files.map(file => readFileSync(join(profile, file), 'utf8'))

    await expect(manager.applyRelease()).resolves.toBeUndefined()

    expect(files.map(file => readFileSync(join(profile, file), 'utf8'))).toEqual(before)
    expect(lstatSync(path).isDirectory()).toBe(true)
    expect(lstatSync(join(profile, 'node_modules/plugin')).isDirectory()).toBe(true)
  })
  it('reuses plugin files without scanning manifests and can disable them', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const manifest = join(manager.paths.profile, 'node_modules/plugin/package.json')
    writeFileSync(manifest, '{broken')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await manager.disableAllPlugins()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(manifest, 'utf8')).toBe('{broken')
  })

  it('disables every third-party bundle without reading a broken plugin patch declaration', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const patch = join(manager.paths.profile, 'node_modules/plugin/bundle.yml')
    unlinkSync(patch)
    await manager.disableAllPlugins()
    expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles).not.toContain('plugin')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    await expect(manager.applyRelease()).resolves.toBeUndefined()
  })

  it('disables plugins before runtime initialization and backs up the patch while preserving package files', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const patch = join(manager.paths.profile, 'cordis.patch.yml')
    writeFileSync(patch, ': broken')
    const uninitialized = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: 'missing-runtime' })
    const backupPath = await uninitialized.disableAllPlugins()
    expect(existsSync(patch)).toBe(false)
    const backups = readdirSync(manager.paths.profile).filter(name => name.startsWith('cordis.patch.yml.bak-'))
    expect(backups).toHaveLength(1)
    expect(backupPath).toBe(join(manager.paths.profile, backups[0]!))
    expect(readFileSync(join(manager.paths.profile, backups[0]!), 'utf8')).toBe(': broken')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies.plugin).toBe('1.0.0')
    expect(manifest.dsh.profile.bundles).not.toContain('plugin')
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
    await manager.applyRelease()
    expect(readFileSync(patch, 'utf8')).toContain('[]')
  })

  it('needs no runtime or package manifest when no plugins have been installed', async () => {
    const { manager } = setup()
    await expect(manager.disableAllPlugins()).resolves.toBeUndefined()
    expect(existsSync(join(manager.paths.profile, 'package.json'))).toBe(false)
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('reports invalid profile JSON without replacing it', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    writeFileSync(path, '{broken')
    await expect(manager.disableAllPlugins()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('initializes the same pnpm settings as a Web profile without a Desktop build allowlist', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  })

  it('opens a linked profile and migrates only the generated pnpm defaults', async () => {
    const { root, manager } = setup()
    const target = join(root, 'linked-profile')
    mkdirSync(target)
    mkdirSync(join(manager.paths.profile, '..'), { recursive: true })
    symlinkSync(target, manager.paths.profile, process.platform === 'win32' ? 'junction' : 'dir')
    await manager.applyRelease()
    const path = join(target, 'pnpm-workspace.yaml')
    const defaults = readFileSync(path, 'utf8')
    writeFileSync(path, `${defaults}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "@deepseek-ai/dsh-subprocess-local": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(defaults)
    const custom = `${defaults}allowBuilds:\n  my-plugin: true\n`
    writeFileSync(path, custom)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(custom)
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
  })

  it('preserves unknown files when initializing a profile', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(join(manager.paths.profile, '.DS_Store'), 'metadata')
    writeFileSync(join(manager.paths.profile, 'user-file'), 'retain')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(join(manager.paths.profile, '.DS_Store'), 'utf8')).toBe('metadata')
    expect(readFileSync(join(manager.paths.profile, 'user-file'), 'utf8')).toBe('retain')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(existsSync(join(manager.paths.profile, 'desktop-runtime-state.json'))).toBe(false)
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { manager } = setup()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(plugins(manager)).toEqual([])
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
    expect(existsSync(manager.paths.profile)).toBe(true)
  })

  it('keeps plugin files and patches through a compatible release and application relocation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    writeFileSync(join(manager.paths.profile, 'cordis.patch.yml'), '[]\n')
    const nextRoot = join(root, 'relocated', 'dsh')
    runtimeFixture(nextRoot, '1.1.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
    await expect(next.applyRelease()).resolves.toBeUndefined()
    expect(plugins(next)).toEqual(plugins(manager))
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('preserves plugin files without running pnpm when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(plugins(next)).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows peer version mismatches to reach Host startup and remain available for recovery', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    seedPlugin(manager)
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease()).resolves.toBeUndefined()
    await next.disableAllPlugins()
    expect(plugins(next)).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
  })
})

describe.each(['applyRelease', 'disableAllPlugins'] as const)('desktop profile lock during %s', (operation) => {
  it('preserves a live owner lock and leaves the profile untouched', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const owner = `${String(process.pid)}\n`
    writeFileSync(manager.paths.lock, owner)
    await expect(manager[operation]()).rejects.toThrow('another profile operation is active')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(owner)
    expect(readdirSync(manager.paths.profile)).toEqual(['lock'])
  })

  it('reclaims a stale owner lock and releases it after the operation', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(manager.paths.lock, `${String(process.pid)}\n`)
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process absent'), { code: 'ESRCH' })
    })
    try {
      await expect(manager[operation]()).resolves.toBeUndefined()
      expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0)
      expect(existsSync(manager.paths.lock)).toBe(false)
    } finally {
      probe.mockRestore()
    }
  })

  it.each(['invalid', '0', '-1', '9007199254740992'])('preserves a lock with invalid owner %s', async (owner) => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(manager.paths.lock, owner)
    await expect(manager[operation]()).rejects.toThrow('another profile operation is active')
    expect(readFileSync(manager.paths.lock, 'utf8')).toBe(owner)
  })

  it('rejects a directory at the lock path', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.lock, { recursive: true })
    await expect(manager[operation]()).rejects.toThrow('profile lock is not a regular file')
    expect(lstatSync(manager.paths.lock).isDirectory()).toBe(true)
  })

  it('rejects a linked lock without touching its target', async () => {
    const { root, manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const target = join(root, 'lock-target')
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'retain')
    symlinkSync(target, manager.paths.lock, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(manager[operation]()).rejects.toThrow('profile lock is not a regular file')
      expect(lstatSync(manager.paths.lock).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('retain')
    } finally {
      unlinkSync(manager.paths.lock)
    }
  })
})

describe('desktop link-backend projections', () => {
  it('removes .dsh-module-fallback projections when preparing a launch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const profile = manager.paths.profile
    const target = join(profile, 'node_modules', 'my-bundle', 'node_modules', 'bridge')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'bridge', version: '1.0.0' }))
    const owned = join(profile, '.dsh-module-fallback', 'node_modules', 'bridge')
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(owned, join(profile, 'node_modules', 'bridge'), process.platform === 'win32' ? 'junction' : 'dir')

    await manager.applyRelease()

    expect(existsSync(join(profile, '.dsh-module-fallback'))).toBe(false)
    expect(lstatSync(join(profile, 'node_modules', 'bridge'), { throwIfNoEntry: false })).toBeUndefined()
    expect(existsSync(join(target, 'package.json'))).toBe(true)
  })
})
