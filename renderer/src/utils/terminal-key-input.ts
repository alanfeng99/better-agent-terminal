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

export type TerminalInputPlatform = 'darwin' | 'linux' | 'win32' | string

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

export function isBackspaceKeyEvent(event: TerminalKeyEventLike): boolean {
  return event.key === 'Backspace' ||
    event.code === 'Backspace' ||
    event.keyCode === 8 ||
    event.which === 8
}

export function isPlainBackspaceKeyEvent(event: TerminalKeyEventLike): boolean {
  return isBackspaceKeyEvent(event) &&
    event.ctrlKey !== true &&
    event.metaKey !== true &&
    event.altKey !== true
}

export function isSpaceKeyEvent(event: TerminalKeyEventLike): boolean {
  return event.key === ' ' ||
    event.code === 'Space' ||
    event.keyCode === 32 ||
    event.which === 32
}

export function getPrintableKeyInput(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean } = {},
): string | null {
  if (event.type !== 'keydown') return null
  if (options.imeComposing || event.isComposing) {
    return null
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (event.key?.length !== 1) return null
  return event.key
}

export function shouldTraceTerminalKeyEvent(event: TerminalKeyEventLike): boolean {
  if (event.type !== 'keydown') return false
  if (
    isBackspaceKeyEvent(event) ||
    isSpaceKeyEvent(event) ||
    event.key === 'Delete' ||
    event.code === 'Delete'
  ) {
    return true
  }
  return getPrintableKeyInput(event) !== null
}

export function describeTerminalKeyEvent(event: TerminalKeyEventLike): Record<string, unknown> {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    which: event.which,
    ctrlKey: event.ctrlKey === true,
    metaKey: event.metaKey === true,
    altKey: event.altKey === true,
    shiftKey: event.shiftKey === true,
    isComposing: event.isComposing === true,
    isBackspace: isBackspaceKeyEvent(event),
    isSpace: isSpaceKeyEvent(event),
  }
}

function labelInputCode(code: number): string {
  if (code === 8) return 'BS'
  if (code === 10) return 'LF'
  if (code === 13) return 'CR'
  if (code === 27) return 'ESC'
  if (code === 32) return 'SPACE'
  if (code === 127) return 'DEL'
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

export function describeTerminalInputData(data: string): Record<string, unknown> {
  const codes = Array.from(data).map(ch => ch.codePointAt(0) ?? 0)
  return {
    length: data.length,
    codes,
    labels: codes.map(labelInputCode),
  }
}

export function shouldTraceTerminalInputData(data: string): boolean {
  if (!data) return false
  const codes = Array.from(data).map(ch => ch.codePointAt(0) ?? 0)
  return data.length <= 256 ||
    codes.some(code => code === 8 || code === 32 || code === 127) ||
    data === '\x1b[3~'
}

export function isPrintableTerminalInputData(data: string): boolean {
  if (!data) return false
  return Array.from(data).every((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code >= 0x20 && code !== 0x7f
  })
}

export function getExpectedPlainBackspaceInput(
  platform?: TerminalInputPlatform,
): string | null {
  if (platform === 'darwin') return '\x7f'
  return null
}

export function shouldUseDirectTerminalKeyInput(platform?: TerminalInputPlatform): boolean {
  return platform !== 'win32'
}

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
  options: { imeComposing?: boolean, platform?: TerminalInputPlatform } = {},
): string | null {
  if (event.type !== 'keydown') return null
  const expectedPlainBackspaceInput = getExpectedPlainBackspaceInput(options.platform)

  // macOS shells commonly configure erase as ^? (DEL / 0x7f). Force that
  // byte for plain Backspace so the terminal deletes instead of inserting
  // a visible control/space glyph when the browser event path varies.
  if (
    expectedPlainBackspaceInput !== null &&
    !options.imeComposing &&
    isPlainBackspaceKeyEvent(event)
  ) {
    return expectedPlainBackspaceInput
  }

  if (shouldBlockForImeComposition(event, Boolean(options.imeComposing))) {
    return null
  }

  if (event.shiftKey && event.key === 'Enter') {
    return '\n'
  }

  return null
}

export function getControlKeyInput(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean } = {},
): string | null {
  if (event.type !== 'keydown') return null
  if (options.imeComposing || event.isComposing) return null
  if (!event.ctrlKey || event.metaKey || event.altKey) return null

  const key = event.key ?? ''
  if (key.length !== 1) return null

  const lower = key.toLowerCase()
  if (lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96)
  }

  switch (key) {
    case ' ':
      return '\x00'
    case '[':
      return '\x1b'
    case '\\':
      return '\x1c'
    case ']':
      return '\x1d'
    case '^':
      return '\x1e'
    case '_':
      return '\x1f'
    case '?':
      return '\x7f'
    default:
      return null
  }
}

export function getNavigationKeyInput(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean } = {},
): string | null {
  if (event.type !== 'keydown') return null
  if (options.imeComposing || event.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  if (event.shiftKey && event.key === 'Tab') return '\x1b[Z'

  switch (event.key) {
    case 'Enter':
      return '\r'
    case 'Tab':
      return '\t'
    case 'Escape':
      return '\x1b'
    case 'ArrowUp':
      return '\x1b[A'
    case 'ArrowDown':
      return '\x1b[B'
    case 'ArrowRight':
      return '\x1b[C'
    case 'ArrowLeft':
      return '\x1b[D'
    case 'Home':
      return '\x1b[H'
    case 'End':
      return '\x1b[F'
    case 'Insert':
      return '\x1b[2~'
    case 'Delete':
      return '\x1b[3~'
    case 'PageUp':
      return '\x1b[5~'
    case 'PageDown':
      return '\x1b[6~'
    default:
      return null
  }
}

export function getTerminalKeyInput(
  event: TerminalKeyEventLike,
  options: { imeComposing?: boolean, platform?: TerminalInputPlatform } = {},
): string | null {
  const override = getTerminalKeyInputOverride(event, options)
  if (override !== null) return override

  const controlInput = getControlKeyInput(event, options)
  if (controlInput !== null) return controlInput

  const printableInput = getPrintableKeyInput(event, options)
  if (printableInput !== null) return printableInput

  return getNavigationKeyInput(event, options)
}
