export interface TerminalKeyEventLike {
  type?: string
  key?: string
  code?: string
  keyCode?: number
  which?: number
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

export const IME_SAFE_EDIT_KEYS = new Set([
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Escape',
])

export function shouldBlockForImeComposition(
  event: TerminalKeyEventLike,
  imeComposing: boolean,
): boolean {
  // WebKit can report event.isComposing on ordinary keydown events after the
  // local composition lifecycle has ended. Only the tracked composition state
  // is reliable enough to block terminal input.
  if (!imeComposing) return false
  if (event.keyCode === 229) return false
  return !IME_SAFE_EDIT_KEYS.has(event.key ?? '')
}

export function getTerminalKeyInputOverride(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean } = {},
): string | null {
  if (event.type !== 'keydown') return null

  if (shouldBlockForImeComposition(event, Boolean(options.imeComposing))) {
    return null
  }

  if (event.shiftKey && event.key === 'Enter') {
    return '\n'
  }

  return null
}
