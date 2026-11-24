/** Resolve an opt-in Desktop bundle through the real profile and Cordis Loader. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages, readProfilePlugins } from '@deepseek-ai/dsh-app-boot'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function pkg(dir: string, name: string, extra: Record<string, unknown> = {}, body = ''): void {
  file(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', ...extra }))
  file(join(dir, 'index.js'), body)
}

describe('Desktop optional bundle resolution', () => {
  it('finds an opt-in bundle in the runtime and resolves its selected profile closure', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-resolution-')))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const runtime = join(root, 'runtime')
    const profileDir = join(root, 'profiles', 'desktop')
    const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    pkg(dirname(anchor), '@deepseek-ai/dsh')
    pkg(runtime, 'desktop-runtime', { dependencies: { 'fixture-cua-bundle': '1.0.0', 'fixture-provider': '1.0.0' } })
    const bundleDir = join(runtime, 'node_modules', 'fixture-cua-bundle')
    pkg(bundleDir, 'fixture-cua-bundle', {
      dependencies: { 'fixture-cua': '1.0.0' }, optionalDependencies: { 'fixture-provider': '1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    file(join(bundleDir, 'cordis.patch.yml'), '[]\n')
    pkg(join(runtime, 'node_modules', 'fixture-cua'), 'fixture-cua', {}, 'export const marker = "runtime-cua"\n')
    pkg(join(runtime, 'node_modules', 'fixture-provider'), 'fixture-provider', {}, 'export const marker = "runtime-provider"\n')
    initProfile(profileDir, ['fixture-cua-bundle'])
    const profile = loadProfileDirectory('dsh', profileDir, anchor)
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.map(layer => layer.packageDir)).toEqual([bundleDir])
    const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: root })
    expect(resolution.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'fixture-provider', scope: 'profile' }),
      expect.objectContaining({ name: 'fixture-cua', scope: 'profile' }),
    ]))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href })
    expect(ctx.loader.internal).toBeDefined()
    await ctx.plugin(PluginPackages, { resolution })
    await expect(ctx.loader.root.tree.import('fixture-cua')).resolves.toMatchObject({ marker: 'runtime-cua' })
    await expect(ctx.loader.root.tree.import('fixture-provider')).resolves.toMatchObject({ marker: 'runtime-provider' })
  })

  it('cannot resolve unselected runtime-only packages from the profile', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-unselected-')))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const runtime = join(root, 'runtime')
    const profileDir = join(root, 'profiles', 'desktop')
    const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    pkg(dirname(anchor), '@deepseek-ai/dsh')
    pkg(runtime, 'desktop-runtime', { dependencies: { 'fixture-cua-bundle': '1.0.0', 'fixture-provider': '1.0.0' } })
    const bundle = join(runtime, 'node_modules', 'fixture-cua-bundle')
    pkg(bundle, 'fixture-cua-bundle', { dependencies: { 'fixture-provider': '1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
    file(join(bundle, 'cordis.patch.yml'), '[]\n')
    pkg(join(runtime, 'node_modules', 'fixture-provider'), 'fixture-provider', {}, 'export const marker = "runtime-provider"\n')
    initProfile(profileDir, [])
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'fixture-cua-bundle': '1.0.0' }, dsh: { profile: { bundles: [] } } }))
    pkg(join(profileDir, 'node_modules', 'fixture-cua-bundle'), 'fixture-cua-bundle', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    expect(readProfilePlugins({ binName: 'dsh', profileDir, installAnchor: anchor }).dependencies)
      .toEqual([expect.objectContaining({ name: 'fixture-cua-bundle', bundle: true, enabled: false })])
    const profile = loadProfileDirectory('dsh', profileDir, anchor)
    expect(profile.layers).toEqual([])
    const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: root })
    expect(resolution.entries.some(entry => entry.name === 'fixture-provider')).toBe(false)
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href })
    await ctx.plugin(PluginPackages, { resolution })
    await expect(ctx.loader.root.tree.import('fixture-provider')).rejects.toThrow()
  })

  it('resolves the profile direct dependency before the selected bundle mapping', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-profile-')))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const runtime = join(root, 'runtime')
    const profileDir = join(root, 'profiles', 'desktop')
    const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    pkg(dirname(anchor), '@deepseek-ai/dsh')
    pkg(runtime, 'desktop-runtime')
    const bundle = join(runtime, 'node_modules', 'fixture-cua-bundle')
    pkg(bundle, 'fixture-cua-bundle', { dependencies: { 'fixture-provider': '1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
    file(join(bundle, 'cordis.patch.yml'), '[]\n')
    pkg(join(bundle, 'node_modules', 'fixture-provider'), 'fixture-provider', {}, 'export const marker = "bundle"\n')
    initProfile(profileDir, ['fixture-cua-bundle'])
    pkg(join(profileDir, 'node_modules', 'fixture-provider'), 'fixture-provider', {}, 'export const marker = "profile"\n')
    const profile = loadProfileDirectory('dsh', profileDir, anchor)
    const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: root })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href })
    await ctx.plugin(PluginPackages, { resolution })
    await expect(ctx.loader.root.tree.import('fixture-provider')).resolves.toMatchObject({ marker: 'profile' })
  })

  it('uses the runtime bundle before a same-named profile bundle', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-shadow-')))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const runtime = join(root, 'runtime')
    const profileDir = join(root, 'profiles', 'desktop')
    const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    pkg(dirname(anchor), '@deepseek-ai/dsh')
    pkg(runtime, 'desktop-runtime')
    const runtimeBundle = join(runtime, 'node_modules', 'fixture-cua-bundle')
    const profileBundle = join(profileDir, 'node_modules', 'fixture-cua-bundle')
    for (const [dir, marker] of [[runtimeBundle, 'runtime'], [profileBundle, 'profile']] as const) {
      pkg(dir, 'fixture-cua-bundle', { dependencies: { 'fixture-provider': '1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } })
      file(join(dir, 'cordis.patch.yml'), '[]\n')
      pkg(join(dir, 'node_modules', 'fixture-provider'), 'fixture-provider', {}, `export const marker = ${JSON.stringify(marker)}\n`)
    }
    initProfile(profileDir, ['fixture-cua-bundle'])
    pkg(join(profileDir, 'node_modules', 'fixture-cua-bundle', 'node_modules', 'fixture-private'), 'fixture-private', {}, 'export const marker = "old-private"\n')
    file(join(profileDir, 'node_modules', 'fixture-cua-bundle', 'check.js'), 'export { marker } from "fixture-private"\n')
    const profile = loadProfileDirectory('dsh', profileDir, anchor)
    expect(profile.layers.map(layer => layer.packageDir)).toEqual([runtimeBundle])
    const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: root })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href })
    await ctx.plugin(PluginPackages, { resolution })
    await expect(ctx.loader.root.tree.import('fixture-provider')).resolves.toMatchObject({ marker: 'runtime' })
    await expect(import(pathToFileURL(join(profileBundle, 'check.js')).href)).resolves.toMatchObject({ marker: 'old-private' })
  })
})
