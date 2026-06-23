export interface ShortcutKeyboardEvent {
  key: string
  code: string
  isComposing?: boolean
  keyCode?: number
  which?: number
}

export function isImeReservedKeyEvent(event: ShortcutKeyboardEvent): boolean {
  return Boolean(
    event.isComposing ||
    event.keyCode === 229 ||
    event.which === 229 ||
    event.key === 'Process' ||
    event.key === 'Unidentified' ||
    event.key === 'Dead',
  )
}

export function isBackquoteShortcutEvent(event: ShortcutKeyboardEvent): boolean {
  if (isImeReservedKeyEvent(event)) return false
  return event.key === '`' || event.key === '~' || event.code === 'Backquote'
}

export function consumeKeyboardShortcut(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}
