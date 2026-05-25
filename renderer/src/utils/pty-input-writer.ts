export interface PtyInputWriter {
  write(data: string): void
  dispose(): void
}

const INPUT_FLUSH_DELAY_MS = 4

export function createPtyInputWriter(send: (data: string) => Promise<unknown> | unknown): PtyInputWriter {
  let pending = ''
  let inFlight = false
  let scheduled = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const scheduleFlush = (delayMs = INPUT_FLUSH_DELAY_MS) => {
    if (disposed || inFlight || scheduled) return
    scheduled = true
    timer = setTimeout(flush, delayMs)
  }

  const finishWrite = () => {
    inFlight = false
    if (pending) scheduleFlush(0)
  }

  const flush = () => {
    timer = null
    scheduled = false
    if (disposed || inFlight || !pending) return

    const chunk = pending
    pending = ''
    inFlight = true

    try {
      Promise.resolve(send(chunk))
        .catch(() => {})
        .finally(finishWrite)
    } catch {
      finishWrite()
    }
  }

  return {
    write(data: string) {
      if (disposed || !data) return
      pending += data
      scheduleFlush()
    },
    dispose() {
      disposed = true
      pending = ''
      scheduled = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
