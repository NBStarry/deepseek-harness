/** Verify the staged Computer Use packages and the actual unsigned macOS payload. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readCuaApplication } from '../../../scripts/cua-helper/payload.ts'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const names = [
  '@deepseek-ai/dsh-experimental-cua-macos',
  '@deepseek-ai/dsh-cua',
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-cua-bundle',
]
const providerPath = `node_modules/${names[0]}`
const helperPath = `${providerPath}/native/bin/darwin-arm64`
const applicationName = 'DSH Computer Use.app'
const runAppleTool = (command, args) => { execFileSync(command, args, { stdio: 'inherit' }) }

/**
 * Validate the opt-in flag and restrict it to unsigned macOS arm64 builds.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {{platform: string, arch: string, unsigned: boolean}} target - Resolved build target.
 * @returns {boolean} Whether CUA verification is enabled.
 */
export function resolveDesktopCua(env, target) {
  const value = env.DSH_DESKTOP_INCLUDE_CUA
  if (value === undefined) return false
  if (value !== '1') throw new Error('desktop CUA: DSH_DESKTOP_INCLUDE_CUA must be 1 when set')
  if (target.platform !== 'darwin' || target.arch !== 'arm64' || !target.unsigned) {
    throw new Error('desktop CUA: embedding requires unsigned mac-arm64')
  }
  return true
}

/**
 * Validate the helper receipt, required files, executable bit, and generation digest.
 * @param {string} directory - Directory containing the helper receipt.
 * @returns {{application: string, bundle: string}} Validated helper generation.
 */
export function readDesktopCuaApplication(directory) {
  const selected = readCuaApplication(directory)
  if (readdirSync(join(directory, selected.bundle)).join(',') !== applicationName) throw new Error('desktop CUA: unexpected generation content')
  return selected
}

/**
 * Verify staged and unpacked helper generations and invoke macOS architecture and signature checks.
 * @param {string} root - Staged dsh runtime.
 * @param {string} resources - Packaged application resources.
 * @param {(command: string, args: string[]) => void} [run] - Apple tool runner.
 * @returns {void}
 */
export function verifyDesktopCuaUnpacked(root, resources, run = runAppleTool) {
  const stagedDirectory = join(root, helperPath)
  const unpackedDirectory = join(resources, 'app.asar.unpacked', 'dsh', helperPath)
  const staged = readDesktopCuaApplication(stagedDirectory)
  const unpacked = readDesktopCuaApplication(unpackedDirectory)
  if (staged.bundle !== unpacked.bundle || !readFileSync(join(stagedDirectory, 'current.json')).equals(readFileSync(join(unpackedDirectory, 'current.json')))) {
    throw new Error('desktop CUA: packaged helper differs from staged helper')
  }
  for (const selected of [staged, unpacked]) {
    run('/usr/bin/lipo', [join(selected.application, 'Contents/MacOS/dsh-cua-native'), '-verify_arch', 'arm64'])
    run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', selected.application])
  }
  const unexpected = join(resources, 'app.asar.unpacked', 'dsh', providerPath, 'native/bin/darwin-x64')
  if (existsSync(unexpected)) throw new Error('desktop CUA: unexpected unpacked helper architecture')
}

function builderTools() {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  return {
    asar: builderRequire('@electron/asar'),
    transform: builderRequire('app-builder-lib/out/fileTransformer.js').createTransformer('', {}, null),
  }
}

/**
 * Verify packaged ASAR manifests and bundle patch against staged inputs, then verify the unpacked helper.
 * @param {string} root - Staged dsh runtime.
 * @param {string} resources - Packaged application resources.
 * @param {(command: string, args: string[]) => void} [run] - Apple tool runner.
 * @returns {Promise<void>} Rejects on any missing or changed payload.
 */
export async function verifyDesktopCuaPackage(root, resources, run = runAppleTool) {
  const { asar, transform } = builderTools()
  const archive = join(resources, 'app.asar')
  // afterPack and afterSign inspect the same path, whose ASAR header may have changed.
  asar.uncache(archive)
  const extract = path => {
    let current = ''
    for (const component of path.split('/')) {
      current = current ? `${current}/${component}` : component
      const info = asar.statFile(archive, current, false)
      if (info.link !== undefined || info.unpacked === true) throw new Error(`desktop CUA: ASAR entry is not packed: ${current}`)
    }
    return asar.extractFile(archive, path, false)
  }
  const runtimePath = join(root, 'package.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  const transformedRuntime = await transform(runtimePath)
  const expectedRuntime = Buffer.from(transformedRuntime ?? readFileSync(runtimePath))
  if (!extract('dsh/package.json').equals(expectedRuntime)) throw new Error('desktop CUA: packaged runtime manifest differs from staged')
  const version = runtime.version
  if (typeof version !== 'string' || !version) throw new Error('desktop CUA: missing runtime release version')
  let bundleManifest
  for (const name of names) {
    const path = `node_modules/${name}/package.json`
    const stagedPath = join(root, path)
    const staged = JSON.parse(readFileSync(stagedPath, 'utf8'))
    if (staged.name !== name || staged.version !== version || runtime.dependencies?.[name] !== version) {
      throw new Error(`desktop CUA: invalid staged manifest ${name}`)
    }
    const transformed = await transform(stagedPath)
    const expected = Buffer.from(transformed ?? readFileSync(stagedPath))
    const actual = extract(`dsh/${path}`)
    if (!actual.equals(expected)) throw new Error(`desktop CUA: packaged manifest differs from staged ${name}`)
    const required = name === names[0] ? [names[1]] : name === names[1] ? [names[2]] : name === names[3] ? [names[1], names[2]] : []
    if (name === names[0] && staged.peerDependencies?.[names[2]] !== version) {
      throw new Error('desktop CUA: provider computer-use peer has the wrong version')
    }
    if (required.some(dependency => staged.dependencies?.[dependency] !== version)) {
      throw new Error(`desktop CUA: staged dependencies are incomplete or have the wrong version: ${name}`)
    }
    if (name === names[3]) bundleManifest = staged
  }
  if (bundleManifest.optionalDependencies?.[names[0]] !== version) {
    throw new Error('desktop CUA: staged bundle dependencies are incomplete')
  }
  const patch = bundleManifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !/^\.\/[^/\\]+\.ya?ml$/u.test(patch)) throw new Error('desktop CUA: invalid bundle patch path')
  const patchPath = `node_modules/${names[3]}/${patch.slice(2)}`
  const stagedPatch = readFileSync(join(root, patchPath))
  const sourcePatch = readFileSync(new URL('../../../packages/experimental/cua-bundle/cordis.patch.yml', import.meta.url))
  if (!stagedPatch.equals(sourcePatch) || !extract(`dsh/${patchPath}`).equals(stagedPatch)) {
    throw new Error('desktop CUA: packaged bundle patch differs from source or staged')
  }
  verifyDesktopCuaUnpacked(root, resources, run)
}
