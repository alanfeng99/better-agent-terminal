import { useRef, useSyncExternalStore } from 'react'

interface Subscribable<T> {
  subscribe(listener: () => void): () => void
  getState(): T
}

// React 18 useSyncExternalStore-based selector hook factory. Behaves like
// zustand's `create()(selector, equalityFn)`: re-renders only when the selected
// slice changes by the supplied equality function (default Object.is).
//
// Stores must mutate state immutably (spread on update) so the top-level state
// ref changes when anything inside changes — our existing settings/workspace/
// notification stores already do this.
export function createSelectorHook<T>(store: Subscribable<T>) {
  return function useStoreSelector<U>(
    selector: (state: T) => U,
    isEqual: (a: U, b: U) => boolean = Object.is,
  ): U {
    const cacheRef = useRef<{ state: T; selected: U } | null>(null)
    return useSyncExternalStore(store.subscribe, () => {
      const state = store.getState()
      const cached = cacheRef.current
      if (cached && cached.state === state) return cached.selected
      const selected = selector(state)
      if (cached && isEqual(cached.selected, selected)) {
        cacheRef.current = { state, selected: cached.selected }
        return cached.selected
      }
      cacheRef.current = { state, selected }
      return selected
    })
  }
}

// Shallow equality for arrays/plain objects — good default for selectors that
// return derived collections or pick multiple primitive fields.
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}
