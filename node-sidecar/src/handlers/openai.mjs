// openai.* handlers for Codex auth fallback key storage.
//
// OpenAI Direct runtime/session support is retired for Tauri. Do not add
// list/compact runtime handlers here; host-api keeps no-op compatibility
// shims for any old renderer callsites.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'

const OPENAI_KEY_FILE = 'openai-api-key.bin'

function openAIKeyPath() {
  return join(resolveDataDir(), OPENAI_KEY_FILE)
}

async function loadCodexOAuthToken() {
  const authPath = join(homedir(), '.codex', 'auth.json')
  try {
    const raw = await readFile(authPath, 'utf-8')
    const auth = JSON.parse(raw)
    const token = auth?.tokens?.access_token
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

async function loadOpenAIKey() {
  try {
    const key = (await readFile(openAIKeyPath(), 'utf-8')).trim()
    if (key) return key
  } catch { /* configured key missing */ }

  const codexToken = await loadCodexOAuthToken()
  if (codexToken) return codexToken

  const envKey = process.env.OPENAI_API_KEY
  return typeof envKey === 'string' && envKey.length > 0 ? envKey : null
}

async function setOpenAIKey(apiKey) {
  const path = openAIKeyPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, apiKey, { encoding: 'utf-8', mode: 0o600 })
  return true
}

async function clearOpenAIKey() {
  try {
    await rm(openAIKeyPath(), { force: true })
  } catch { /* ignore */ }
  return true
}

// --- handlers --------------------------------------------------------------

registerHandler('openai.getApiKeyStatus', async () => ({ hasKey: !!(await loadOpenAIKey()) }))
registerHandler('openai.setApiKey', async (params) => {
  if (typeof params?.apiKey !== 'string') {
    throw new Error('openai.setApiKey: missing apiKey')
  }
  return setOpenAIKey(params.apiKey)
})
registerHandler('openai.clearApiKey', async () => clearOpenAIKey())
