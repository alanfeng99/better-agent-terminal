import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  collectBaseClosure,
  parseCargoLock,
  RUST_BASE_CACHE_ROOTS,
} from '../scripts/rust-base-cache-key.mjs'

const execFileAsync = promisify(execFile)

const sampleLock = `
version = 4

[[package]]
name = "tauri"
version = "2.11.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "a"
dependencies = [
 "serde",
 "wry",
]

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "b"

[[package]]
name = "wry"
version = "0.55.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "c"
dependencies = [
 "serde",
]
`

const packages = parseCargoLock(sampleLock)
const closure = collectBaseClosure(packages, ['tauri'])
assert.deepEqual(closure.map((pkg) => pkg.name), ['serde', 'tauri', 'wry'])

const crlfPackages = parseCargoLock(sampleLock.replace(/\n/g, '\r\n'))
assert.deepEqual(
  collectBaseClosure(crlfPackages, ['tauri']).map((pkg) => pkg.name),
  ['serde', 'tauri', 'wry'],
)
assert.ok(RUST_BASE_CACHE_ROOTS.includes('tauri'))
assert.ok(RUST_BASE_CACHE_ROOTS.includes('reqwest@0.12.28'))

const { stdout } = await execFileAsync(process.execPath, ['scripts/rust-base-cache-key.mjs'])
const output = Object.fromEntries(
  stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('=')),
)

assert.match(output.base, /^[a-f0-9]{24}$/)
assert.ok(Number(output.packages) > RUST_BASE_CACHE_ROOTS.length)
assert.ok(output.roots.includes('tauri'))

console.log('rust-base-cache-key: passed')
