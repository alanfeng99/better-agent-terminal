// Secret-file persistence for the remote server (port of
// electron/remote/secrets.ts).
//
// Electron's version uses Electron.safeStorage (OS keychain) to encrypt
// at rest and falls back to plaintext on headless Linux. Node-only
// sidecar has no safeStorage equivalent, so we always write the
// `{enc:false, data:<JSON>}` shape — same envelope, never encrypted.
// Files are written with mode 0o600 (owner-only).
//
// Migration: if a future slice adds keytar/node-keytar we'll bump the
// envelope format. Reading an `enc:true` file in this version refuses
// (returns null + warns) since we can't decrypt.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

function warn(...args) {
  // Avoid taking a hard dependency on a logger here — the consumer
  // (server.mjs) has its own console capture, and this file is
  // unit-tested in isolation.
  // eslint-disable-next-line no-console
  console.warn('[remote-secrets]', ...args)
}

export function readEncryptedJson(filePath) {
  if (!existsSync(filePath)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    warn('readEncryptedJson: parse failed', filePath, err?.message ?? err)
    return null
  }
  if (raw && typeof raw === 'object') {
    if (raw.enc === true && typeof raw.data === 'string') {
      // Encrypted by an Electron build. We can't decrypt without
      // safeStorage. Refuse and let the caller regenerate.
      warn('encrypted blob refused — sidecar has no safeStorage; regenerate', filePath)
      return null
    }
    if (raw.enc === false && typeof raw.data === 'string') {
      try {
        return JSON.parse(raw.data)
      } catch (err) {
        warn('readEncryptedJson: inner JSON parse failed', filePath, err?.message ?? err)
        return null
      }
    }
  }
  // Legacy plaintext (object/scalar written before envelope adoption).
  // Return as-is; caller may rewrite via writeEncryptedJson to upgrade.
  return raw
}

export function writeEncryptedJson(filePath, data) {
  const plaintext = JSON.stringify(data)
  const payload = JSON.stringify({ enc: false, data: plaintext })
  writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600 })
}

export function readEncryptedString(filePath) {
  const obj = readEncryptedJson(filePath)
  if (obj == null) return null
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object' && typeof obj.value === 'string') return obj.value
  return null
}

export function writeEncryptedString(filePath, value) {
  writeEncryptedJson(filePath, { value })
}
