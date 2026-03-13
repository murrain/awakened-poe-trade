import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const prev = pkg.version
const parts = prev.split('.')
const patch = Number(parts[parts.length - 1])
if (!Number.isInteger(patch) || patch < 0) {
  console.error(`bump-version: cannot parse patch segment "${parts[parts.length - 1]}" in version "${prev}"`)
  process.exit(1)
}
parts[parts.length - 1] = String(patch + 1)
const next = parts.join('.')

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`version bumped: ${prev} → ${next}`)
