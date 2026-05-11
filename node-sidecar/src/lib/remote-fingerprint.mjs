// Cert-fingerprint helpers, ported from electron/remote/certificate.ts.
//
// Cert generation itself (the `selfsigned` npm dep + ensureCertificate)
// lands in a follow-up slice — this module covers only the pure crypto
// helpers so the remote client / server / pin-comparison code paths
// can already use them.
//
//   computeFingerprint(certPem)  — SHA-256 of the DER-encoded cert,
//                                  formatted "AB:CD:EF:..." uppercase
//                                  hex with colons. Standard X.509
//                                  fingerprint format that browsers
//                                  display.
//   normalizeFingerprint(fp)     — strips colons/whitespace,
//                                  uppercases — for safe equality
//                                  comparison regardless of how the
//                                  user pasted the pin.

import { createHash } from 'node:crypto'

export function computeFingerprint(certPem) {
  if (typeof certPem !== 'string' || certPem.length === 0) {
    throw new Error('computeFingerprint: certPem must be a non-empty PEM string')
  }
  const stripped = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '')
  if (stripped.length === 0) {
    throw new Error('computeFingerprint: PEM contained no base64 body')
  }
  const der = Buffer.from(stripped, 'base64')
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase()
  // Group hex bytes with colons. matchAll requires a non-empty match,
  // and SHA-256 always yields 64 chars so this is safe.
  const pairs = hex.match(/.{2}/g)
  return pairs.join(':')
}

// Exported alias matching the Electron public API name.
export const fingerprintOfPem = computeFingerprint

export function normalizeFingerprint(fp) {
  if (typeof fp !== 'string') return ''
  return fp.replace(/[:\s]/g, '').toUpperCase()
}
