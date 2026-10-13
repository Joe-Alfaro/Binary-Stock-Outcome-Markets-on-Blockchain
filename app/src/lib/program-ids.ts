import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The program IDs in the IDLs `anchor build` writes; a missing IDL leaves its ID out. */
export interface BuiltProgramIds {
  meridian?: string
  meridianOracle?: string
}

function address(path: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { address: string }).address
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Reads the program IDs from the built IDLs in `idlDir`, so they follow `anchor keys sync` the
 * way the deployed programs do. Build-time only: `next.config.ts` turns them into the default
 * `NEXT_PUBLIC_*` program IDs.
 */
export function builtProgramIds(idlDir: string): BuiltProgramIds {
  const meridian = address(join(idlDir, 'meridian.json'))
  const meridianOracle = address(join(idlDir, 'meridian_oracle.json'))
  return {
    ...(meridian ? { meridian } : {}),
    ...(meridianOracle ? { meridianOracle } : {}),
  }
}
