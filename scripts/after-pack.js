const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

function normalizeArch(arch) {
  if (arch === 1 || arch === 'x64') return 'x64'
  if (arch === 3 || arch === 'arm64') return 'arm64'
  const value = String(arch || '').toLowerCase()
  if (value.includes('x64')) return 'x64'
  if (value.includes('arm64')) return 'arm64'
  return process.arch
}

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = fs.readdirSync(context.appOutDir).find(name => name.endsWith('.app'))
    if (!appName) throw new Error(`No .app bundle found in ${context.appOutDir}`)
    return path.join(context.appOutDir, appName, 'Contents', 'Resources')
  }
  return path.join(context.appOutDir, 'resources')
}

function resolveFromPackage(packageName, spec) {
  let entry
  try {
    entry = require.resolve(`${packageName}/package.json`)
  } catch {
    entry = require.resolve(packageName)
  }
  return createRequire(entry).resolve(spec)
}

function copyPackageForTarget(packageName, platformPackage, binaryName, targetRoot) {
  const binaryPath = resolveFromPackage(packageName, `${platformPackage}/${binaryName}`)
  const packageRoot = path.dirname(binaryPath)
  const targetDir = path.join(targetRoot, platformPackage.replace('@anthropic-ai/', ''))
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.cpSync(packageRoot, targetDir, { recursive: true, dereference: true })
  const targetBinary = path.join(targetDir, binaryName)
  if (!fs.existsSync(targetBinary)) {
    throw new Error(`Failed to copy ${platformPackage}/${binaryName} to ${targetBinary}`)
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(targetBinary, 0o755)
  }
  console.log(`[afterPack] copied ${platformPackage}/${binaryName} -> ${targetBinary}`)
}

exports.default = async function afterPack(context) {
  const arch = normalizeArch(context.arch)
  const platform = context.electronPlatformName
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'
  const targetRoot = path.join(resourcesDir(context), 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
  fs.mkdirSync(targetRoot, { recursive: true })

  copyPackageForTarget(
    '@anthropic-ai/claude-code',
    `@anthropic-ai/claude-code-${platform}-${arch}`,
    binaryName,
    targetRoot
  )
  copyPackageForTarget(
    '@anthropic-ai/claude-agent-sdk',
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    binaryName,
    targetRoot
  )
}
