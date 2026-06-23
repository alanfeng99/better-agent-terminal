export type InputHistoryDirection = 'previous' | 'next'

export interface InputHistoryNavigationState {
  value: string
  selectionStart?: number | null
  selectionEnd?: number | null
}

function clampSelection(value: string, pos: number): number {
  return Math.max(0, Math.min(value.length, pos))
}

export function shouldNavigateInputHistory(
  direction: InputHistoryDirection,
  state: InputHistoryNavigationState,
): boolean {
  const value = state.value
  if (typeof state.selectionStart !== 'number') {
    return !value.includes('\n')
  }
  const selectionStart = clampSelection(value, state.selectionStart)
  const selectionEnd = clampSelection(value, typeof state.selectionEnd === 'number' ? state.selectionEnd : state.selectionStart)
  if (selectionStart !== selectionEnd) return false

  if (direction === 'previous') {
    return !value.slice(0, selectionStart).includes('\n')
  }
  return !value.slice(selectionStart).includes('\n')
}

export function shouldNavigateInputHistoryFromTextarea(
  direction: InputHistoryDirection,
  textarea: HTMLTextAreaElement | null,
  fallbackValue: string,
): boolean {
  if (!textarea) {
    return shouldNavigateInputHistory(direction, { value: fallbackValue })
  }
  return shouldNavigateInputHistory(direction, {
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
  })
}
