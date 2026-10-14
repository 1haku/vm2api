import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  enrichCodexAccountIdentity,
  parseCodexCredentialInput,
  readCodexAccounts,
  summarizeCodexSlot,
  upsertCodexAccount,
} from '../../src/lib/vm/codex-slot.mjs'

test('parseCodexCredentialInput accepts Codex CLI auth.json', () => {
  const parsed = parseCodexCredentialInput({
    tokens: {
      access_token: 'eyJhbGciOiaccess',
      refresh_token: 'rt-1',
      id_token: 'id-1',
    },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, 'rt-1')
  assert.equal(parsed.account.chatgpt_account_id, 'acc-uuid')
})

test('parseCodexCredentialInput accepts kernel accounts file', () => {
  const parsed = parseCodexCredentialInput(
    JSON.stringify({
      accounts: [
        {
          id: 'user@example.com',
          access_token: 'at',
          refresh_token: 'rt',
          chatgpt_account_id: 'org-1',
        },
      ],
    }),
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.email, 'user@example.com')
  assert.equal(parsed.account.chatgpt_account_id, 'org-1')
})

test('parseCodexCredentialInput rejects Claude sessionKey JSON', () => {
  const parsed = parseCodexCredentialInput({ session_key: 'sk-ant-sid01-xxx' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'missing_token')
})

test('parseCodexCredentialInput accepts AT-only paste', () => {
  const parsed = parseCodexCredentialInput('eyJhbGciOiaccess', { mode: 'access_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'eyJhbGciOiaccess')
  assert.equal(parsed.account.refresh_token, '')
})

test('parseCodexCredentialInput accepts RT-only paste', () => {
  const parsed = parseCodexCredentialInput('rt-only-1\nrt-ignored', { mode: 'refresh_token' })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.refresh_token, 'rt-only-1')
  assert.equal(parsed.account.access_token, '')
  assert.equal(parsed.extra_count, 1)
})

test('parseCodexCredentialInput accepts camelCase credentials object', () => {
  const parsed = parseCodexCredentialInput({
    credentials: { accessToken: 'at-2', refreshToken: 'rt-2', idToken: 'id-2' },
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'at-2')
  assert.equal(parsed.account.refresh_token, 'rt-2')
})

test('parseCodexCredentialInput accepts CPR openai document', () => {
  const parsed = parseCodexCredentialInput({
    documents: [
      { provider: 'xai', document: { refreshToken: 'xai-rt' } },
      { provider: 'openai', document: { accounts: [{ accessToken: 'cpr-at', refreshToken: 'cpr-rt' }] } },
    ],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.access_token, 'cpr-at')
  assert.equal(parsed.account.refresh_token, 'cpr-rt')
})

test('parseCodexCredentialInput rejects OPENAI_API_KEY-only client config', () => {
  const parsed = parseCodexCredentialInput({ OPENAI_API_KEY: 'sk-proj-not-oauth' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error, 'not_oauth_account')
})

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.sig`
}

test('enrichCodexAccountIdentity extracts email from OAuth id_token', () => {
  const idToken = jwt({ email: 'gpt-user@example.com', sub: 'sub-1' })
  const accessToken = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-acc-9' },
  })
  const enriched = enrichCodexAccountIdentity({
    access_token: accessToken,
    refresh_token: 'rt',
    id_token: idToken,
  })
  assert.equal(enriched.email, 'gpt-user@example.com')
  assert.equal(enriched.chatgpt_account_id, 'chatgpt-acc-9')
})

test('upsertCodexAccount persists identity for panel summarizeCodexSlot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-oauth-id-'))
  const vmId = 'vm-codex-oauth'
  fs.mkdirSync(path.join(root, 'vms', vmId), { recursive: true })
  const idToken = jwt({ email: 'panel@example.com' })
  upsertCodexAccount(root, vmId, {
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-panel' } }),
    refresh_token: 'rt',
    id_token: idToken,
  })
  const summary = summarizeCodexSlot(root, {
    id: vmId,
    platform: 'openai',
    family: 'codex',
    codex: { has_access: true },
  })
  assert.equal(summary.email, 'panel@example.com')
  assert.equal(summary.chatgpt_account_id, 'acc-panel')
  fs.rmSync(root, { recursive: true, force: true })
})

test('enrichCodexAccountIdentity does not crash on invalid jwt', () => {
  const enriched = enrichCodexAccountIdentity({ access_token: 'bad-token', id_token: 'also-bad' })
  assert.equal(enriched.email, null)
  assert.equal(enriched.chatgpt_account_id, null)
})

test('upsertCodexAccount writes credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-slot-'))
  fs.mkdirSync(path.join(root, 'vms', 'vm-codex-01'), { recursive: true })
  upsertCodexAccount(root, 'vm-codex-01', {
    access_token: 'at',
    refresh_token: 'rt',
    chatgpt_account_id: 'org-9',
  })
  const accounts = readCodexAccounts(root, 'vm-codex-01')
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].access_token, 'at')
  assert.equal(accounts[0].chatgpt_account_id, 'org-9')
  fs.rmSync(root, { recursive: true, force: true })
})

test('imported Codex account defaults to unlimited kernel concurrency', () => {
  const parsed = parseCodexCredentialInput({
    tokens: { access_token: 'at', refresh_token: 'rt' },
    account_id: 'acc-uuid',
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.account.max_concurrency, 0)
  assert.equal(parsed.account.rpm, 0)
})
