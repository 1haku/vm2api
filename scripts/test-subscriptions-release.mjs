// Run inside the candidate release image, without production data or Docker socket mounts.
import { spawnSync } from 'node:child_process'

const unit = [
  'subscriptions',
  'custom-migrations',
  'panel-acl',
  'slot-shell-rc',
  'cli-node-guard',
  'oauth-identity',
  'oauth-credentials',
  'oauth-auth-url',
  'slot-oauth',
  'session-oauth-seam',
  'credential-mode',
  'claude-setup-token',
  'claude-reset-credits',
  'auto-mode',
  'auto-mode-api',
  'crs-persona',
  'official-fingerprint',
  'codex-convert',
  'codex-restriction',
  'handle-codex',
  'failover-runner',
  'guest-identity-reader',
  'request-log',
  'vm-test-chat-billing',
]
const e2e = ['subscriptions', 'slot-plan-startup', 'panel-api', 'auto-mode']
const result = spawnSync(
  process.execPath,
  [
    '--test',
    ...unit.map((name) => `test/unit/${name}.test.mjs`),
    ...e2e.map((name) => `test/e2e/${name}.e2e.test.mjs`),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      KIN_AUTOMODE_KERNEL: '/opt/vm2api/image-wrap-cli/kin-kernel',
      KIN_AUTOMODE_CLI: '/opt/vm2api/image-wrap-cli/cli-node',
      KIN_OAUTH_AUTH_BIN: '/opt/vm2api/image-bin/kin-oauth-auth',
    },
  },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
