import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runKinOsBuild } from '../../docker/kin-os/build.mjs'

const DIGEST = `sha256:${'ab'.repeat(32)}`

function catalog() {
  return {
    'ubuntu-24.04': {
      image: 'example/kin-os-ubuntu:24.04',
      family: 'ubuntu',
      dir: 'ubuntu-24.04',
      artifactKind: 'linux-userland-image',
      support: 'supported',
    },
    'fedora-41': {
      image: 'example/kin-os-fedora:41',
      family: 'fedora',
      dir: 'fedora-41',
      artifactKind: 'linux-userland-image',
    },
    'debian-13': {
      image: 'example/kin-os-debian:13',
      family: 'debian',
      dir: 'debian-13',
      artifactKind: 'linux-userland-image',
      support: 'candidate',
      baseDigest: DIGEST,
    },
    'macos-15': {
      family: 'macos',
      artifactKind: 'macos-launcher',
      provider: 'docker-qemu',
      support: 'unsupported',
    },
    'debian-disk': {
      family: 'debian',
      artifactKind: 'linux-vm-disk',
      provider: 'libvirt',
      support: 'candidate',
    },
  }
}

function layout(entries = catalog()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-os-build-'))
  for (const meta of Object.values(entries)) {
    if (!meta.dir) continue
    const dir = path.join(root, meta.dir)
    fs.mkdirSync(dir, { recursive: true })
    const pin = meta.baseDigest ? `@${meta.baseDigest}` : ''
    fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM example/base${pin}\n`)
  }
  return root
}

function fake(root, script) {
  const file = path.join(root, 'docker-fake')
  fs.writeFileSync(file, script, { mode: 0o755 })
  return file
}

async function run(argv, root, script, extra = {}) {
  return await runKinOsBuild(argv, {
    catalog: extra.catalog || catalog(),
    root,
    command: fake(root, script),
    silent: true,
    stdio: 'ignore',
    timeouts: extra.timeouts,
  })
}

function satisfied(label = '', arch = 'amd64') {
  return JSON.stringify([
    {
      Os: 'linux',
      Architecture: arch,
      Id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      RepoDigests: [],
      Config: { Labels: label ? { 'org.vm2api.base-digest': label } : {} },
    },
  ])
}

test('unknown selector and unknown flag fail before Docker', async () => {
  const root = layout()
  const command = fake(root, '#!/bin/sh\nexit 99\n')
  const missing = await runKinOsBuild(['windows-11'], {
    catalog: catalog(),
    root,
    command,
    silent: true,
    stdio: 'ignore',
  })
  assert.equal(missing.code, 2)
  assert.equal(JSON.parse(missing.stderr).code, 'unknown_selector')
  const flag = await runKinOsBuild(['--build'], {
    catalog: catalog(),
    root,
    command,
    silent: true,
    stdio: 'ignore',
  })
  assert.equal(flag.code, 2)
  assert.equal(JSON.parse(flag.stderr).code, 'unknown_flag')
})

test('explicit macOS launcher and VM disk selections fail with an action', async () => {
  const root = layout()
  const script = '#!/bin/sh\nexit 99\n'
  for (const selector of ['macos-15', 'macos-launcher', 'docker-qemu', 'debian-disk', 'linux-vm-disk']) {
    const result = await run([selector], root, script)
    assert.equal(result.code, 2, selector)
    const body = JSON.parse(result.stderr)
    assert.equal(body.code, 'artifact_not_linux_image')
    assert.match(body.action, /Apple system or recovery disks/)
  }
})

test('family selector builds only Linux images and still rejects an explicit disk', async () => {
  const root = layout()
  const marker = path.join(root, 'built')
  const script = `#!/bin/sh
if [ "$1" = "image" ] || [ "$1" = "pull" ]; then exit 1; fi
if [ "$1" = "build" ]; then echo built >> ${JSON.stringify(marker)}; exit 0; fi
exit 99
`
  const result = await run(['debian'], root, script)
  assert.equal(result.code, 0)
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1)
})

test('pull-only returns without building unavailable candidate images', async () => {
  const root = layout()
  const script = `#!/bin/sh
if [ "$1" = "image" ] || [ "$1" = "pull" ]; then exit 1; fi
exit 99
`
  const candidate = await run(['--pull-only', 'debian-13'], root, script)
  assert.equal(candidate.code, 0)
})

test('--pull skips the build when the pulled image satisfies the pin', async () => {
  const root = layout()
  const count = path.join(root, 'inspects')
  const result = await run(
    ['--pull', 'fedora'],
    root,
    `#!/bin/sh
if [ "$1" = image ]; then
n=0
if [ -f ${JSON.stringify(count)} ]; then n=$(wc -l < ${JSON.stringify(count)} | tr -d ' '); fi
echo x >> ${JSON.stringify(count)}
if [ "$n" = 0 ]; then exit 1; fi
cat <<'EOF'
${satisfied('')}
EOF
exit 0
fi
if [ "$1" = pull ]; then exit 0; fi
exit 99
`,
  )
  assert.equal(result.code, 0)
})

test('a satisfied pinned image is kept unless --force requests a build', async () => {
  const root = layout()
  const marker = path.join(root, 'built')
  const script = `#!/bin/sh
if [ "$1" = "image" ]; then
cat <<'EOF'
${satisfied(DIGEST)}
EOF
exit 0
fi
if [ "$1" = "build" ]; then echo built >> ${JSON.stringify(marker)}; exit 0; fi
exit 99
`
  const kept = await run(['debian-13'], root, script)
  assert.equal(kept.code, 0)
  assert.equal(kept.stdout.includes('skip existing example/kin-os-debian:13'), true)
  assert.equal(fs.existsSync(marker), false)
  const forced = await run(['--force', 'debian-13'], root, script)
  assert.equal(forced.code, 0)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'built')
})

test('wrong platform or base digest does not count as the pinned image', async () => {
  const root = layout()
  const marker = path.join(root, 'built')
  const scriptFor = (body) => `#!/bin/sh
if [ "$1" = "image" ]; then
cat <<'EOF'
${body}
EOF
exit 0
fi
if [ "$1" = "pull" ]; then exit 1; fi
if [ "$1" = "build" ]; then echo built >> ${JSON.stringify(marker)}; exit 0; fi
exit 99
`
  const wrongArch = await run(['debian-13'], root, scriptFor(satisfied(DIGEST, 'arm64')))
  assert.equal(wrongArch.code, 0)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'built')
  fs.rmSync(marker)
  const wrongDigest = await run(['debian-13'], root, scriptFor(satisfied(`sha256:${'cd'.repeat(32)}`)))
  assert.equal(wrongDigest.code, 0)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'built')
})

test('inspect timeout and signal are returned from the Docker process', async () => {
  const root = layout()
  const timed = await run(['ubuntu-24.04'], root, '#!/bin/sh\nsleep 5\n', { timeouts: { inspect: 200 } })
  assert.equal(timed.code, 124)
  assert.equal(JSON.parse(timed.stderr).code, 'timeout')
  assert.equal(JSON.parse(timed.stderr).op, 'inspect')
  const signaled = await run(['ubuntu-24.04'], root, '#!/bin/sh\nkill -9 $$\n')
  assert.equal(signaled.code, 137)
  assert.equal(JSON.parse(signaled.stderr).code, 'signal')
  assert.equal(JSON.parse(signaled.stderr).signal, 'SIGKILL')
})

test('a build failure keeps the Docker status', async () => {
  const root = layout()
  const result = await run(
    ['fedora-41'],
    root,
    `#!/bin/sh
if [ "$1" = "image" ] || [ "$1" = "pull" ]; then exit 1; fi
if [ "$1" = "build" ]; then exit 7; fi
exit 99
`,
  )
  assert.equal(result.code, 7)
  assert.equal(JSON.parse(result.stderr).code, 'docker_failed')
})

test('a build context outside docker/kin-os is rejected', async () => {
  const root = layout()
  const entries = catalog()
  entries['ubuntu-24.04'].buildContext = '../outside'
  const result = await run(['ubuntu-24.04'], root, '#!/bin/sh\nexit 99\n', { catalog: entries })
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stderr).code, 'build_context_escapes')
})
