import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultRedaction, normalizeRedaction } from '../../src/lib/redaction/policy.mjs'

describe('redaction policy', () => {
  it('treats a missing block as off without inventing protection', () => {
    assert.deepEqual(normalizeRedaction(undefined), defaultRedaction())
  })

  it('rejects coerced booleans and unknown fields', () => {
    assert.throws(() => normalizeRedaction({ enabled: 'false', secrets: true, personal: true }), {
      code: 'invalid_redaction_config',
      status: 400,
      message: /enabled/,
    })
    assert.throws(() => normalizeRedaction({ enabled: false, secrets: true, personal: true, shape: true }), {
      code: 'invalid_redaction_config',
      status: 400,
      message: /unknown/,
    })
  })

  it('rejects an enabled policy with nothing to protect', () => {
    assert.throws(
      () => normalizeRedaction({ enabled: true, secrets: false, personal: false, words: ['  '], rules: [] }),
      { code: 'invalid_redaction_config', status: 400, message: /requires/ },
    )
  })

  it('keeps words when the switch is off and drops blanks', () => {
    assert.deepEqual(
      normalizeRedaction({
        enabled: false,
        secrets: true,
        personal: false,
        words: [' 夜莺 ', '夜莺', ''],
        rules: [],
      }),
      {
        enabled: false,
        secrets: true,
        personal: false,
        words: ['夜莺'],
        wordsAnyCase: false,
        rules: [],
        kinds: {},
        allow: [],
      },
    )
  })

  it('keeps kind overrides, case folding, and the allow list', () => {
    assert.partialDeepStrictEqual(
      normalizeRedaction({
        enabled: true,
        secrets: true,
        personal: true,
        words: ['Nightjar'],
        wordsAnyCase: true,
        rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
        kinds: { ip: true, home: false },
        allow: [' build-01 '],
      }),
      {
        wordsAnyCase: true,
        kinds: { ip: true, home: false },
        allow: ['build-01'],
        rules: [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_', regex: '' }],
      },
    )
  })

  it('trims rule prefixes and normalizes the allow list', () => {
    const policy = normalizeRedaction({
      enabled: true,
      secrets: true,
      personal: true,
      rules: [{ kind: 'GATEWAY_KEY', prefix: ' oc_sk_ ' }, { prefix: ' ' }],
      allow: [' build-01 ', 'build-01', ''],
    })
    assert.deepEqual(policy.allow, ['build-01'])
    assert.deepEqual(
      policy.rules.map(({ kind, prefix }) => ({ kind, prefix })),
      [{ kind: 'GATEWAY_KEY', prefix: 'oc_sk_' }],
    )
  })
})
