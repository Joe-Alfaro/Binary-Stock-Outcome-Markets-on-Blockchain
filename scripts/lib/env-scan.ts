/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
/** Names of the environment variables a source file reads (process.env.X, env.X and similar). */
export function findEnvReads(_source: string): string[] {
  throw new Error('not implemented')
}

/** Variable names and values in a .env file, ignoring comments and blank lines. */
export function parseEnvFile(_content: string): Map<string, string> {
  throw new Error('not implemented')
}

/** True when a .env value looks like a secret that must not be committed. */
export function looksSecret(_name: string, _value: string): boolean {
  throw new Error('not implemented')
}
