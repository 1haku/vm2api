import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('control-plane Dockerfiles build kin-api-kernel into image-bin', () => {
  for (const rel of ['Dockerfile', 'deploy/Dockerfile.arm64-control', 'deploy/Dockerfile.subscriptions']) {
    const body = fs.readFileSync(path.join(root, rel), 'utf8')
    assert.match(body, /kin-api-kernel/, rel)
    assert.match(body, /api-kernel/, rel)
  }
})

test('docker entrypoint refreshes kin-api-kernel before Node starts', () => {
  const entry = fs.readFileSync(path.join(root, 'scripts/docker-entrypoint.sh'), 'utf8')
  assert.match(entry, /ensure_bin kin-api-kernel/)
  assert.match(entry, /KIN_API_KERNEL_BIN/)
})

test('a local payload cache works offline only when the pinned size and hash both match', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-payload-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'bin'))
  const data = Buffer.from('verified fixture payload')
  const payload = path.join(dir, 'bin', 'fixture')
  const manifest = path.join(dir, 'manifest.json')
  fs.writeFileSync(payload, data)
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      repo: 'example/invalid',
      release: 'pinned',
      files: [
        {
          path: 'bin/fixture',
          asset: 'fixture',
          size: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        },
      ],
    }),
  )
  const run = () =>
    spawnSync(process.execPath, [path.join(root, 'scripts/fetch-payload.mjs'), '--dest', dir, '--manifest', manifest], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, VM2API_PAYLOAD_BASE_URL: 'http://127.0.0.1:1' },
    })
  assert.equal(run().status, 0, 'valid cache needs no network')
  fs.writeFileSync(payload, Buffer.alloc(data.length, 0x58))
  assert.notEqual(run().status, 0, 'same size but different hash must fail offline')
  fs.writeFileSync(payload, Buffer.concat([data, Buffer.from('extra')]))
  assert.notEqual(run().status, 0, 'different size must fail offline')
})
