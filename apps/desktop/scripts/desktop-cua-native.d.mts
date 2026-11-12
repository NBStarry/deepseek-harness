/** Validate the opt-in flag and require unsigned macOS arm64. */
export function resolveDesktopCua(env: NodeJS.ProcessEnv, target: { platform: string, arch: string, unsigned: boolean }): boolean

/** Validate the helper receipt and its content digest. */
export function readDesktopCuaApplication(directory: string): { application: string, bundle: string }

/** Compare staged and unpacked helpers and run platform checks. */
export function verifyDesktopCuaUnpacked(root: string, resources: string, run?: (command: string, args: string[]) => void): void

/** Compare the actual ASAR and unpacked helper with the staged runtime. */
export function verifyDesktopCuaPackage(root: string, resources: string, run?: (command: string, args: string[]) => void): Promise<void>
