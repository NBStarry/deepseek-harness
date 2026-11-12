/** Stage local-branded DSH packages for unsigned Desktop builds without a publication record. */

import { cpSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { list } from 'tar'
import {
  readClientBuildRecord,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import { readCuaApplication } from '../../../scripts/cua-helper/payload.ts'
import { pnpmInvocation } from '../../../scripts/pnpm-invocation.ts'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from '../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../scripts/release/pack.ts'
import { runConcurrent } from '../../../scripts/release/process.ts'
import { packedManifest, tarballFiles } from '../../../scripts/release/tarball.ts'

const PROVIDER = '@deepseek-ai/dsh-experimental-cua-macos'
const PROVIDER_DIRECTORY = 'packages/experimental/cua-macos'

/**
 * Validate direct local-pack invocations before touching the staging directory.
 * @param environment - Packaging environment.
 * @param hostPlatform - Build host platform.
 * @param hostArch - Build host architecture.
 * @returns Whether to include the local CUA helper.
 */
export function localCuaEnabled(environment: NodeJS.ProcessEnv, hostPlatform: NodeJS.Platform, hostArch: string): boolean {
  const value = environment.DSH_DESKTOP_INCLUDE_CUA
  if (value === undefined) return false
  if (value !== '1') throw new Error('desktop local pack: DSH_DESKTOP_INCLUDE_CUA must be 1 when set')
  if (environment.DSH_DESKTOP_UNSIGNED !== '1' || environment.DSH_DESKTOP_TARGET_PLATFORM !== 'darwin'
    || environment.DSH_DESKTOP_TARGET_ARCH !== 'arm64' || hostPlatform !== 'darwin' || hostArch !== 'arm64') {
    throw new Error('desktop local pack: CUA requires unsigned mac-arm64 on an Apple Silicon host')
  }
  return true
}

/**
 * Copy the provider and workspace manifests to a private staging workspace.
 * @param root - Source repository.
 * @param stage - New, build-owned staging directory.
 * @param member - Provider release member.
 * @returns Staged provider directory.
 */
export function stageCuaProvider(root: string, stage: string, member: ReleaseMember): string {
  if (member.name !== PROVIDER || member.directory !== PROVIDER_DIRECTORY) throw new Error('desktop local pack: unexpected CUA provider')
  const source = resolve(root, member.directory)
  const provider = join(stage, 'provider')
  const included = new Set(['package.json', 'README.md', 'LICENSE', 'locale', 'lib', 'native'])
  const native = new Set(['Package.swift', 'Info.plist', 'DSHComputerUse.icns', 'build_app.py', 'Sources', 'tests',
    'LICENSE.cua-driver', 'LICENSE.computer-use-icon', 'upstream.json', 'README.md', 'README.zh.md', 'protocol.schema.json'])
  cpSync(source, provider, {
    recursive: true,
    filter: (path) => {
      const parts = relative(source, path).split(/[\\/]/u)
      const [top, child, leaf] = parts
      return top === '' || (top !== undefined && included.has(top) && !parts.includes('node_modules')
        && (top !== 'native' || child === undefined || native.has(child))
        && (top !== 'native' || child !== 'tests' || leaf === undefined || ['swift', 'test_swift.py'].includes(leaf)))
    },
  })
  const manifest: unknown = JSON.parse(readFileSync(join(provider, 'package.json'), 'utf8'))
  if (JSON.stringify(manifest) !== JSON.stringify(member.manifest)) throw new Error('desktop local pack: staged provider manifest differs from source selection')
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'desktop-cua-pack-staging', private: true }))
  writeFileSync(join(stage, 'pnpm-workspace.yaml'), 'packages:\n  - provider\n  - dependencies/*\n')
  const byName = new Map<string, { name: string; version: string }>()
  const workspace: unknown = load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  if (workspace === null || typeof workspace !== 'object' || !('packages' in workspace)
    || !Array.isArray(workspace.packages) || !workspace.packages.every((pattern: unknown) => typeof pattern === 'string' && !pattern.startsWith('!'))) {
    throw new Error('desktop local pack: unsupported workspace package patterns')
  }
  const paths = globSync(workspace.packages.map((pattern: string) => `${pattern}/package.json`), { cwd: root })
  for (const path of paths) {
    const entry = JSON.parse(readFileSync(join(root, path), 'utf8')) as { name?: string; version?: string }
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string') continue
    if (byName.has(entry.name)) throw new Error(`desktop local pack: duplicate workspace package ${entry.name}`)
    byName.set(entry.name, { name: entry.name, version: entry.version })
  }
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
  const staged = new Set<string>()
  for (const section of sections) {
    const fields = member.manifest[section]
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) continue
    for (const [name, spec] of Object.entries(fields)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (!/^workspace:[*~^]$/u.test(spec)) throw new Error(`desktop local pack: unsupported workspace dependency ${name}: ${spec}`)
      const dependency = byName.get(name)
      if (dependency === undefined) throw new Error(`desktop local pack: missing workspace dependency ${name}`)
      if (staged.has(name)) continue
      staged.add(name)
      const directory = join(stage, 'dependencies', String(staged.size))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: dependency.name, version: dependency.version, private: true }))
    }
  }
  return provider
}

/**
 * Build and verify the staged helper before any family tarball is packed.
 * @param root - Source repository containing the native builder.
 * @param stage - Private staging workspace.
 * @param provider - Staged provider directory.
 */
export async function buildStagedCua(root: string, stage: string, provider: string): Promise<void> {
  const output = join(provider, 'native/bin/darwin-arm64')
  await runConcurrent('/usr/bin/xcrun', ['python3', join(root, PROVIDER_DIRECTORY, 'native/build_app.py'),
    '--arch', 'arm64', '--scratch-path', join(stage, 'swift-build'), '--output-directory', output, '--identity', '-'])
  const { application } = readCuaApplication(output)
  await runConcurrent('/usr/bin/lipo', [join(application, 'Contents/MacOS/dsh-cua-native'), '-verify_arch', 'arm64'])
  await runConcurrent('/usr/bin/codesign', ['--verify', '--strict', application])
}

/**
 * Compare every staged helper file with its packed bytes and executable mode.
 * @param tarball - Provider tarball to inspect without extraction.
 * @param provider - Staged provider with a validated receipt.
 */
export async function validatePackedCua(tarball: string, provider: string): Promise<void> {
  const directory = join(provider, 'native/bin/darwin-arm64')
  const { bundle } = readCuaApplication(directory)
  const prefix = 'package/native/bin/'
  const selected = `darwin-arm64/${bundle}/DSH Computer Use.app/`
  const expected = new Set<string>(['darwin-arm64/current.json'])
  const visit = (path: string): void => {
    for (const name of readdirSync(join(directory, bundle, 'DSH Computer Use.app', path))) {
      const child = path ? `${path}/${name}` : name
      const stat = lstatSync(join(directory, bundle, 'DSH Computer Use.app', child))
      if (stat.isDirectory()) visit(child)
      else if (stat.isFile()) expected.add(`${selected}${child}`)
      else throw new Error(`desktop local pack: invalid staged helper entry ${child}`)
    }
  }
  visit('')
  const seen = new Set<string>()
  let failure: Error | undefined
  await list({ file: tarball, strict: true, onReadEntry: (entry) => {
    if (!entry.path.startsWith(prefix)) { entry.resume(); return }
    const path = entry.path.slice(prefix.length)
    if (entry.type === 'Directory') {
      if (path !== '' && ![...expected].some(file => file.startsWith(`${path.replace(/\/$/u, '')}/`))) {
        failure ??= new Error(`desktop local pack: unexpected helper tarball directory ${entry.path}`)
      }
      entry.resume()
      return
    }
    if (entry.type !== 'File' || !expected.has(path) || seen.has(path)) {
      failure ??= new Error(`desktop local pack: unexpected helper tarball entry ${entry.path}`)
      entry.resume()
      return
    }
    seen.add(path)
    try {
      const original = join(directory, path.slice('darwin-arm64/'.length))
      const source = readFileSync(original)
      const sourceExecutable = (lstatSync(original).mode & 0o111) !== 0
      const digest = createHash('sha256')
      entry.on('data', (chunk: Buffer) => { digest.update(chunk) })
      entry.on('end', () => {
        if (digest.digest('hex') !== createHash('sha256').update(source).digest('hex') || entry.mode === undefined
          || ((entry.mode & 0o111) !== 0) !== sourceExecutable) {
          failure ??= new Error(`desktop local pack: helper tarball changed ${path}`)
        }
      })
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error))
      entry.resume()
    }
  } })
  if (failure !== undefined) throw failure
  if (seen.size !== expected.size) throw new Error('desktop local pack: provider tarball omits staged helper files')
}

/**
 * Validate the staged provider tarball and replace only its family counterpart.
 * @param family - Family payload and manifest policy.
 * @param member - Original provider release member.
 * @param stagedTarball - Provider tarball in the private staging workspace.
 * @param destination - Family tarball output directory.
 * @param packed - Family pack result in publish order.
 */
export function replaceCuaTarball(
  family: ReleaseFamily, member: ReleaseMember, stagedTarball: string, destination: string, packed: readonly string[],
): void {
  const filename = tarballName(member)
  if (member.name !== PROVIDER || basename(stagedTarball) !== filename || packed.filter(name => name === filename).length !== 1) {
    throw new Error('desktop local pack: CUA replacement does not match exactly one provider tarball')
  }
  const original = join(destination, filename)
  if (!existsSync(original)) throw new Error('desktop local pack: family provider tarball is missing')
  const files = tarballFiles(stagedTarball)
  family.validatePayload(member, files)
  const stagedManifest = packedManifest(stagedTarball)
  family.validatePackedManifest(member, stagedManifest)
  if (JSON.stringify(stagedManifest) !== JSON.stringify(packedManifest(original))) {
    throw new Error('desktop local pack: staged provider manifest differs from family pack')
  }
  renameSync(stagedTarball, original)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.out === undefined) throw new Error('desktop local pack: --out must name the package staging directory')
  const concurrency = parsePackConcurrency(values.concurrency)
  const root = process.cwd()
  const includeCua = localCuaEnabled(process.env, process.platform, process.arch)
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), 'local')
  readClientBuildRecord(root, environment)
  const destination = resolve(root, values.out)
  const family = releaseFamily('dsh')
  if (!includeCua) {
    const packed = await packFamilyMembers(root, family, destination, concurrency)
    console.log(`desktop local pack: ${String(packed.length)} tarball(s) in ${destination}`)
    return
  }
  const members = family.members(root).filter(member => member.name === PROVIDER)
  const member = members[0]
  if (members.length !== 1 || member === undefined) throw new Error('desktop local pack: expected exactly one CUA provider')
  mkdirSync(dirname(destination), { recursive: true })
  const stage = mkdtempSync(join(dirname(destination), '.cua-pack-'))
  try {
    const provider = stageCuaProvider(root, stage, member)
    await buildStagedCua(root, stage, provider)
    const packed = await packFamilyMembers(root, family, destination, concurrency)
    const output = join(stage, 'packed')
    mkdirSync(output)
    const invocation = pnpmInvocation(['--dir', provider, '--ignore-scripts', 'pack', '--pack-destination', output])
    await runConcurrent(invocation.command, invocation.args, { cwd: stage })
    const tarball = join(output, tarballName(member))
    await validatePackedCua(tarball, provider)
    replaceCuaTarball(family, member, tarball, destination, packed)
    console.log(`desktop local pack: ${String(packed.length)} tarball(s) in ${destination}`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
