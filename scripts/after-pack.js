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

function pruneAnthropicNativePackages(targetRoot, platform, arch) {
  let entries
  try {
    entries = fs.readdirSync(targetRoot, { withFileTypes: true })
  } catch {
    return
  }

  const targetClaudeCode = `claude-code-${platform}-${arch}`
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const shouldRemove =
      entry.name.startsWith('claude-agent-sdk-') ||
      (entry.name.startsWith('claude-code-') && entry.name !== targetClaudeCode)
    if (!shouldRemove) continue
    const fullPath = path.join(targetRoot, entry.name)
    fs.rmSync(fullPath, { recursive: true, force: true })
    console.log(`[afterPack] removed unused native package ${entry.name}`)
  }
}

function pruneOpenAINativePackages(resourcesRoot, platform, arch) {
  const targetRoot = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@openai')
  let entries
  try {
    entries = fs.readdirSync(targetRoot, { withFileTypes: true })
  } catch {
    return
  }

  const targetCodex = `codex-${platform}-${arch}`
  const nativePrefix = `codex-${platform}-`
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const shouldRemove = entry.name.startsWith(nativePrefix) && entry.name !== targetCodex
    if (!shouldRemove) continue
    const fullPath = path.join(targetRoot, entry.name)
    fs.rmSync(fullPath, { recursive: true, force: true })
    console.log(`[afterPack] removed unused native package @openai/${entry.name}`)
  }
}

function copyNodePtyPackage(resourcesRoot, platform, arch) {
  const targetPackage = `@lydell/node-pty-${platform}-${arch}`
  const binaryName = platform === 'win32' ? 'conpty.node' : 'pty.node'
  const binaryPath = resolveFromPackage('@lydell/node-pty', `${targetPackage}/${binaryName}`)
  const packageRoot = path.dirname(binaryPath)
  const targetDir = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@lydell', `node-pty-${platform}-${arch}`)
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  fs.cpSync(packageRoot, targetDir, { recursive: true, dereference: true })
  const targetBinary = path.join(targetDir, binaryName)
  if (!fs.existsSync(targetBinary)) {
    throw new Error(`Failed to copy ${targetPackage}/${binaryName} to ${targetBinary}`)
  }
  console.log(`[afterPack] copied ${targetPackage}/${binaryName} -> ${targetBinary}`)
}

exports.default = async function afterPack(context) {
  const arch = normalizeArch(context.arch)
  const platform = context.electronPlatformName
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'
  const resourcesRoot = resourcesDir(context)
  const targetRoot = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
  fs.mkdirSync(targetRoot, { recursive: true })
  pruneAnthropicNativePackages(targetRoot, platform, arch)
  pruneOpenAINativePackages(resourcesRoot, platform, arch)
  copyNodePtyPackage(resourcesRoot, platform, arch)

  copyPackageForTarget(
    '@anthropic-ai/claude-code',
    `@anthropic-ai/claude-code-${platform}-${arch}`,
    binaryName,
    targetRoot
  )
  pruneAnthropicNativePackages(targetRoot, platform, arch)
  pruneOpenAINativePackages(resourcesRoot, platform, arch)
  copyNodePtyPackage(resourcesRoot, platform, arch)
}
