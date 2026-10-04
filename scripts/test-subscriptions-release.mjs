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
  'panel-billing-lookup',
  'panel-route-coverage',
  'kernel-router',
  'outbound-parity',
  'distill-detect',
  'remote-fs',
  'egress',
  'oauth-binary',
  'statistics-repo',
  'usage-logs-view',
  'identity-rewrite',
  'sticky-router',
  'log-fields',
  'proxy-pool-update',
  'panel-api-proxy',
  'official-cc-bootstrap',
]
const e2e = [
  'subscriptions',
  'slot-plan-startup',
  'panel-api',
  'auto-mode',
  'health',
  'credential-rotation',
  'statistics-ownership',
]
const result = spawnSync(
  process.execPath,
  [
    '--test',
    // Native CLI fixtures have a bounded cold-start deadline; avoid starting all test files at once.
    '--test-concurrency=2',
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
      KIN_EGRESS_BIN: '/opt/vm2api/image-bin/kin-egress',
    },
  },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
