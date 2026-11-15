// Browser side of /api/brief and /api/ask. The routes exist in `vite dev` / `vite preview`; a static deployment either
// lacks them (set VITE_BRIEF_API=off to skip the probe entirely) or points VITE_BRIEF_API / VITE_ASK_API at a
// serverless function. No key and no provider URL ever reach the browser: everything goes through the server.
import type { Brief, ChatTurn, Dossier } from './dossierTypes'

const BASE: string = (import.meta.env.VITE_BRIEF_API ?? '/api/brief').replace(/\/+$/, '')
const ASK_BASE: string = (import.meta.env.VITE_ASK_API ?? (BASE === 'off' ? 'off' : BASE.replace(/\/brief$/, '/ask'))).replace(/\/+$/, '')

export interface AiUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface RunMeta {
  provider: string
  model: string
  profile: string
  usage: AiUsage
  /** Provider-reported prompt-cache accounting for the accepted call; null when not reported. */
  cache: { read: number; write: number } | null
  /** Served from the server's response cache (no model call). */
  cached: boolean
  calls: number
  fellBack: boolean
  ms: number
}
export interface BriefDone extends RunMeta { brief: Brief }
export interface AskDone extends RunMeta { text: string; ungrounded: string[] }

export interface AiStatus {
  available: boolean
  ask: boolean
  provider: string | null
  model: string | null
  profile: string | null
}
const OFF: AiStatus = { available: false, ask: false, provider: null, model: null, profile: null }

export class AiClientError extends Error {
  readonly code: string
  readonly retryAfter: number | undefined
  constructor(code: string, retryAfter?: number) { super(code); this.code = code; this.retryAfter = retryAfter }
}

/** Does the server have a provider configured? Never throws and never produces a failed request in the console on dev/preview. */
export async function probeAi(signal?: AbortSignal): Promise<AiStatus> {
  if (BASE === 'off') return OFF
  try {
    const res = await fetch(BASE, { headers: { accept: 'application/json' }, signal })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return OFF
    const b = await res.json()
    const available = b?.available === true
    return {
      available,
      ask: available && b?.ask === true && ASK_BASE !== 'off',
      provider: typeof b?.provider === 'string' ? b.provider : null,
      model: typeof b?.model === 'string' ? b.model : null,
      profile: typeof b?.profile === 'string' ? b.profile : null,
    }
  } catch {
    return OFF
  }
}

interface Handlers { onDelta?: (field: string, text: string) => void; onReset?: () => void }

async function postStream<T>(url: string, body: unknown, h: Handlers, o: { fresh?: boolean; signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/x-ndjson' }
  if (o.fresh) headers['x-brief-fresh'] = '1'
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal })
  if (!res.ok) {
    let code = `http_${res.status}`
    let retry: number | undefined
    try {
      const b = await res.json()
      if (typeof b?.error === 'string') code = b.error
      if (typeof b?.retryAfter === 'number') retry = b.retryAfter
    } catch { /* not JSON */ }
    throw new AiClientError(code, retry)
  }
  if (!res.body) throw new AiClientError('no_stream')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let done: T | null = null
  const handle = (line: string) => {
    if (!line.trim()) return
    let ev: { type?: string; field?: string; text?: string; error?: string }
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'delta' && typeof ev.text === 'string') h.onDelta?.(String(ev.field ?? 'text'), ev.text)
    else if (ev.type === 'reset') h.onReset?.()
    else if (ev.type === 'done') done = ev as unknown as T
    else if (ev.type === 'error') throw new AiClientError(typeof ev.error === 'string' ? ev.error : 'stream_error')
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
  if (!done) throw new AiClientError('incomplete')
  return done
}

/** Streams the structured brief; `onDelta('headline' | 'summary', chunk)` fills the card progressively. */
export function streamBrief(
  dossier: Dossier,
  o: { fresh?: boolean; signal?: AbortSignal; onDelta?: (field: string, text: string) => void; onReset?: () => void } = {},
): Promise<BriefDone> {
  // `now` is for follow-up questions only; the brief never uses it.
  const { now: _now, ...body } = dossier
  void _now
  return postStream<BriefDone>(BASE, body, { onDelta: o.onDelta, onReset: o.onReset }, o)
}

/** Streams one Ask Harmony answer; `onDelta` receives plain-text chunks. */
export function streamAsk(
  dossier: Dossier,
  messages: ChatTurn[],
  o: { signal?: AbortSignal; onDelta?: (text: string) => void; onReset?: () => void } = {},
): Promise<AskDone> {
  if (ASK_BASE === 'off') return Promise.reject(new AiClientError('no_key'))
  return postStream<AskDone>(ASK_BASE, { dossier, messages }, { onDelta: (_f, t) => o.onDelta?.(t), onReset: o.onReset }, o)
}
