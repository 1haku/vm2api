import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { containerName } from './vm-runtime.mjs'
import { runtimeKind } from './runtime-kind.mjs'
import { slotHost } from './slot-host.mjs'
import { guestAccount } from './guest-account.mjs'
import { resolveGuestSpec } from './os-catalog.mjs'

const runFile = promisify(execFile)

// Guest facts only. Minimal Arch images lack hostname; uname -n is the same nodename.
export const READ_IDENTITY = `
set -eu
if [ -r /etc/os-release ]; then . /etc/os-release; fi
host="$(hostname 2>/dev/null || uname -n)"
printf '%s\\000' "$host" "\${ID:-}" "\${PRETTY_NAME:-}" "$(uname -r)" "$(uname -m)"
printf '%s\\000' "$(cat /etc/machine-id 2>/dev/null || true)" "\${TZ:-$(cat /etc/timezone 2>/dev/null || true)}" "\${LC_ALL:-\${LANG:-}}"
`
const READ_ACCOUNT = `
printf '%s\\000' "\${VERSION_ID:-}" "$(cat /etc/kin-os)"
python3 - <<'PY'
import os,pwd,json,sys
p=pwd.getpwuid(os.geteuid()); h=os.environ['HOME']; s=os.stat(h)
status=dict(l.rstrip().split(':',1) for l in open('/proc/1/status') if ':' in l)
environment=dict(part.split(b'=',1) for part in open('/proc/1/environ','rb').read(65536).split(b'\\0') if b'=' in part)
a={'username':p.pw_name,'uid':os.geteuid(),'gid':os.getegid(),'home':h,'passwd_home':p.pw_dir,'passwd_gid':p.pw_gid,'cwd':os.getcwd(),'user':os.environ.get('USER'),'logname':os.environ.get('LOGNAME'),'owner_uid':s.st_uid,'owner_gid':s.st_gid,'worker_euid':int(status['Uid'].split()[1]),'worker_caps':status['CapEff'].strip(),'worker_no_new_privs':int(status['NoNewPrivs']),'worker_home':environment.get(b'HOME',b'').decode(),'worker_user':environment.get(b'USER',b'').decode(),'worker_logname':environment.get(b'LOGNAME',b'').decode(),'worker_cwd':os.readlink('/proc/1/cwd')}
sys.stdout.write(json.dumps(a)+'\\0')
PY
`

export async function readGuestIdentity(exec, _requestPath, { timeoutMs = 5000, run = runFile } = {}) {
  const fail = (code, message) => ({ ok: false, status: 502, body: { error: { code, message } } })
  try {
    if (runtimeKind(exec?.vm) !== 'docker')
      return fail('guest_identity_unsupported', 'Guest identity collection is not implemented for this runtime')
    if (!exec?.vmId) return fail('vm_required', 'vm required')
    const host = slotHost(exec.vm)
    const env = host.dockerEnv()
    const account = guestAccount(exec.vm)
    const v2 = account.contract === 'linux-account-v2'
    const spec = v2 ? resolveGuestSpec(exec.vm) : null
    const argv = [
      'exec',
      ...(v2
        ? [
            '-u',
            host.execUser(exec.vm),
            '-w',
            account.home,
            '-e',
            `HOME=${account.home}`,
            '-e',
            `USER=${account.username}`,
            '-e',
            `LOGNAME=${account.username}`,
          ]
        : []),
      containerName(exec.vmId),
      'sh',
      '-c',
      READ_IDENTITY + (v2 ? READ_ACCOUNT : ''),
    ]
    const { stdout } = await run('docker', argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      ...(env ? { env } : {}),
    })
    const fields = stdout.split('\0')
    const count = v2 ? 12 : 9
    if (fields.length !== count || fields[count - 1] !== '' || !fields[0] || !fields[3] || !fields[4])
      return fail('guest_identity_invalid', 'Guest returned incomplete identity data')
    const [hostname, os_id, os_pretty, kernel_release, arch, machine_id, timezone, locale] = fields
    const observed = v2 ? JSON.parse(fields[10]) : null
    if (
      v2 &&
      (fields[9] !== spec.os.id ||
        os_id !== spec.os.family ||
        arch !== spec.guest_os.arch ||
        fields[8] !== spec.os.id.slice(spec.os.family.length + 1))
    ) {
      return fail('guest_identity_mismatch', 'Observed OS version or architecture does not match the requested guest')
    }
    if (
      v2 &&
      ((exec.vm.fingerprint?.hostname && hostname !== exec.vm.fingerprint.hostname) ||
        (exec.vm.fingerprint?.guest_machine_id && machine_id !== exec.vm.fingerprint.guest_machine_id))
    ) {
      return fail('guest_identity_mismatch', 'Observed hostname or machine identity does not match the allocated guest')
    }
    if (
      v2 &&
      !(
        observed.username === account.username &&
        observed.user === account.username &&
        observed.logname === account.username &&
        observed.worker_home === account.home &&
        observed.worker_user === account.username &&
        observed.worker_logname === account.username &&
        observed.worker_cwd === account.home &&
        observed.uid === account.uid &&
        observed.worker_euid === account.uid &&
        observed.gid === account.gid &&
        observed.passwd_gid === account.gid &&
        observed.home === account.home &&
        observed.passwd_home === account.home &&
        observed.cwd === account.home &&
        observed.owner_uid === account.uid &&
        observed.owner_gid === account.gid &&
        observed.worker_caps === '0000000000000000' &&
        observed.worker_no_new_privs === 1
      )
    ) {
      return fail(
        'guest_identity_mismatch',
        'Observed passwd, worker euid, HOME or ownership does not match the guest account',
      )
    }
    return {
      ok: true,
      status: 200,
      body: {
        identity: {
          schema_version: '1',
          runtime_kind: 'docker',
          hostname,
          os_id,
          os_pretty,
          kernel_release,
          arch,
          machine_id,
          timezone,
          locale,
          goos: 'linux',
          ...(v2 ? { os_version: fields[8], os_tag: fields[9] } : {}),
          ...(observed ? { observed_account: observed } : {}),
          collected_at: new Date().toISOString(),
        },
      },
    }
  } catch (error) {
    return fail(
      error.killed ? 'guest_identity_timeout' : 'guest_identity_exec_failed',
      String(error.stderr || error.message || error)
        .trim()
        .slice(0, 300),
    )
  }
}
