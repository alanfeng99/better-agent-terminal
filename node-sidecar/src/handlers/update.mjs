// update.check pings the GitHub Releases API and compares the latest
// tag against the version Tauri passed in. We let the Rust side own the
// "what's my version" string (it reads PackageInfo and forwards it as
// `currentVersion` in the params), so the sidecar stays runtime-agnostic.

import { registerHandler } from '../lib/protocol.mjs'

const GITHUB_REPO = 'tony1223/better-agent-terminal'

export function compareVersions(current, latest) {
  const a = current.replace(/^v/, '').split('.').map(Number)
  const b = latest.replace(/^v/, '').split('.').map(Number)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0
    const bi = b[i] || 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

registerHandler('update.check', async (params) => {
  const currentVersion = String(params?.currentVersion ?? '0.0.0')
  const fallback = { hasUpdate: false, currentVersion, latestRelease: null }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'Better-Agent-Terminal',
        'Accept': 'application/vnd.github.v3+json',
      },
    })
    if (!res.ok) return fallback
    const release = await res.json()
    if (!release || typeof release.tag_name !== 'string') return fallback
    const latestVersion = release.tag_name.replace(/^v/, '')
    let downloadUrl = null
    if (Array.isArray(release.assets)) {
      const winAsset = release.assets.find(a =>
        typeof a?.name === 'string' && (a.name.endsWith('-win.zip') || a.name.includes('win'))
      )
      if (winAsset?.browser_download_url) downloadUrl = winAsset.browser_download_url
    }
    return {
      hasUpdate: compareVersions(currentVersion, latestVersion),
      currentVersion,
      latestRelease: {
        version: latestVersion,
        tagName: release.tag_name,
        htmlUrl: release.html_url,
        downloadUrl,
        body: release.body || '',
        publishedAt: release.published_at,
      },
    }
  } catch {
    return fallback
  }
})
