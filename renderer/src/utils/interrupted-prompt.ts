const INTERRUPTED_WRAPPER_RE = /^\[使用者先前的訊息（已中斷）: "[\s\S]+"\]\n\n([\s\S]*)$/

export function extractInterruptedContinuation(text: string): string | null {
  const match = text.match(INTERRUPTED_WRAPPER_RE)
  return match ? match[1] : null
}
