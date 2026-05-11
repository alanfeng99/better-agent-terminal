// Cert generation for the remote WebSocket server, ported from
// electron/remote/certificate.ts.
//
// `ensureCertificate(configDir)` — load a previously-generated cert
// from `<configDir>/server-cert.enc.json` (written via remote-secrets'
// {enc:false} envelope; the field name keeps `.enc.json` for forward
// compatibility once we add a real keychain), or generate a fresh
// 10-year self-signed cert with localhost / 127.0.0.1 / ::1 SAN
// entries. Fingerprint is derived from the cert PEM each time so it
// can never drift.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import { readEncryptedJson, writeEncryptedJson } from './remote-secrets.mjs'
import { computeFingerprint } from './remote-fingerprint.mjs'

const CERT_FILE = 'server-cert.enc.json'
const DEFAULT_VALIDITY_DAYS = 3650 // 10 years — self-signed, user controls trust via pin

async function generate() {
  const attrs = [{ name: 'commonName', value: 'better-agent-terminal' }]
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: DEFAULT_VALIDITY_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        keyCertSign: false,
        digitalSignature: true,
        keyEncipherment: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  })
  return { cert: pems.cert, privateKey: pems.private, createdAt: Date.now() }
}

export async function ensureCertificate(configDir) {
  if (typeof configDir !== 'string' || !configDir) {
    throw new Error('ensureCertificate: configDir must be a non-empty string')
  }
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }
  const certPath = join(configDir, CERT_FILE)
  let stored = readEncryptedJson(certPath)
  if (!stored || typeof stored !== 'object' || typeof stored.cert !== 'string' || typeof stored.privateKey !== 'string') {
    stored = await generate()
    try {
      writeEncryptedJson(certPath, stored)
    } catch (err) {
      // Persist failure is non-fatal — we can still serve TLS this run,
      // we'll just regenerate next launch. Log so it's visible.
      // eslint-disable-next-line no-console
      console.warn('[remote-certificate] failed to persist cert:', err?.message ?? err)
    }
  }
  return {
    cert: stored.cert,
    privateKey: stored.privateKey,
    fingerprint256: computeFingerprint(stored.cert),
  }
}

// Test seam — lets the test suite force a fresh generate() on next
// ensureCertificate(configDir) call without cleaning up on disk.
export const __certFileNameForTests = CERT_FILE
