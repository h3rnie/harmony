// Browser side of /api/live. The FIRMS key never reaches the browser: everything goes through the proxy.
import type { LiveErrorBody, LiveResponse, LiveStatus } from './types'

export class LiveFetchError extends Error {
  readonly code: string
  readonly status: number
  readonly body: Partial<LiveErrorBody>
  constructor(status: number, body: Partial<LiveErrorBody>) {
    super(body.detail ?? body.error ?? `HTTP ${status}`)
    this.status = status
    this.code = body.error ?? 'http_error'
    this.body = body
  }
}

export async function fetchLiveStatus(signal?: AbortSignal): Promise<LiveStatus | null> {
  try {
    const r = await fetch('/api/live/status', { signal })
    if (!r.ok || !/json/.test(r.headers.get('content-type') ?? '')) return null // static hosting without the proxy
    return (await r.json()) as LiveStatus
  } catch {
    return null
  }
}

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)

export async function fetchLive(bbox: [number, number, number, number], days: number, signal?: AbortSignal): Promise<LiveResponse> {
  const r = await fetch(`/api/live?bbox=${bbox.map(fmt).join(',')}&days=${days}`, { signal })
  let body: unknown = null
  try { body = await r.json() } catch { /* not JSON */ }
  if (!r.ok) throw new LiveFetchError(r.status, (body ?? {}) as Partial<LiveErrorBody>)
  const d = body as LiveResponse
  if (!d || d.v !== 1 || !Array.isArray(d.t)) throw new LiveFetchError(502, { error: 'upstream_error', detail: 'unexpected response' })
  return d
}
