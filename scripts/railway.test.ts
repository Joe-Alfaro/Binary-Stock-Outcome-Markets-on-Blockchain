import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { REPO_ROOT } from './lib/test-support.js'

interface RailwayConfig {
  build?: { buildCommand?: string }
  deploy?: {
    startCommand?: string
    healthcheckPath?: string
    healthcheckTimeout?: number
    restartPolicyType?: string
  }
}

interface WorkspacePackage {
  scripts?: Record<string, string>
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as T
}

// R65: two Railway services, web and automation, with build and start commands and a health
// check, defined in the repo.
const services = [
  {
    name: 'web',
    config: 'app/railway.json',
    workspace: 'app',
    start: 'npm run start -w app',
    build: /npm run build -w app/,
    healthcheckPath: '/',
  },
  {
    name: 'automation',
    config: 'services/automation/railway.json',
    workspace: 'services/automation',
    start: 'npm run start -w services/automation',
    build: /npm ci/,
    healthcheckPath: '/healthz',
  },
]

describe('Railway config (R65)', () => {
  services.forEach((service) => {
    describe(service.name, () => {
      it('defines build and start commands', () => {
        const config = readJson<RailwayConfig>(service.config)
        assert.match(config.build?.buildCommand ?? '', service.build)
        assert.equal(config.deploy?.startCommand, service.start)
      })

      it('defines a health check', () => {
        const config = readJson<RailwayConfig>(service.config)
        assert.equal(config.deploy?.healthcheckPath, service.healthcheckPath)
        const timeout = config.deploy?.healthcheckTimeout
        assert.ok(typeof timeout === 'number' && timeout > 0)
      })

      it('starts a workspace that has a start script', () => {
        const pkg = readJson<WorkspacePackage>(join(service.workspace, 'package.json'))
        assert.ok(pkg.scripts?.start, `${service.workspace} has no start script`)
      })
    })
  })
})
