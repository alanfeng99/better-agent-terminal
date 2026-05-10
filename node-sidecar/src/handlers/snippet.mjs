// snippet.* — port of the Electron snippet:* handlers (10 channels)
// from electron/server-core/register-handlers.ts. Delegates all CRUD
// to the SnippetDatabase singleton (lazy-loaded, debounced disk
// writes).
//
// Param-shape compatibility:
//   - Tauri host-api sends `{id}` / `{input}` / `{id, updates}` /
//     `{query}` / `{workspaceId}` (object form).
//   - The remote bridge unwraps an Electron client's positional arg
//     to args[0]; for single-arg methods that means params is a bare
//     number/string (id / query). For two-arg `update` only the
//     object form `{id, updates}` is meaningful — Electron-style
//     positional args[1] is dropped by the bridge (documented).

import { registerHandler } from '../lib/protocol.mjs'
import { snippetDb } from '../lib/snippet-db.mjs'

function pickId(params) {
  if (typeof params === 'number') return params
  if (params && typeof params === 'object' && typeof params.id === 'number') return params.id
  return null
}

function pickString(params, key) {
  if (typeof params === 'string') return params
  if (params && typeof params === 'object' && typeof params[key] === 'string') return params[key]
  return null
}

function pickInput(params) {
  // Tauri form: {input: {...}}; Electron-style positional: bare object.
  // Treat any object that looks like a CreateSnippetInput (has title)
  // as the bare-form input. Otherwise unwrap .input.
  if (params && typeof params === 'object') {
    if (params.input && typeof params.input === 'object'
        && typeof params.input.title === 'string'
        && typeof params.input.content === 'string') {
      return params.input
    }
    if (typeof params.title === 'string' && typeof params.content === 'string') {
      return params
    }
  }
  return null
}

registerHandler('snippet.getAll', async () => snippetDb.getAll())

registerHandler('snippet.getById', async (params) => {
  const id = pickId(params)
  if (id === null) return null
  return snippetDb.getById(id)
})

registerHandler('snippet.create', async (params) => {
  const input = pickInput(params)
  if (!input) throw new Error('snippet.create: missing input.title / input.content')
  return snippetDb.create(input)
})

registerHandler('snippet.update', async (params) => {
  const id = pickId(params)
  if (id === null) throw new Error('snippet.update: missing id')
  const updates = (params && typeof params === 'object' && params.updates && typeof params.updates === 'object')
    ? params.updates
    : null
  if (!updates) throw new Error('snippet.update: missing updates')
  return snippetDb.update(id, updates)
})

registerHandler('snippet.delete', async (params) => {
  const id = pickId(params)
  if (id === null) return false
  return snippetDb.delete(id)
})

registerHandler('snippet.toggleFavorite', async (params) => {
  const id = pickId(params)
  if (id === null) return null
  return snippetDb.toggleFavorite(id)
})

registerHandler('snippet.search', async (params) => {
  const query = pickString(params, 'query')
  if (query === null) return []
  return snippetDb.search(query)
})

registerHandler('snippet.getCategories', async () => snippetDb.getCategories())

registerHandler('snippet.getFavorites', async () => snippetDb.getFavorites())

registerHandler('snippet.getByWorkspace', async (params) => {
  // workspaceId is optional — undefined / missing means "all".
  const workspaceId = (params && typeof params === 'object' && typeof params.workspaceId === 'string')
    ? params.workspaceId
    : (typeof params === 'string' ? params : undefined)
  return snippetDb.getByWorkspace(workspaceId)
})
