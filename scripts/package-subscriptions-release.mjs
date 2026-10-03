import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const out = path.resolve(process.argv[2] || '.tmp/subscriptions-v6.tar.gz')
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  throw new Error('Commit and validate the release before packaging')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
fs.mkdirSync(path.dirname(out), { recursive: true })
execFileSync('git', [
  'archive',
  '--format=tar.gz',
  '-o',
  out,
  'HEAD',
  'src',
  'scripts',
  'worker',
  'test',
  'bin',
  'share/wrap-cli',
  'docker/kin-os',
  'web/dist',
  'deploy',
  'package.json',
  'package-lock.json',
  'VERSION',
  'CHANGELOG.md',
  '.dockerignore',
])
fs.writeFileSync(out + '.revision', revision + '\n')
console.log(JSON.stringify({ archive: out, revision, bytes: fs.statSync(out).size }))
