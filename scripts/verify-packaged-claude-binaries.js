#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2).filter(arg => arg !== '--')
const releaseDir = path.resolve(args[0] || 'release')

function normalizeArch(value) {
  const arch = String(value || '').toLowerCase()
  if (arch === 'x64' || arch === 'amd64') return 'x64'
  if (arch === 'arm64' || arch === 'aarch64') return 'arm64'
  return process.arch
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function findDirs(root, dirname, maxDepth = 12) {
  const results = []
  function walk(current, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.name === dirname) {
        results.push(fullPath)
      } else {
        walk(fullPath, depth + 1)
      }
    }
  }
  walk(root, 0)
  return results
}

function findFile(root, predicate, maxDepth = 20) {
  function walk(current, depth) {
    if (depth > maxDepth) return null
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isFile() && predicate(fullPath)) return fullPath
      if (entry.isDirectory()) {
        const found = walk(fullPath, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(root, 0)
}

function assertExecutable(filePath) {
  if (process.platform === 'win32') return
  const mode = fs.statSync(filePath).mode
  if ((mode & 0o111) === 0) {
    throw new Error(`Expected executable bit on ${filePath}`)
  }
}

function main() {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory does not exist: ${releaseDir}`)
  }

  const targetArch = normalizeArch(process.env.BAT_TARGET_ARCH)
  const platform = process.platform
  const claudeCodePackage = `claude-code-${platform}-${targetArch}`
  const nativePackage = `claude-agent-sdk-${platform}-${targetArch}`
  const nativeBinary = platform === 'win32' ? 'claude.exe' : 'claude'

  const unpackedDirs = findDirs(releaseDir, 'app.asar.unpacked')
  if (unpackedDirs.length === 0) {
    throw new Error(`No app.asar.unpacked directory found under ${releaseDir}`)
  }

  const results = []
  for (const unpackedDir of unpackedDirs) {
    const claudeCode = findFile(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.endsWith(`/node_modules/@anthropic-ai/${claudeCodePackage}/${nativeBinary}`)
    })

    const agentSdkNative = findFile(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.endsWith(`/node_modules/@anthropic-ai/${nativePackage}/${nativeBinary}`)
    })

    if (claudeCode && agentSdkNative) {
      assertExecutable(claudeCode)
      assertExecutable(agentSdkNative)
      results.push({ unpackedDir, claudeCode, agentSdkNative })
    }
  }

  if (results.length === 0) {
    const searched = unpackedDirs.map(dir => `  - ${dir}`).join('\n')
    throw new Error(
      `Missing packaged Claude binaries for ${platform}-${targetArch}.\n` +
      `Expected Claude Code CLI: node_modules/@anthropic-ai/${claudeCodePackage}/${nativeBinary}\n` +
      `Expected Agent SDK native binary: node_modules/@anthropic-ai/${nativePackage}/${nativeBinary}\n` +
      `Searched app.asar.unpacked directories:\n${searched}`
    )
  }

  for (const result of results) {
    console.log(`Verified Claude Code CLI: ${result.claudeCode}`)
    console.log(`Verified Agent SDK native binary: ${result.agentSdkNative}`)
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
