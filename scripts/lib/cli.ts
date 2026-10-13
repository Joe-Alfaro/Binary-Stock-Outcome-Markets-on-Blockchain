import { pathToFileURL } from 'node:url'

/** True when the module at `moduleUrl` is the script node was started with. */
export function isEntryPoint(moduleUrl: string) {
  const entry = process.argv[1]
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href
}

/** Runs a script's main function, printing the error and exiting non-zero on failure. */
export function runMain(main: () => Promise<void>) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
