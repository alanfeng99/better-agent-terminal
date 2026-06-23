// Background auto-update controller (desktop host only).
//
// On launch (and on a long interval) it asks the Rust updater to check the
// per-channel/per-mode manifest. If a newer build exists it downloads + installs
// it in the background WITHOUT relaunching — the swapped bundle applies on the
// next launch, and the UI shows a "restart to apply" banner.
//
// The 'pre' channel is only honored when debug mode (BAT_DEBUG) is on; otherwise
// the effective channel falls back to 'stable'.

import { host } from '../host-api'
import { settingsStore } from '../stores/settings-store'

const INITIAL_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading'; downloaded: number; total: number | null }
  | { status: 'ready'; version: string }
  | { status: 'uptodate' } // manual check found nothing newer (banner ignores it)
  | { status: 'error'; message: string }

let state: UpdateState = { status: 'idle' }
const listeners = new Set<() => void>()

function setState(next: UpdateState): void {
  state = next
  listeners.forEach(l => l())
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dismissUpdate(): void {
  if (state.status === 'error') setState({ status: 'idle' })
}

function effectiveChannel(): 'stable' | 'pre' {
  const settings = settingsStore.getSettings()
  const wantsPre = settings.updateChannel === 'pre'
  const debugOn = host.debug?.isDebugMode === true
  return wantsPre && debugOn ? 'pre' : 'stable'
}

async function performCheck(noUpdateState: UpdateState): Promise<void> {
  // Don't restart a check while one is running, a download is in flight, or
  // an update is already staged.
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return

  const channel = effectiveChannel()
  try {
    setState({ status: 'checking' })
    const result = await host.update.checkNative(channel)
    if (!result?.available) {
      setState(noUpdateState)
      return
    }
    setState({ status: 'downloading', downloaded: 0, total: null })
    const installed = await host.update.install(channel)
    if (installed?.installed) {
      setState({ status: 'ready', version: installed.version || result.version || '' })
    } else {
      setState({ status: 'idle' })
    }
  } catch (err) {
    setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

async function runCheck(): Promise<void> {
  const settings = settingsStore.getSettings()
  // Opt-in: only auto-update when the user explicitly enabled it.
  if (settings.autoUpdateEnabled !== true) return
  await performCheck({ status: 'idle' })
}

// Manual "check now" from Settings: skips the auto-update opt-in gate (the
// click IS the consent) and reports "up to date" instead of going silent.
export async function checkUpdatesNow(): Promise<void> {
  await performCheck({ status: 'uptodate' })
}

let started = false

export function startAutoUpdate(): void {
  if (started) return
  started = true

  // Live download progress feeds the banner.
  host.update.onDownloadProgress(({ downloaded, total }: { downloaded: number; total: number | null }) => {
    if (state.status === 'downloading') setState({ status: 'downloading', downloaded, total })
  })

  window.setTimeout(() => { void runCheck() }, INITIAL_DELAY_MS)
  window.setInterval(() => { void runCheck() }, CHECK_INTERVAL_MS)
}
