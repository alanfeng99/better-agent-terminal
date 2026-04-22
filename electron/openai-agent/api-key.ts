import { promises as fs } from 'fs'
import * as path from 'path'
import { app, safeStorage } from 'electron'

let keyFilePath: string | null = null
let cachedKey: string | null = null
let loaded = false

function getKeyFilePath(): string {
  if (keyFilePath) return keyFilePath
  const dir = app?.getPath?.('userData') ?? path.join(process.env.HOME || process.env.USERPROFILE || '.', '.better-agent-terminal')
  keyFilePath = path.join(dir, 'openai-api-key.bin')
  return keyFilePath
}

export async function loadOpenAIKey(): Promise<string | null> {
  if (loaded) return cachedKey
  const p = getKeyFilePath()
  try {
    const buf = await fs.readFile(p)
    if (safeStorage.isEncryptionAvailable()) {
      cachedKey = safeStorage.decryptString(buf)
    } else {
      cachedKey = buf.toString('utf8')
    }
  } catch {
    cachedKey = null
  }
  if (!cachedKey && process.env.OPENAI_API_KEY) {
    cachedKey = process.env.OPENAI_API_KEY
  }
  loaded = true
  return cachedKey
}

export async function setOpenAIKey(key: string): Promise<void> {
  const p = getKeyFilePath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, 'utf8')
  await fs.writeFile(p, payload)
  cachedKey = key
  loaded = true
}

export async function clearOpenAIKey(): Promise<void> {
  const p = getKeyFilePath()
  try { await fs.unlink(p) } catch { /* ignore */ }
  cachedKey = null
  loaded = true
}

export async function hasOpenAIKey(): Promise<boolean> {
  const k = await loadOpenAIKey()
  return !!k && k.length > 0
}
