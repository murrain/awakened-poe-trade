import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const prev = pkg.version
const parts = prev.split('.')
parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
const next = parts.join('.')

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`version bumped: ${prev} → ${next}`)
