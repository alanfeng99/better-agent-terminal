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

export function isPlainBackspaceEvent(event: TerminalKeyEventLike): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && (
    event.key === 'Backspace' ||
    event.code === 'Backspace' ||
    event.keyCode === 8 ||
    event.which === 8
  )
}

export function shouldBlockForImeComposition(
  event: TerminalKeyEventLike,
  imeComposing: boolean,
): boolean {
  if (!imeComposing && !event.isComposing) return false
  if (event.keyCode === 229) return false
  return !IME_SAFE_EDIT_KEYS.has(event.key ?? '')
}

export function getTerminalKeyInputOverride(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean } = {},
): string | null {
  if (event.type !== 'keydown') return null

  // WebKit can keep event.isComposing set after the local composition state
  // has ended. Plain Backspace must still reach the PTY as DEL in that case.
  if (!options.imeComposing && isPlainBackspaceEvent(event)) {
    return '\x7f'
  }

  if (shouldBlockForImeComposition(event, Boolean(options.imeComposing))) {
    return null
  }

  if (event.shiftKey && event.key === 'Enter') {
    return '\n'
  }

  return null
}
