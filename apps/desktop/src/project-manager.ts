/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import { initProfile, removeLinkProjections, sanitizeProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES, type ProfileTemplate } from '@deepseek-ai/dsh-official-bundles'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string; readonly packaged?: boolean },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(() => {
      const descriptor = readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      createPluginProfile(this.paths.profile, this.runtime.packaged ? { root: this.runtime.dsh, descriptor } : undefined)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'
const CUA_PROVIDER = '@deepseek-ai/dsh-experimental-cua-macos'

/** Native payloads beside an app.asar archive live on the physical file system as its `app.asar.unpacked` sibling. */
function physicalRuntimeRoot(root: string): string {
  const parent = dirname(root)
  return basename(parent) === 'app.asar' ? join(`${parent}.unpacked`, basename(root)) : root
}

/** Only the immutable application supplies first-launch defaults, never a profile-installed package. */
function embedsComputerUse(root: string, descriptor: DesktopRuntimeDescriptor): boolean {
  if (descriptor.platform !== 'darwin' || descriptor.arch !== 'arm64') return false
  const carries = (name: string) => descriptor.sharedPackages.some(pkg => pkg.name === name && pkg.version === descriptor.release.version)
  if (!carries(CUA_BUNDLE) || !carries(CUA_PROVIDER)) return false
  const physicalRoot = physicalRuntimeRoot(root)
  const bin = `node_modules/${CUA_PROVIDER}/native/bin/darwin-arm64`
  const receipt = join(physicalRoot, bin, 'current.json')
  if (!existsSync(receipt)) return false
  let selected: unknown
  try { selected = JSON.parse(readFileSync(receipt, 'utf8')) } catch (error) {
    console.warn('Desktop skipped Computer Use: cannot read the packaged helper receipt.', error)
    return false
  }
  if (typeof selected !== 'object' || selected === null || !('bundle' in selected)
    || typeof selected.bundle !== 'string' || !/^[a-f0-9]{64}$/u.test(selected.bundle)) {
    console.warn('Desktop skipped Computer Use: invalid packaged helper generation.')
    return false
  }
  const path = `${bin}/${selected.bundle}/DSH Computer Use.app/Contents/MacOS/dsh-cua-native`
  if (!descriptor.files.some(file => file.path === path && file.executable && file.bytes > 0)) return false
  // ASAR metadata describes the logical tree; the helper must also be a real executable file beside it.
  const helper = lstatSync(join(physicalRoot, path), { throwIfNoEntry: false })
  return helper !== undefined && helper.isFile() && !helper.isSymbolicLink()
    && helper.size > 0 && (helper.mode & 0o111) !== 0
}

/**
 * Initialize missing profile files. Only a new profile can inherit the packaged Computer Use selection.
 * @param projectDir - External Desktop profile directory.
 * @param packaged - Immutable application root and its validated build descriptor; absent in development.
 */
export function createPluginProfile(projectDir: string, packaged?: { root: string; descriptor: DesktopRuntimeDescriptor }): void {
  const includeCua = packaged !== undefined && !existsSync(join(projectDir, 'package.json'))
    && embedsComputerUse(packaged.root, packaged.descriptor)
  initProfile(projectDir, includeCua ? [...WEB_PROFILE.bundles, CUA_BUNDLE] : WEB_PROFILE.bundles)
}
