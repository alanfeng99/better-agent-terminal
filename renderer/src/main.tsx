import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
import { getHostKind, host, installTauriShim } from './host-api'

// Install a permissive Tauri host shim before React mounts. It is keyed off the
// host adapter so unmigrated callsites do not crash render. Missing features
// still log a "not yet implemented" warning the first time they are hit.
installTauriShim()
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/settings.css'
import './styles/context-menu.css'
import './styles/notifications.css'
import './styles/env-snippets.css'
import './styles/resize.css'
import './styles/file-browser.css'
import './styles/path-linker.css'
import './styles/prompt-box.css'
import './styles/claude-agent.css'
import './styles/skills-panel.css'

const dlog = (...args: unknown[]) => host.debug.log(...args)
const t0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
const tauriSmokeWindowTokens = new Set<string>()
dlog(`[startup] ── renderer ──────────────────────────────`)
dlog(`[startup] host kind: ${getHostKind()}`)
dlog(`[startup] location: ${window.location.href}`)
void host.app.getWindowId()
  .then((windowId) => dlog(`[startup] window id: ${windowId}`))
  .catch((err) => dlog(`[startup] window id failed: ${String((err as { message?: unknown })?.message ?? err)}`))
dlog(`[startup] main.tsx top-level: +${Date.now() - t0}ms from HTML <script>`)

if (getHostKind() === 'tauri') {
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<string>('bat:smoke-new-window', async (event) => {
      const token = event.payload || 'unknown'
      if (tauriSmokeWindowTokens.has(token)) return
      tauriSmokeWindowTokens.add(token)
      const windowId = await host.app.getWindowId().catch(() => null)
      if (windowId !== 'main') return
      dlog(`[window-smoke:${token}] renderer-requested`)
      const id = await host.app.newWindow()
      dlog(`[window-smoke:${token}] renderer-new-window id=${id}`)
    }))
    .catch((err) => dlog(`[window-smoke] listener failed: ${String((err as { message?: unknown })?.message ?? err)}`))
}

// Surface unhandled rejections with their actual contents. Tauri invoke
// rejects with a plain object (BridgeError → `{ message }`) which the
// browser console renders as `[object Object]` — useless for debugging.
// Stringify the reason so the message and any stack are visible in the
// log file, and re-print to console in a readable shape.
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason as unknown
  let detail: string
  try {
    if (r && typeof r === 'object') {
      const obj = r as Record<string, unknown>
      detail = JSON.stringify({
        message: obj.message,
        name: obj.name,
        code: obj.code,
        stack: typeof obj.stack === 'string' ? obj.stack.split('\n').slice(0, 6).join(' | ') : undefined,
        keys: Object.keys(obj),
      })
    } else {
      detail = String(r)
    }
  } catch {
    detail = '[unstringifiable rejection]'
  }
  dlog(`[unhandledrejection] ${detail}`)
  console.error('[unhandledrejection]', r, '→', detail)
})

// Keep splash visible — React root is hidden behind it.
// Splash will be removed once React has painted (see rAF below).
const splash = document.getElementById('splash')
const root = document.getElementById('root')!
root.style.display = ''

dlog(`[startup] before createRoot: +${Date.now() - t0}ms`)

ReactDOM.createRoot(root).render(<App />)

dlog(`[startup] after render() queued: +${Date.now() - t0}ms`)

// Remove splash only after React has committed to DOM and browser is ready to paint.
// Using double-rAF: first rAF fires before paint, second fires after paint is
// actually flushed — ensures React content is visible before we remove splash.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    if (splash) splash.remove()
    dlog(`[startup] splash removed (React painted): +${Date.now() - t0}ms from HTML`)
  })
})
