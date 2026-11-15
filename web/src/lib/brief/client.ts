// Browser side of /api/brief. The route exists in `vite dev` / `vite preview`; a static deployment either lacks it
// (set VITE_BRIEF_API=off to skip the probe entirely) or points VITE_BRIEF_API at a serverless function.
import type { BriefPayload } from './payloadTypes'

const BASE: string = (import.meta.env.VITE_BRIEF_API ?? '/api/brief').replace(/\/+$/, '')

export interface BriefUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export interface BriefDone { text: string; model: string; usage: BriefUsage; cached: boolean }

export class BriefClientError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code }
}

/** Does the server have a key configured? Never throws and never produces a failed request in the console on dev/preview. */
export async function probeBrief(signal?: AbortSignal): Promise<{ available: boolean; model: string | null }> {
  if (BASE === 'off') return { available: false, model: null }
  try {
    const res = await fetch(BASE, { headers: { accept: 'application/json' }, signal })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return { available: false, model: null }
    const b = await res.json()
    return { available: b?.available === true, model: typeof b?.model === 'string' ? b.model : null }
  } catch {
    return { available: false, model: null }
  }
}

/** Streams the brief; `onDelta` gets each text chunk, the promise resolves with the final cleaned text + metadata. */
export async function streamBrief(
  payload: BriefPayload,
  o: { fresh?: boolean; signal?: AbortSignal; onDelta?: (text: string) => void } = {},
): Promise<BriefDone> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/x-ndjson' }
  if (o.fresh) headers['x-brief-fresh'] = '1'
  const res = await fetch(BASE, { method: 'POST', headers, body: JSON.stringify(payload), signal: o.signal })
  if (!res.ok) {
    let code = `http_${res.status}`
    try { const b = await res.json(); if (typeof b?.error === 'string') code = b.error } catch { /* not JSON */ }
    throw new BriefClientError(code)
  }
  if (!res.body) throw new BriefClientError('no_stream')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let done: BriefDone | null = null
  const handle = (line: string) => {
    if (!line.trim()) return
    let ev: { type?: string; text?: string; error?: string } & Partial<BriefDone>
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'delta' && typeof ev.text === 'string') o.onDelta?.(ev.text)
    else if (ev.type === 'done' && typeof ev.text === 'string') done = { text: ev.text, model: String(ev.model ?? ''), usage: ev.usage as BriefUsage, cached: ev.cached === true }
    else if (ev.type === 'error') throw new BriefClientError(typeof ev.error === 'string' ? ev.error : 'stream_error')
  }
  for (;;) {
    const { value, done: eof } = await reader.read()
    if (value) {
      buf += dec.decode(value, { stream: !eof })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
    }
    if (eof) break
  }
  handle(buf)
  if (!done) throw new BriefClientError('incomplete')
  return done
}
