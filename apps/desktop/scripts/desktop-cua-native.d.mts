import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'

type Runner = (command: string, args: string[]) => void
export function desktopCuaHelperPath(arch: 'arm64' | 'x64'): string
export function readDesktopCuaApplication(directory: string): { application: string; bundle: string }
export function verifyDesktopCua(directory: string, arch: 'arm64' | 'x64', expected: MacOSSigningEnvironment | undefined, run?: Runner): { application: string; bundle: string }
export function prepareDesktopCua(root: string, target: { platform: string; arch: 'arm64' | 'x64' }, sourceNative: string, expected: MacOSSigningEnvironment | undefined, run?: Runner): void
export function verifyDesktopCuaUnpacked(root: string, resources: string, arch: 'arm64' | 'x64', expected: MacOSSigningEnvironment | undefined, run?: Runner): void
