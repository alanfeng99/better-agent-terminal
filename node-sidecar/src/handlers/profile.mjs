// profile.* — sidecar-visible profile surface for remote server invokes.
//
// Local Tauri renderer calls profile_* Rust commands directly. The remote
// WebSocket server, however, lives inside the sidecar and dispatches proxied
// `profile:*` frames through JSON-RPC, so it needs the same on-disk profile
// index/snapshot reader. This mirrors the Electron profile JSON layout enough
// for remote profile discovery and snapshot restore.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { registerHandler } from '../lib/protocol.mjs'
import { resolveDataDir } from '../lib/data-paths.mjs'
import { readEncryptedJson, writeEncryptedJson } from '../lib/remote-secrets.mjs'

const INDEX_FILE = 'index.json'
const TOKEN_FILE = 'remote-tokens.enc.json'
const DEFAULT_PROFILE_ID = 'default'

export const DEFAULT_PROFILE = {
  id: DEFAULT_PROFILE_ID,
  name: 'Default',
  type: 'local',
  createdAt: 0,
  updatedAt: 0,
}

function profilesDir() {
  return join(resolveDataDir(), 'profiles')
}

function indexPath() {
  return join(profilesDir(), INDEX_FILE)
}

function profilePath(profileId) {
  return join(profilesDir(), `${profileId}.json`)
}

function tokenPath() {
  return join(profilesDir(), TOKEN_FILE)
}

function defaultIndex() {
  return { profiles: [DEFAULT_PROFILE], activeProfileIds: [DEFAULT_PROFILE_ID] }
}

function normalizeIndex(raw) {
  const index = raw && typeof raw === 'object' ? { ...raw } : {}
  if (!Array.isArray(index.profiles)) index.profiles = [DEFAULT_PROFILE]
  if (!Array.isArray(index.activeProfileIds)) {
    index.activeProfileIds = typeof index.activeProfileId === 'string'
      ? [index.activeProfileId]
      : [DEFAULT_PROFILE_ID]
  }
  if (!index.profiles.some(p => p?.id === DEFAULT_PROFILE_ID)) {
    index.profiles.unshift(DEFAULT_PROFILE)
  }
  index.profiles = index.profiles
    .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
    .map(p => ({
      id: p.id,
      name: p.name,
      type: p.type === 'remote' ? 'remote' : 'local',
      remoteHost: p.remoteHost,
      remotePort: p.remotePort,
      remoteToken: p.remoteToken,
      remoteFingerprint: p.remoteFingerprint,
      remoteProfileId: p.remoteProfileId,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    }))
  return { profiles: index.profiles, activeProfileIds: index.activeProfileIds }
}

function activateProfile(index, profileId) {
  if (!index.profiles.some(profile => profile.id === profileId)) return false
  if (!index.activeProfileIds.includes(profileId)) {
    index.activeProfileIds.push(profileId)
  }
  return true
}

function hydrateRemoteTokens(index) {
  const store = readEncryptedJson(tokenPath())
  const tokens = store && typeof store === 'object' && store.tokens && typeof store.tokens === 'object'
    ? store.tokens
    : {}
  for (const profile of index.profiles) {
    if (profile.type === 'remote' && !profile.remoteToken && typeof tokens[profile.id] === 'string') {
      profile.remoteToken = tokens[profile.id]
    }
  }
  return index
}

function stripRemoteTokens(index) {
  const store = readEncryptedJson(tokenPath())
  const tokens = store && typeof store === 'object' && store.tokens && typeof store.tokens === 'object'
    ? { ...store.tokens }
    : {}
  const ids = new Set(index.profiles.map(p => p.id))
  const profiles = index.profiles.map(profile => {
    const { remoteToken, ...rest } = profile
    if (profile.type === 'remote' && remoteToken) tokens[profile.id] = remoteToken
    else if (profile.type !== 'remote') delete tokens[profile.id]
    return rest
  })
  for (const id of Object.keys(tokens)) {
    if (!ids.has(id)) delete tokens[id]
  }
  writeEncryptedJson(tokenPath(), { tokens })
  return { ...index, profiles }
}

async function readIndex() {
  try {
    const raw = await readFile(indexPath(), 'utf-8')
    return hydrateRemoteTokens(normalizeIndex(JSON.parse(raw)))
  } catch {
    return defaultIndex()
  }
}

async function writeIndex(index) {
  await mkdir(profilesDir(), { recursive: true })
  const clean = stripRemoteTokens(normalizeIndex(index))
  await writeFile(indexPath(), JSON.stringify(clean, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

function migrateSnapshot(raw) {
  if (raw?.version === 2) return raw
  if (raw?.version === 1) {
    return {
      id: raw.id,
      name: raw.name,
      version: 2,
      windows: [{
        workspaces: raw.workspaces || [],
        activeWorkspaceId: raw.activeWorkspaceId || null,
        activeGroup: raw.activeGroup || null,
        terminals: raw.terminals || [],
        activeTerminalId: raw.activeTerminalId || null,
      }],
    }
  }
  return null
}

async function readSnapshot(profileId) {
  try {
    const raw = await readFile(profilePath(profileId), 'utf-8')
    return migrateSnapshot(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function listProfiles() {
  const index = await readIndex()
  return {
    profiles: index.profiles,
    activeProfileIds: index.activeProfileIds,
  }
}

async function loadProfile(profileId) {
  const index = await readIndex()
  if (!activateProfile(index, profileId)) return null
  const snapshot = await readSnapshot(profileId)
  if (!snapshot) return null
  await writeIndex(index)
  return snapshot
}

registerHandler('profile.list', async () => listProfiles())
registerHandler('profile.getActiveIds', async () => (await readIndex()).activeProfileIds)
registerHandler('profile.load', async (params) => loadProfile(params?.profileId ?? params))
registerHandler('profile.loadSnapshot', async (params) => readSnapshot(params?.profileId ?? params))
registerHandler('profile.activate', async (params) => {
  const profileId = params?.profileId ?? params
  const index = await readIndex()
  if (!activateProfile(index, profileId)) return false
  await writeIndex(index)
  return true
})
registerHandler('profile.deactivate', async (params) => {
  const profileId = params?.profileId ?? params
  const index = await readIndex()
  index.activeProfileIds = index.activeProfileIds.filter(id => id !== profileId)
  if (index.activeProfileIds.length === 0) index.activeProfileIds = [DEFAULT_PROFILE_ID]
  await writeIndex(index)
  return true
})

export async function __resetProfilesForTests() {
  await rm(profilesDir(), { recursive: true, force: true })
}
