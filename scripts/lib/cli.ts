import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { CommandRunner } from '../deploy-devnet.js'

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

/** Loads `.env` from the working directory when it exists. Variables already set win. */
export function loadDotEnv(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path)
}

/**
 * Runs commands as child processes. Foreground commands must exit 0 and their stdout is returned
 * (and echoed). Background commands keep running until this process exits.
 */
export function spawnRunner(): CommandRunner & { stopAll(): void } {
  const background: ChildProcess[] = []
  const stopAll = () => background.forEach((child) => child.kill('SIGTERM'))
  process.once('exit', stopAll)

  return {
    stopAll,
    run(command, args, options = {}) {
      const env = { ...process.env, ...options.env }
      if (options.background) {
        background.push(spawn(command, args, { env, cwd: options.cwd, stdio: 'inherit' }))
        return Promise.resolve({ stdout: '' })
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          env,
          cwd: options.cwd,
          stdio: ['inherit', 'pipe', 'inherit'],
        })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          process.stdout.write(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) resolve({ stdout })
          else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
        })
      })
    },
  }
}
