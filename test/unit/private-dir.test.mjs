import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { privateDirectoriesScript } from '../../src/lib/cluster/remote-fs.mjs'
import { ensureHostPrivateDir } from '../../src/lib/vm/private-dir.mjs'

test('remote private directories are chmodded without following a symlink', () => {
  assert.throws(() => privateDirectoriesScript(['/slot/run/work'], { uid: '1;rm', gid: 1 }))

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-remote-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-target-'))
  try {
    fs.chmodSync(target, 0o755)
    const leaf = path.join(root, "work 'quoted'")
    fs.symlinkSync(target, leaf)
    const owner = { uid: process.getuid(), gid: process.getgid() }
    execFileSync('sh', ['-c', privateDirectoriesScript([leaf], owner)], { stdio: 'pipe' })
    const replaced = fs.lstatSync(leaf)
    assert.equal(replaced.isSymbolicLink(), false)
    assert.equal(replaced.isDirectory(), true)
    assert.equal(replaced.mode & 0o777, 0o700)
    assert.equal(replaced.uid, owner.uid)
    assert.equal(replaced.gid, owner.gid)
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test('remote private directories reject a symlink swapped in before open', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-race-'))
  try {
    const leaf = path.join(root, 'work'),
      target = path.join(root, 'target')
    fs.mkdirSync(leaf)
    fs.mkdirSync(target, { mode: 0o755 })
    // Simulate the guest replacing the leaf between lstat and the protected open.
    fs.writeFileSync(
      path.join(root, 'sitecustomize.py'),
      [
        'import os',
        'original_open = os.open',
        'def swap_open(path, flags, *args, **kwargs):',
        '    if path == os.environ["TEST_PRIVATE_LEAF"]:',
        '        os.rmdir(path)',
        '        os.symlink(os.environ["TEST_PRIVATE_TARGET"], path)',
        '    return original_open(path, flags, *args, **kwargs)',
        'os.open = swap_open',
      ].join('\n'),
    )
    assert.throws(() =>
      execFileSync('sh', ['-c', privateDirectoriesScript([leaf])], {
        stdio: 'pipe',
        env: { ...process.env, PYTHONPATH: root, TEST_PRIVATE_LEAF: leaf, TEST_PRIVATE_TARGET: target },
      }),
    )
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local private directory creation does not chmod the symlink target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-local-'))
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-private-local-target-'))
  try {
    fs.chmodSync(target, 0o755)
    const leaf = path.join(root, 'crag-native-assets')
    fs.symlinkSync(target, leaf)
    ensureHostPrivateDir(leaf)
    const replaced = fs.lstatSync(leaf)
    assert.equal(replaced.isSymbolicLink(), false)
    assert.equal(replaced.isDirectory(), true)
    assert.equal(replaced.mode & 0o777, 0o700)
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(target, { recursive: true, force: true })
  }
})
