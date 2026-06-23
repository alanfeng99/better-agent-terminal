/**
 * One-shot connection URL: `wss://host:port?token=<hex>&fp=<sha256>`
 *
 * Used so users can copy a single string from the server (settings panel /
 * `bat-server` banner) and paste it into a profile's host/port/token/fp fields
 * in one go.
 */

export interface ParsedConnection {
  host: string
  port: number
  token: string
  fingerprint: string
}

export function buildConnectionUrl(opts: {
  host: string
  port: number
  token: string
  fingerprint: string
}): string {
  const params = new URLSearchParams({ token: opts.token, fp: opts.fingerprint })
  return `wss://${opts.host}:${opts.port}?${params.toString()}`
}

/**
 * Parse a pasted URL. Accepts `wss://`, `ws://`, or scheme-less `host:port?...`.
 * Returns null if any required field (host, port, token, fp) is missing.
 */
export function parseConnectionUrl(input: string): ParsedConnection | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let normalized = trimmed
  if (!/^wss?:\/\//i.test(normalized)) normalized = `wss://${normalized}`

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return null
  }

  const host = url.hostname
  const port = url.port ? Number(url.port) : 9876
  const token = url.searchParams.get('token') || ''
  const fingerprint = url.searchParams.get('fp') || ''
  if (!host || !token || !fingerprint || !Number.isFinite(port)) return null
  return { host, port, token, fingerprint }
}
