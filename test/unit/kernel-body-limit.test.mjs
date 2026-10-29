import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DEFAULT_MAX_REQUEST_BYTES } from '../../src/lib/core/request-size.mjs'

const MiB = 1024 * 1024
const nativeCli = '/opt/vm2api/image-native-cli/cli-node'
const cliBin = process.arch === 'arm64' && fs.existsSync(nativeCli) ? nativeCli : '/opt/vm2api/image-wrap-cli/cli-node'
// Native parser tests use no credentials and an invalid JSON body: no inference or upstream call.
for (const vendor of ['claude', 'codex']) {
  test(`${vendor} native kernel accepts 33 MiB at the 128 MiB budget and rejects over-budget bodies`, {
    skip: process.platform !== 'linux',
    timeout: 30000,
  }, async () => {
    const bin = vendor === 'claude' ? '/opt/vm2api/image-wrap-cli/kin-kernel' : '/opt/vm2api/image-bin/kin-codex-kernel'
    assert.ok(fs.existsSync(bin), 'candidate release must contain native payload')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-body-limit-'))
    try {
      for (const limit of [32 * MiB, DEFAULT_MAX_REQUEST_BYTES]) {
        const socket = path.join(dir, 'probe.sock'),
          config = path.join(dir, 'kernel.json')
        fs.rmSync(socket, { force: true })
        fs.writeFileSync(
          path.join(dir, 'no-credentials.json'),
          JSON.stringify({ anthropicApiKey: { apiKey: 'fixture-only-key' } }),
        )
        fs.writeFileSync(
          config,
          JSON.stringify({
            vm_id: 'isolated-size-probe',
            device_id: 'isolated-size-probe',
            socket_path: socket,
            credential_path: path.join(dir, 'no-credentials.json'),
            internal_token: 'fixture-only-token',
            proxy_url: 'socks5://127.0.0.1:9',
            proxy_required: true,
            provider: 'local_cli',
            test_endpoints: true,
            claude_bin: cliBin,
            max_request_bytes: limit,
            anthropic_base_url: 'http://127.0.0.1:9',
          }),
        )
        const child = spawn(bin, vendor === 'claude' ? ['--gateway-worker', '--config', config] : [config], {
          cwd: dir,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: dir,
            CLAUDE_CONFIG_DIR: dir,
            ANTHROPIC_API_KEY: 'fixture-only-key',
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let diagnostics = ''
        child.stderr.on('data', (chunk) => {
          diagnostics = (diagnostics + chunk.toString()).slice(0, 1500)
        })
        child.stdout.on('data', (chunk) => {
          diagnostics = (diagnostics + chunk.toString()).slice(0, 1500)
        })
        const closed = once(child, 'exit')
        try {
          for (let i = 0; i < 160 && !fs.existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50))
          assert.ok(fs.existsSync(socket), 'isolated kernel socket ready (exit ' + child.exitCode + '): ' + diagnostics)
          const request = (bytes) =>
            new Promise((resolve, reject) => {
              const req = http.request(
                {
                  socketPath: socket,
                  method: 'POST',
                  path: vendor === 'claude' ? '/internal/v1/messages' : '/internal/v1/codex/responses',
                  headers: {
                    'content-type': 'application/json',
                    'content-length': bytes,
                    'x-kin-internal-token': 'fixture-only-token',
                    'x-internal-token': 'fixture-only-token',
                  },
                },
                (res) => {
                  res.resume()
                  res.on('end', () => resolve(res.statusCode))
                },
              )
              req.on('socket', (s) => s.on('error', () => {}))
              req.on('error', (e) => {
                if (e.code !== 'EPIPE') reject(e)
              })
              req.setTimeout(10000, () => req.destroy(new Error('parser probe timeout')))
              req.end(Buffer.concat([Buffer.alloc(bytes - 1, 32), Buffer.from('!')]))
            })
          assert.equal(await request(33 * MiB), limit === 32 * MiB ? 413 : 400)
        } finally {
          child.kill('SIGTERM')
          await closed
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
