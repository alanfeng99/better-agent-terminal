export const TAURI_NATIVE_DROP_EVENT = 'bat-tauri-native-drop'

export interface TauriNativeDropDetail {
  type: 'enter' | 'over' | 'drop' | 'leave'
  paths: string[]
  x: number | null
  y: number | null
}

export function dispatchTauriNativeDrop(detail: TauriNativeDropDetail): void {
  window.dispatchEvent(new CustomEvent<TauriNativeDropDetail>(TAURI_NATIVE_DROP_EVENT, { detail }))
}

export function listenTauriNativeDrop(handler: (detail: TauriNativeDropDetail) => void): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<TauriNativeDropDetail>).detail)
  }
  window.addEventListener(TAURI_NATIVE_DROP_EVENT, listener)
  return () => window.removeEventListener(TAURI_NATIVE_DROP_EVENT, listener)
}

export function isTauriNativeDropInside(detail: TauriNativeDropDetail, element: HTMLElement | null): boolean {
  if (!element || detail.x === null || detail.y === null) return false
  const rect = element.getBoundingClientRect()
  const inRect = detail.x >= rect.left && detail.x <= rect.right && detail.y >= rect.top && detail.y <= rect.bottom
  if (!inRect) return false
  // Every workspace stays mounted and stacked (.workspace-container is
  // position:absolute; inset:0); inactive ones are only visibility:hidden +
  // pointer-events:none, so their bounding rects still cover the whole viewport.
  // A bare rect test therefore matches EVERY workspace's agent panel at once —
  // a single native file drop opens an upload-confirm dialog in every workspace
  // (they surface as you switch around) and fans the chunked upload across
  // panels/connections. Hit-test the drop point so only the panel actually
  // visible and interactive at that spot (the active workspace alone has
  // pointer-events:auto) claims the drop. elementFromPoint skips
  // visibility:hidden / pointer-events:none panels for us.
  const hit = element.ownerDocument.elementFromPoint(detail.x, detail.y)
  return !!hit && element.contains(hit)
}
