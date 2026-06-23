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

function findFiles(root, predicate, maxDepth = 20) {
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
      const fullPath = path.join(current, entry.name)
      if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath)
      } else if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
      }
    }
  }
  walk(root, 0)
  return results
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
  const codexPackage = `codex-${platform}-${targetArch}`
  const codexNativePrefix = `codex-${platform}-`
  const nativeBinary = platform === 'win32' ? 'claude.exe' : 'claude'
  const codexBinary = platform === 'win32' ? 'codex.exe' : 'codex'

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

    const agentSdkNativeFiles = findFiles(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.includes('/node_modules/@anthropic-ai/claude-agent-sdk-') &&
        normalized.endsWith(`/${nativeBinary}`)
    })

    const nonTargetClaudeCodeFiles = findFiles(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.includes('/node_modules/@anthropic-ai/claude-code-') &&
        !normalized.includes(`/node_modules/@anthropic-ai/${claudeCodePackage}/`) &&
        normalized.endsWith(`/${nativeBinary}`)
    })

    const codex = findFile(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.endsWith(`/codex-runtime/${codexBinary}`)
    })

    const nonTargetCodexFiles = findFiles(unpackedDir, filePath => {
      const normalized = toPosix(filePath)
      return normalized.includes(`/node_modules/@openai/${codexNativePrefix}`) &&
        !normalized.includes(`/node_modules/@openai/${codexPackage}/`) &&
        normalized.endsWith(`/${codexBinary}`)
    })

    if (agentSdkNativeFiles.length > 0) {
      throw new Error(
        `Packaged Agent SDK native binaries should not be bundled; pass pathToClaudeCodeExecutable instead.\n` +
        agentSdkNativeFiles.map(filePath => `  - ${filePath}`).join('\n')
      )
    }

    if (nonTargetClaudeCodeFiles.length > 0) {
      throw new Error(
        `Packaged Claude Code contains non-target native binaries for ${platform}-${targetArch}.\n` +
        nonTargetClaudeCodeFiles.map(filePath => `  - ${filePath}`).join('\n')
      )
    }

    if (nonTargetCodexFiles.length > 0) {
      throw new Error(
        `Packaged Codex contains non-target native binaries for ${platform}-${targetArch}.\n` +
        nonTargetCodexFiles.map(filePath => `  - ${filePath}`).join('\n')
      )
    }

    if (claudeCode && codex) {
      assertExecutable(claudeCode)
      assertExecutable(codex)
      results.push({ unpackedDir, claudeCode, codex })
    }
  }

  if (results.length === 0) {
    const searched = unpackedDirs.map(dir => `  - ${dir}`).join('\n')
    throw new Error(
      `Missing packaged Claude binaries for ${platform}-${targetArch}.\n` +
      `Expected Claude Code CLI: node_modules/@anthropic-ai/${claudeCodePackage}/${nativeBinary}\n` +
      `Expected Codex CLI: codex-runtime/${codexBinary}\n` +
      `Searched app.asar.unpacked directories:\n${searched}`
    )
  }

  for (const result of results) {
    console.log(`Verified Claude Code CLI: ${result.claudeCode}`)
    console.log(`Verified Codex CLI: ${result.codex}`)
    console.log('Verified Agent SDK native binaries are not bundled')
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
