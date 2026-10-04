import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { osForId } from '../src/lib/vm/os-catalog.mjs'

const { values } = parseArgs({
  options: { os: { type: 'string' }, vulnerabilities: { type: 'string' }, licenses: { type: 'string' } },
})
try {
  if (!values.os) throw Object.assign(new Error('An explicit guest OS is required'), { code: 'guest_scan_invalid' })
  const os = osForId(values.os)
  const vulnerabilities = JSON.parse(fs.readFileSync(values.vulnerabilities, 'utf8'))
  const licenses = JSON.parse(fs.readFileSync(values.licenses, 'utf8'))
  const distro = vulnerabilities.distro
  const providers = vulnerabilities.descriptor?.db?.providers
  const release = os.family === 'debian' ? String(distro?.version).split('.')[0] : String(distro?.version)
  if (
    distro?.name !== os.family ||
    !providers?.[os.family] ||
    (os.id !== 'archlinux' && release !== os.id.split('-').at(-1))
  ) {
    throw Object.assign(new Error('Scanner has no verified vendor feed for this guest distribution'), {
      code: 'guest_scan_unsupported',
    })
  }
  if (!vulnerabilities.descriptor.db.status.valid || !Array.isArray(vulnerabilities.matches)) {
    throw Object.assign(new Error('Vulnerability database or report is invalid'), { code: 'guest_scan_invalid' })
  }
  const inventory = (licenses.Results || []).flatMap((result) => result.Licenses || [])
  if (licenses.Metadata?.OS?.Family !== os.family || inventory.length === 0) {
    throw Object.assign(new Error('Guest license inventory is unavailable'), {
      code: 'guest_license_inventory_missing',
    })
  }
  const layers = vulnerabilities.source?.target?.layers?.map((layer) => layer.digest)
  const diffIds = licenses.Metadata?.ImageConfig?.rootfs?.diff_ids
  if (!layers?.length || JSON.stringify(layers) !== JSON.stringify(diffIds)) {
    throw Object.assign(new Error('Vulnerability and license reports describe different filesystem layers'), {
      code: 'guest_scan_image_mismatch',
    })
  }
  const blocking = vulnerabilities.matches.filter((match) =>
    ['High', 'Critical'].includes(match.vulnerability?.severity),
  )
  console.log(
    JSON.stringify({
      os: values.os,
      distro,
      vendorFeed: os.family,
      vulnerabilities: vulnerabilities.matches.length,
      blockingVulnerabilities: blocking.length,
      licenseFindings: inventory.length,
      licenseApproval: 'not_provided',
    }),
  )
  if (blocking.length) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'guest_scan_invalid', error: error.message }))
  process.exitCode = 1
}
