#!/usr/bin/env node

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    windowsHide: false,
    ...options,
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
  child.on('error', err => {
    console.error(`bat-server: failed to launch ${command}: ${err.message}`)
    process.exit(1)
  })
}

function runServerCli(argv = process.argv.slice(2), options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..')
  const isWin = process.platform === 'win32'
  const exe = isWin ? '.exe' : ''

  const explicit = process.env.BAT_SERVER_BIN
  if (explicit) {
    run(explicit, argv)
    return
  }

  const standaloneCandidates = [
    path.join(repoRoot, 'src-tauri', 'target', 'debug', `bat-server${exe}`),
    path.join(repoRoot, 'src-tauri', 'target', 'release', `bat-server${exe}`),
  ]
  for (const candidate of standaloneCandidates) {
    if (isFile(candidate)) {
      run(candidate, argv)
      return
    }
  }

  const appCandidates = [
    path.join(repoRoot, 'src-tauri', 'target', 'debug', `better-agent-terminal${exe}`),
    path.join(repoRoot, 'src-tauri', 'target', 'release', `better-agent-terminal${exe}`),
  ]
  for (const candidate of appCandidates) {
    if (isFile(candidate)) {
      run(candidate, ['--bat-server', ...argv])
      return
    }
  }

  const manifest = path.join(repoRoot, 'src-tauri', 'Cargo.toml')
  if (isFile(manifest)) {
    run('cargo', ['run', '--manifest-path', manifest, '--bin', 'bat-server', '--', ...argv], {
      cwd: repoRoot,
    })
    return
  }

  console.error('bat-server: could not find a BAT Rust binary or src-tauri/Cargo.toml')
  console.error('bat-server: set BAT_SERVER_BIN=/path/to/bat-server to choose a binary explicitly')
  process.exit(1)
}

module.exports = { runServerCli }

if (require.main === module) runServerCli()
