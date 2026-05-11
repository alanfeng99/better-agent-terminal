// image.readAsDataUrl — load a local image and return a data: URL.
// Mirrors electron/server-core/register-handlers.ts:757 +
// src-tauri/src/commands/image.rs. Same byte cap (10 MiB), same
// extension→MIME map (default image/png to match Electron).
//
// Used over the remote bridge: when a phone connects to a host and
// asks for a thumbnail of a host-side image, the renderer's host-api
// passes `{path}`; the bridge unwraps to params; we read the file off
// the host's filesystem and return a base64 data URL.

import * as path from 'path'
import * as fs from 'fs/promises'
import { registerHandler } from '../lib/protocol.mjs'
import { isSensitivePath } from '../lib/path-guard.mjs'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

registerHandler('image.readAsDataUrl', async (params) => {
  // Tauri host-api passes {path: filePath}; tolerate a bare string too
  // (Electron-style positional invoke that the bridge unwrapped).
  const filePath = typeof params === 'string'
    ? params
    : (typeof params?.path === 'string' ? params.path : null)
  if (!filePath) {
    throw new Error('image.readAsDataUrl: missing path')
  }
  const abs = path.resolve(filePath)
  if (isSensitivePath(abs)) {
    throw new Error('Access denied (sensitive path)')
  }
  const ext = path.extname(abs).toLowerCase()
  const mime = MIME_MAP[ext] || 'image/png'
  const stat = await fs.stat(abs)
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${Math.round(stat.size / 1024)}KB)`)
  }
  const data = await fs.readFile(abs)
  return `data:${mime};base64,${data.toString('base64')}`
})
