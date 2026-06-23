// Per-tool render cache. Tool result strings can be 1MB+ (e.g. a bash
// command that prints a minified JS bundle); the agent panels call
// parseContentBlocks / splitSystemReminders / split-by-line / preview-build
// on every render of every tool. Without caching this work re-runs for the
// large result on every streaming token, locking the UI.
//
// Caller passes a stable reference (typically `item.result`); when the
// React state update preserves the tool item reference (the common case),
// the cache hits and the heavy work is skipped.

interface CacheEntry<T> {
  ref: unknown
  computed: T
}

export type ToolRenderCache<T> = Map<string, CacheEntry<T>>

export function createToolRenderCache<T>(): ToolRenderCache<T> {
  return new Map()
}

export function getOrComputeToolRender<T>(
  cache: ToolRenderCache<T>,
  id: string,
  ref: unknown,
  compute: () => T,
): T {
  const existing = cache.get(id)
  if (existing && existing.ref === ref) return existing.computed
  const computed = compute()
  cache.set(id, { ref, computed })
  return computed
}

export function pruneToolRenderCache<T>(
  cache: ToolRenderCache<T>,
  liveIds: Set<string>,
): void {
  for (const id of [...cache.keys()]) {
    if (!liveIds.has(id)) cache.delete(id)
  }
}
