#!/usr/bin/env node
/** Actual Linux account, native CLI/kernel and restart smoke; never certifies an OS for inference. */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectLinuxAmd64Elf } from '../src/lib/vm/wrap-cli-runtime.mjs'
import { readGuestIdentity } from '../src/lib/vm/guest-identity-reader.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--image', '--os', '--product'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('Usage: kin-os-smoke.mjs --image <tag> [--os <OS id>] [--product <wrap-cli directory>]')
  }
  options[args[i].slice(2)] = args[i + 1]
}
if (!options.image) throw new Error('--image is required')
const product = path.resolve(options.product || path.join(root, 'share/wrap-cli'))
for (const name of ['cli-node', 'kin-kernel.bin']) {
  const file = path.join(product, name)
  const bytes = Buffer.alloc(64)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, bytes, 0, bytes.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (!inspectLinuxAmd64Elf(bytes).ok) throw new Error(`${name} is not a Linux amd64 ELF`)
}
if (!fs.existsSync(path.join(product, 'kin-kernel'))) throw new Error('Real kernel launcher is missing')
function docker(argv, timeout = 30000) {
  return execFileSync('docker', argv, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }).trim()
}
const info = JSON.parse(docker(['image', 'inspect', options.image]))[0]
if (info.Os !== 'linux' || info.Architecture !== 'amd64') throw new Error('Image is not linux/amd64')
const labels = info.Config.Labels || {}
if (labels['org.vm2api.artifact'] && labels['org.vm2api.artifact'] !== 'linux-userland-image')
  throw new Error('VM launchers/disks are not Linux userland images')
const v2 = labels['org.vm2api.account-contract'] === 'linux-account-v2'
const token = crypto.randomUUID()
const name = `kin-image-smoke-${token}`
const volume = `${name}-home`
const account = v2
  ? { name: 'guest_smoke', uid: crypto.randomInt(20000, 60000), gid: 0, home: '/home/guest_smoke' }
  : { name: 'kincli', uid: 999, gid: 987, home: '/home/kincli' }
if (v2) account.gid = account.uid
const env = ['-e', `HOME=${account.home}`, '-e', `USER=${account.name}`, '-e', `LOGNAME=${account.name}`]
const nativeScript = `set -eu
command -v curl >/dev/null
command -v git >/dev/null
command -v bash >/dev/null
command -v ps >/dev/null
command -v setpriv >/dev/null
python3 - <<'PY'
import os,pwd,json
p=pwd.getpwuid(os.geteuid()); h=os.environ['HOME']; s=os.stat(h)
assert os.geteuid()==${account.uid} and os.getegid()==${account.gid}
assert p.pw_name==os.environ['USER']==os.environ['LOGNAME']=='${account.name}'
assert p.pw_dir==h==os.getcwd()=='${account.home}'
assert (s.st_uid,s.st_gid)==(${account.uid},${account.gid})
status=dict(l.rstrip().split(':',1) for l in open('/proc/1/status') if ':' in l)
assert int(status['Uid'].split()[1])==${account.uid}
assert int(status['CapEff'].strip(),16)==0 and int(status['NoNewPrivs'])==1
print(json.dumps({'account':p.pw_name,'euid':os.geteuid(),'home':h,'owner':[s.st_uid,s.st_gid],'pid1_caps':status['CapEff'].strip()}))
PY
version=$(/opt/kin-smoke/cli-node --version)
mkdir -p /tmp/kin-native-smoke "$HOME/.claude"
python3 - <<'PY'
import json
json.dump({'vm_id':'linux-image-smoke','socket_path':'/tmp/kin-native-smoke/kernel.sock','credential_path':'${account.home}/.claude/nonexistent-smoke-credential.json','internal_token':'disposable-local-token','proxy_required':False,'provider':'local_cli','claude_bin':'/opt/kin-smoke/cli-node','slots_per_worker':1},open('/tmp/kin-native-smoke/kernel.json','w'))
PY
/opt/kin-smoke/kin-kernel --gateway-worker --config /tmp/kin-native-smoke/kernel.json >/tmp/kin-native-smoke/kernel.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
for i in $(seq 1 40); do
  kill -0 "$pid" 2>/dev/null || { cat /tmp/kin-native-smoke/kernel.log >&2; exit 1; }
  curl -fsS --unix-socket /tmp/kin-native-smoke/kernel.sock -H 'X-Kin-Internal-Token: disposable-local-token' http://localhost/internal/health >/tmp/kin-native-smoke/health.json 2>/dev/null || true
  if python3 - <<'PY'
import json
try:
 h=json.load(open('/tmp/kin-native-smoke/health.json'))
 assert h['engine']=='rust' and h['provider']=='local_cli' and h['cli_pid']>0 and h['ready_slots']>0
except (OSError,ValueError,KeyError,AssertionError,TypeError): raise SystemExit(1)
PY
  then break; fi
  sleep 1
done
python3 - <<'PY'
import json
h=json.load(open('/tmp/kin-native-smoke/health.json'))
assert h['engine']=='rust' and h['provider']=='local_cli' and h['cli_pid']>0 and h['ready_slots']>0,h
assert h['credential_state']=='missing',h
print(json.dumps({'native_kernel':h['version'],'cli_pid':h['cli_pid'],'ready_slots':h['ready_slots'],'credential_state':h['credential_state']}))
PY
printf 'cli_version=%s\\n' "$version"
cat /etc/kin-os
printf 'persistent-smoke' > "$HOME/.kin-image-smoke-marker"
`
let created = false
let volumeCreated = false
try {
  docker(['volume', 'create', '--label', `org.vm2api.smoke=${token}`, volume])
  volumeCreated = true
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    `org.vm2api.smoke=${token}`,
    '--network',
    'none',
    '--read-only',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=128m',
    '--mount',
    `type=volume,source=${volume},target=${account.home}`,
    '--mount',
    `type=bind,source=${product},target=/opt/kin-smoke,readonly`,
    ...env,
    ...(v2
      ? [
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'SETUID',
          '--cap-add',
          'SETGID',
          '--tmpfs',
          '/run/kin-account:rw,nosuid,noexec,mode=0700',
          '-e',
          `KIN_GUEST_USERNAME=${account.name}`,
          '-e',
          `KIN_GUEST_UID=${account.uid}`,
          '-e',
          `KIN_GUEST_GID=${account.gid}`,
          '-e',
          `KIN_GUEST_HOME=${account.home}`,
        ]
      : ['--user', `${account.uid}:${account.gid}`]),
    options.image,
    'sleep',
    'infinity',
  ])
  created = true
  const exec = ['exec', '-u', `${account.uid}:${account.gid}`, '-w', account.home, name]
  const first = docker([...exec, 'bash', '-c', nativeScript], 90000)
  const actualOs = docker([...exec, 'cat', '/etc/kin-os'])
  if (options.os && actualOs !== options.os) throw new Error('Observed guest OS does not match requested OS')
  const vm = {
    id: `image-smoke-${token}`,
    kernel: actualOs,
    runtime: { type: 'docker', provider: 'docker-linux' },
    ...(v2
      ? {
          guest_user: {
            contract: 'linux-account-v2',
            username: account.name,
            uid: account.uid,
            gid: account.gid,
            home: account.home,
          },
        }
      : {}),
  }
  const observed = await readGuestIdentity({ vmId: vm.id, vm })
  if (!observed.ok) throw new Error(JSON.stringify(observed.body.error))
  docker(['restart', name])
  const after = docker([
    ...exec,
    'python3',
    '-c',
    `import os,pwd; p=pwd.getpwuid(os.geteuid()); assert p.pw_name=='${account.name}' and p.pw_dir=='${account.home}'; assert open(os.environ['HOME']+'/.kin-image-smoke-marker').read()=='persistent-smoke'; print('restart_identity_and_home=stable')`,
  ])
  process.stdout.write(
    JSON.stringify({
      ok: true,
      support: 'unchanged',
      image: options.image,
      imageId: info.Id,
      os: actualOs,
      baseDigest: labels['org.vm2api.base-digest'] || '',
      accountContract: v2 ? 'linux-account-v2' : 'legacy',
      collectorProof: observed.body.identity,
      account,
      nativeProof: first,
      restartProof: after,
    }) + '\n',
  )
} finally {
  // Exact names plus unguessable ownership labels; never remove another slot or volume.
  if (created) {
    const own = JSON.parse(docker(['inspect', name]))[0].Config.Labels?.['org.vm2api.smoke']
    if (own !== token) throw new Error('Smoke container ownership mismatch; refusing deletion')
    docker(['rm', '-f', name])
  }
  if (volumeCreated) {
    const own = JSON.parse(docker(['volume', 'inspect', volume]))[0].Labels?.['org.vm2api.smoke']
    if (own !== token) throw new Error('Smoke volume ownership mismatch; refusing deletion')
    docker(['volume', 'rm', volume])
  }
}
