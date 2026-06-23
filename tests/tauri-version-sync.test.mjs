import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const cargoToml = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
const cargoPackageSection = cargoToml
  .split(/\r?\n(?=\[)/)
  .find((section) => section.startsWith('[package]\n') || section.startsWith('[package]\r\n'))

assert.equal(
  tauriConfig.version,
  packageJson.version,
  'src-tauri/tauri.conf.json version must match package.json',
)

assert.equal(
  packageJson.version,
  '0.0.1-dev',
  'checked-in package.json version must stay at the local development version; CI injects release versions from tags',
)

assert.equal(
  tauriConfig.identifier,
  'org.tonyq.better-agent-terminal',
  'Tauri bundle identifier must stay aligned with the original app bundle id',
)

assert.equal(
  tauriConfig.mainBinaryName,
  'BetterAgentTerminal',
  'Tauri packaged GUI binary must overwrite the legacy Electron executable',
)

assert.ok(cargoPackageSection, 'Cargo.toml must contain a [package] section')
assert.match(
  cargoPackageSection,
  /^default-run = "better-agent-terminal"$/m,
  'Cargo default-run must point at the GUI binary, not auxiliary CLI binaries',
)

console.log('tauri-version-sync: passed')
