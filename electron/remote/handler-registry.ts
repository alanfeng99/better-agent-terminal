export interface HandlerContext {
  windowId: string | null
  isRemote: boolean
}

type Handler = (ctx: HandlerContext, ...args: unknown[]) => Promise<unknown> | unknown

const handlers = new Map<string, Handler>()

export function registerHandler(channel: string, handler: Handler): void {
  handlers.set(channel, handler)
}

export function invokeHandler(channel: string, args: unknown[], windowId?: string | null, isRemote = false): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for channel: ${channel}`)
  return Promise.resolve(handler({ windowId: windowId ?? null, isRemote }, ...args))
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}
