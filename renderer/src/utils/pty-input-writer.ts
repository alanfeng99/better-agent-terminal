export interface PtyInputWriter {
  write(data: string): void
  dispose(): void
}

export function createPtyInputWriter(send: (data: string) => Promise<unknown> | unknown): PtyInputWriter {
  let pending = ''
  let inFlight = false
  let scheduled = false
  let disposed = false

  const scheduleFlush = () => {
    if (disposed || inFlight || scheduled) return
    scheduled = true
    queueMicrotask(flush)
  }

  const finishWrite = () => {
    inFlight = false
    if (pending) scheduleFlush()
  }

  const flush = () => {
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
    },
  }
}
