import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'

function runtimeFor(file) {
  return createRoutingRuntime({ routingConfigPath: file })
}

test('loadRoutingConfig fails when routing.json is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-missing-'))
  try {
    assert.throws(() => runtimeFor(path.join(root, 'routing.json')).loadRoutingConfig(), /Routing config .*not found/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('loadRoutingConfig fails when routing.json is invalid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-runtime-invalid-'))
  const file = path.join(root, 'routing.json')
  try {
    fs.writeFileSync(file, '{invalid')
    assert.throws(() => runtimeFor(file).loadRoutingConfig(), /Routing config .*invalid JSON/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
