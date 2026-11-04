/** Prepare and verify the complete Computer Use application shipped in Desktop. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyMacOSRuntimeCode } from './verify-macos-signature.mjs'

const packagePath = 'node_modules/@deepseek-ai/dsh-experimental-cua-macos'
const applicationName = 'DSH Computer Use.app'
const execute = (command, args) => { execFileSync(command, args, { stdio: 'inherit' }) }

/**
 * Return the target receipt directory relative to the Desktop runtime.
 * @param {'arm64' | 'x64'} arch - Electron target architecture.
 * @returns {string} Relative architecture directory.
 */
export function desktopCuaHelperPath(arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`desktop CUA: unsupported architecture ${arch}`)
  return `${packagePath}/native/bin/darwin-${arch}`
}

/**
 * Validate the selected generation against the producer's content digest algorithm.
 * @param {string} directory - Architecture directory containing current.json.
 * @returns {{application: string, bundle: string}} Selected immutable application.
 */
export function readDesktopCuaApplication(directory) {
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, 'current.json')).isFile()) throw new Error('desktop CUA: invalid receipt directory')
  const receipt = JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8'))
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)
    || Object.keys(receipt).length !== 1 || typeof receipt.bundle !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.bundle)) {
    throw new Error('desktop CUA: invalid receipt')
  }
  const { bundle } = receipt
  if (!lstatSync(join(directory, bundle)).isDirectory()) throw new Error('desktop CUA: invalid generation')
  const application = join(directory, bundle, applicationName)
  if (!lstatSync(application).isDirectory()) throw new Error('desktop CUA: invalid application')
  const files = []
  const visit = relative => {
    for (const name of readdirSync(join(application, relative))) {
      const path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(join(application, path))
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(path)
      else throw new Error(`desktop CUA: application contains a link or special file: ${path}`)
    }
  }
  visit('')
  for (const path of ['Contents/Info.plist', 'Contents/MacOS/dsh-cua-native', 'Contents/Resources/DSHComputerUse.icns', 'Contents/_CodeSignature/CodeResources']) {
    if (!files.includes(path)) throw new Error(`desktop CUA: application omits ${path}`)
  }
  const executable = join(application, 'Contents/MacOS/dsh-cua-native')
  if ((lstatSync(executable).mode & 0o111) === 0) throw new Error('desktop CUA: helper is not executable')
  const digest = createHash('sha256')
  for (const path of files.sort()) {
    const file = join(application, path)
    digest.update(`${path}\0`).update(createHash('sha256').update(readFileSync(file)).digest())
      .update(Buffer.from([(lstatSync(file).mode & 0o111) === 0 ? 0 : 1]))
  }
  if (digest.digest('hex') !== bundle) throw new Error('desktop CUA: application digest does not match receipt')
  if (readdirSync(directory).sort().join(',') !== [bundle, 'current.json'].sort().join(',')) throw new Error('desktop CUA: unselected application generation')
  return { application, bundle }
}

/**
 * Validate architecture and signature without modifying a helper application.
 * @param {string} directory - Architecture directory containing current.json.
 * @param {'arm64' | 'x64'} arch - Target architecture.
 * @param {{signingIdentity: string, teamId: string} | undefined} expected - Release identity, or undefined for local builds.
 * @param {(command: string, args: string[]) => void} [run] - Apple tool runner.
 * @returns {{application: string, bundle: string}} Validated selected application.
 */
export function verifyDesktopCua(directory, arch, expected, run = execute) {
  desktopCuaHelperPath(arch)
  const selected = readDesktopCuaApplication(directory)
  run('/usr/bin/lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', join(selected.application, 'Contents/MacOS/dsh-cua-native')])
  if (expected === undefined) run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', selected.application])
  else {
    verifyMacOSRuntimeCode(selected.application, expected)
    run('/usr/bin/xcrun', ['stapler', 'validate', selected.application])
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', selected.application])
  }
  return selected
}

/**
 * Skip absent providers; otherwise preserve a distributed application or build an unsigned helper.
 * @param {string} root - Staged Desktop runtime.
 * @param {{platform: string, arch: 'arm64' | 'x64'}} target - Target platform and architecture.
 * @param {string} sourceNative - Checkout native source directory for unsigned builds.
 * @param {{signingIdentity: string, teamId: string} | undefined} expected - Required release identity, undefined only for unsigned builds.
 * @param {(command: string, args: string[]) => void} [run] - Apple tool runner.
 * @returns {void}
 */
export function prepareDesktopCua(root, target, sourceNative, expected, run = execute) {
  if (target.platform !== 'darwin') return
  const directory = join(root, desktopCuaHelperPath(target.arch))
  if (!existsSync(join(root, packagePath))) return
  if (!existsSync(directory)) {
    if (expected !== undefined) throw new Error('desktop CUA: signed build requires a distributed release helper')
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-cua-'))
    try {
      run('/usr/bin/xcrun', ['python3', join(sourceNative, 'build_app.py'), '--scratch-path', scratch,
        '--output-directory', directory, '--arch', target.arch === 'x64' ? 'x86_64' : 'arm64'])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  verifyDesktopCua(directory, target.arch, expected, run)
}

/**
 * Verify each staged helper survives unpacking; an absent provider must have no unpacked helpers.
 * @param {string} root - Staged Desktop runtime.
 * @param {string} resources - Packaged app resources directory.
 * @param {'arm64' | 'x64'} arch - Electron target architecture.
 * @param {{signingIdentity: string, teamId: string} | undefined} expected - Required release identity.
 * @param {(command: string, args: string[]) => void} [run] - Apple tool runner.
 * @returns {void}
 */
export function verifyDesktopCuaUnpacked(root, resources, arch, expected, run = execute) {
  desktopCuaHelperPath(arch)
  const providerPresent = existsSync(join(root, packagePath))
  for (const candidate of [arch, arch === 'arm64' ? 'x64' : 'arm64']) {
    const relative = desktopCuaHelperPath(candidate)
    const stagedPath = join(root, relative)
    const unpackedPath = join(resources, 'app.asar.unpacked', 'dsh', relative)
    if (!providerPresent || (candidate !== arch && !existsSync(stagedPath))) {
      if (existsSync(unpackedPath)) throw new Error('desktop CUA: unexpected unpacked helper')
      continue
    }
    const staged = verifyDesktopCua(stagedPath, candidate, expected, run)
    const unpacked = verifyDesktopCua(unpackedPath, candidate, expected, run)
    if (staged.bundle !== unpacked.bundle) throw new Error('desktop CUA: packaged helper differs from staged helper')
  }
}
