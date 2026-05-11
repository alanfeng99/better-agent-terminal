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
  return detail.x >= rect.left && detail.x <= rect.right && detail.y >= rect.top && detail.y <= rect.bottom
}
