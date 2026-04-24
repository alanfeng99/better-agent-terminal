import * as fs from 'fs'
import { logger } from '../logger'
import { getSafeStorage } from '../server-core/safe-storage'

// Read a plaintext or safeStorage-encrypted secret file.
// Files written before safeStorage adoption stored raw JSON — detect via `enc` flag.
export function readEncryptedJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { enc?: boolean; data?: string } & Record<string, unknown>
    if (raw && raw.enc === true && typeof raw.data === 'string') {
      const safeStorage = getSafeStorage()
      if (!safeStorage.isEncryptionAvailable()) {
        logger.error('[secrets] decryption unavailable, cannot read', filePath)
        return null
      }
      const decrypted = safeStorage.decryptString(Buffer.from(raw.data, 'base64'))
      return JSON.parse(decrypted) as T
    }
    if (raw && raw.enc === false && typeof raw.data === 'string') {
      return JSON.parse(raw.data) as T
    }
    // Legacy plaintext — return as-is; caller should rewrite through writeEncryptedJson to upgrade.
    return raw as unknown as T
  } catch (e) {
    logger.warn('[secrets] readEncryptedJson failed:', e)
    return null
  }
}

export function writeEncryptedJson(filePath: string, data: unknown): void {
  const plaintext = JSON.stringify(data)
  const safeStorage = getSafeStorage()
  let payload: string
  if (safeStorage.isEncryptionAvailable()) {
    payload = JSON.stringify({ enc: true, data: safeStorage.encryptString(plaintext).toString('base64') })
  } else {
    // Fallback: same-shape plaintext with enc=false. Better than nothing when running
    // on a headless Linux without a keyring.
    logger.warn('[secrets] safeStorage unavailable, writing plaintext:', filePath)
    payload = JSON.stringify({ enc: false, data: plaintext })
  }
  fs.writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600 })
}

export function readEncryptedString(filePath: string): string | null {
  const obj = readEncryptedJson<{ value?: string } | string>(filePath)
  if (obj == null) return null
  if (typeof obj === 'string') return obj
  if (typeof obj === 'object' && typeof (obj as { value?: string }).value === 'string') {
    return (obj as { value: string }).value
  }
  return null
}

export function writeEncryptedString(filePath: string, value: string): void {
  writeEncryptedJson(filePath, { value })
}
