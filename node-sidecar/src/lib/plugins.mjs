// Mirror of electron/claude-agent-manager.ts installed-plugin loader.
// Reads `~/.claude/plugins/installed_plugins.json`, walks the
// pluginsData.plugins object whose values are arrays of entries with
// `installPath`, and returns the queryOptions.plugins shape the SDK
// expects: `[{ type: 'local', path }]`. Returns [] on any read/parse
// failure — plugins are optional, no install file is the common case
// for a fresh user, and the renderer surfaces nothing missing.
//
// Override hook for tests. When set, replaces the on-disk read so tests
// can drive the loader without touching the user's real ~/.claude.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

let _pluginsPathOverrideForTests = null
export function __setPluginsPathOverrideForTests(p) { _pluginsPathOverrideForTests = p }

export async function loadInstalledPlugins() {
  const installedPlugins = []
  try {
    const path = _pluginsPathOverrideForTests
      || join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw)
    if (data && data.plugins && typeof data.plugins === 'object') {
      for (const entries of Object.values(data.plugins)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry && typeof entry.installPath === 'string') {
            installedPlugins.push({ type: 'local', path: entry.installPath })
          }
        }
      }
    }
  } catch {
    // Missing file / parse error — fine, no plugins installed.
  }
  return installedPlugins
}

// Mirror of electron/claude-agent-manager.ts dataUrlToContentBlock — parse
// "data:image/<mime>;base64,<...>" into the SDK's expected block. Skip
// >20MB base64 to dodge API rejection (raw image is ~15MB at base64 1.33x).
export function dataUrlToContentBlock(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
  if (!m) return null
  const base64 = m[2]
  if (base64.length > 20 * 1024 * 1024) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: base64 } }
}
