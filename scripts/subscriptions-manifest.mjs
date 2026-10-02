import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.cwd()
const files = {}
function scan(relative) {
  const file = path.join(root, relative)
  if (fs.statSync(file).isDirectory())
    for (const child of fs.readdirSync(file).sort()) scan(path.posix.join(relative, child))
  else files[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
for (const file of [
  'package-lock.json',
  'VERSION',
  'image-bin',
  'image-wrap-cli',
  'web/dist',
  'src/lib/db/custom-migrations',
])
  scan(file)
fs.writeFileSync(
  'release-manifest.json',
  JSON.stringify(
    {
      revision: process.argv[2],
      upstreamVersion: fs.readFileSync('VERSION', 'utf8').trim(),
      node: process.version,
      files,
    },
    null,
    2,
  ) + '\n',
)
