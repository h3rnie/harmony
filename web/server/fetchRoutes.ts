// Web-standard (Request -> Response) handlers for the deployed server routes. The Vercel functions in web/api/ are
// one-line wrappers around these; `vite dev` / `vite preview` keep using livePlugin.ts and ai/plugin.ts. Both sides
// delegate to the same cores (liveCore.ts, ai/core.ts), and the contracts, status codes and bodies are the same:
//
//   GET  /api/live/status -> 200 LiveStatus (never an error status)
//   GET  /api/live        -> 200 LiveResponse (gzip/br when accepted, streamed) · 400 · 403 · 405 · 429 · 502 · 503
//   GET  /api/brief       -> 200 AI status (available:false while the daily cap is used up)
//   POST /api/brief       -> NDJSON stream, or before the stream: 400 · 403 · 405 · 415 · 429 · 502 · 503
//   POST /api/ask         -> same
//
// Added on top of the dev routes: per-visitor rate limits on /api/live and the AI POSTs (429 rate_limited +
// Retry-After) and a hard daily cap on AI requests that reach a model (status probe says unavailable; POST answers
// 503 daily_cap, which the client shows as "AI unavailable" and falls back to the rule-based brief).
//
// Secrets (FIRMS_MAP_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, store token) come in through `env` only; they are
// never logged or returned. Log lines carry codes, sizes and timings, never IPs or request bodies.
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { ASK_MAX_ANSWER_CHARS, ASK_MAX_QUESTION_CHARS, ASK_MAX_TURNS, DOSSIER_MAX_BYTES } from '../src/lib/brief/dossierTypes.ts'
import { AiError, assertSameOrigin as aiSameOrigin, getAnswer, getBrief, getStatus, type AiEnv } from './ai/core.ts'
import { clientIp, dailyCap, dailyUsed, getStore, secondsToUtcMidnight, takeDailySlot, takeVisitorSlot, visitorId, type LimitsEnv } from './limits.ts'
import { LiveError, assertSameOrigin as liveSameOrigin, getLive, liveMaxAge, liveStatus, redact, type LiveEnv } from './liveCore.ts'

export type ServerEnv = LiveEnv & AiEnv & LimitsEnv & {
  /** Extra origins treated as this site's own, comma-separated (the request's own host always counts). */
  ALLOWED_ORIGINS?: string
  VERCEL_URL?: string
  VERCEL_BRANCH_URL?: string
  VERCEL_PROJECT_PRODUCTION_URL?: string
}

const AI_KEYS = [
  'AI_PROVIDER', 'AI_MODEL', 'AI_PROFILE', 'AI_FALLBACK', 'AI_FALLBACK_MODEL', 'AI_CACHE_TTL', 'BRIEF_MODEL',
  'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_REFERER', 'OPENROUTER_BASE_URL',
] as const
const LIMIT_KEYS = ['REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'IP_HASH_SECRET', 'AI_DAILY_CAP'] as const
const SITE_KEYS = ['ALLOWED_ORIGINS', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const

/** Picks only the variables the routes use out of a larger environment (e.g. process.env). */
export function pickEnv(all: Record<string, string | undefined>): ServerEnv {
  const out: Record<string, string | undefined> = { FIRMS_MAP_KEY: all.FIRMS_MAP_KEY }
  for (const k of [...AI_KEYS, ...LIMIT_KEYS, ...SITE_KEYS]) out[k] = all[k]
  return out as ServerEnv
}

export const PRODUCTION_ORIGIN = 'https://harmony.hernie.me'

/** This deployment's own origins besides the request Host: production domain, Vercel deployment/branch URLs, extras. */
export function ownOrigins(env: ServerEnv): string[] {
  const out = [PRODUCTION_ORIGIN]
  for (const h of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) if (h?.trim()) out.push(`https://${h.trim()}`)
  for (const o of (env.ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) out.push(o.trim().replace(/\/+$/, ''))
  return out
}

const log = (line: string) => console.log(line)

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

// ---------------------------------------------------------------- compression + streaming

const gzip = promisify(zlib.gzip)
const brotli = promisify(zlib.brotliCompress)
const CHUNK = 64 * 1024

/** Chooses br > gzip > identity from Accept-Encoding (q=0 respected). */
export function pickEncoding(accept: string | null): 'br' | 'gzip' | null {
  const ok = (name: string) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q\\s*=\\s*([0-9.]+))?\\s*(?:,|$)`, 'i').exec(accept ?? '')
    return m != null && (m[1] == null || Number(m[1]) > 0)
  }
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null
}

/**
 * A JSON body compressed when the client accepts it and always streamed in 64 KB chunks: the worst /api/live answer
 * (a 900 square-degree box over 7 days in a peak fire season) is ~8 MB of JSON, ~1.6 MB compressed, and a streamed
 * body is not subject to the 4.5 MB function response limit either way.
 */
async function streamedJson(status: number, body: unknown, accept: string | null, headers: Record<string, string>): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  const enc = pickEncoding(accept)
  const bytes = enc === 'br'
    ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    : enc === 'gzip' ? await gzip(raw, { level: 6 }) : raw
  let off = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= bytes.length) { c.close(); return }
      c.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset + off, Math.min(CHUNK, bytes.length - off)))
      off += CHUNK
    },
  })
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding',
      ...(enc ? { 'Content-Encoding': enc } : {}), ...headers,
    },
  })
}

// ---------------------------------------------------------------- /api/live, /api/live/status

export async function handleLive(req: Request, env: ServerEnv, route: 'live' | 'status'): Promise<Response> {
  const say = (msg: string) => log(`[live] ${redact(msg, env.FIRMS_MAP_KEY)}`)
  try {
    try { liveSameOrigin(req.headers, ownOrigins(env)) } catch (e) {
      const err = e as LiveError
      say(`${err.status} ${err.code} (${err.message})`)
      return json(err.status, { error: err.code, detail: err.message })
    }
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
    if (route === 'status') return json(200, liveStatus(env))

    const store = getStore(env, log)
    const slot = await takeVisitorSlot(store, 'live', visitorId(clientIp(req.headers), env))
    if (!slot.ok) {
      say(`429 rate_limited (visitor) store=${store.kind}`)
      return json(429, { error: 'rate_limited', detail: 'too many live requests from this address', retryAfter: slot.retryAfterSec }, { 'Retry-After': String(slot.retryAfterSec) })
    }

    const started = Date.now()
    try {
      const data = await getLive(new URL(req.url).searchParams, env)
      const errs = Object.entries(data.sources).filter(([, s]) => s.error).map(([k]) => k)
      const res = await streamedJson(200, data, req.headers.get('accept-encoding'), { 'Cache-Control': `private, max-age=${liveMaxAge(data)}` })
      say(`200 ${data.bbox.join(',')} ${data.days}d n=${data.n} ${data.stale ? 'stale' : data.cached ? 'cache-hit' : 'upstream'}${errs.length ? ` partial(${errs.join(',')})` : ''} ${res.headers.get('content-encoding') ?? 'identity'} ${Date.now() - started}ms`)
      return res
    } catch (e) {
      const err = e instanceof LiveError ? e : new LiveError(500, 'internal_error')
      say(`${err.status} ${err.code} (${err.message})`)
      const headers: Record<string, string> = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {}
      return json(err.status, {
        error: err.code,
        detail: redact(err.message, env.FIRMS_MAP_KEY),
        ...err.extra,
        ...(err.retryAfterSec ? { retryAfter: err.retryAfterSec } : {}),
      }, headers)
    }
  } catch (e) {
    say(`500 ${e instanceof Error ? e.name : 'error'}`)
    return json(500, { error: 'internal_error' })
  }
}

// ---------------------------------------------------------------- /api/brief, /api/ask

const ASK_MAX_BYTES = DOSSIER_MAX_BYTES + ASK_MAX_TURNS * 4 * Math.max(ASK_MAX_QUESTION_CHARS, ASK_MAX_ANSWER_CHARS) + 1024

/** Reads the body up to the cap; null when it is larger (reading stops at the cap). */
async function readBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function handleAi(req: Request, env: ServerEnv, mode: 'brief' | 'ask'): Promise<Response> {
  const say = (msg: string) => log(`[ai] ${msg}`)
  try {
    try { aiSameOrigin(req.headers, ownOrigins(env)) } catch (e) {
      const err = e as AiError
      say(`${mode} ${err.status} ${err.code} (${err.message})`)
      return json(err.status, { error: err.code })
    }
    const aiEnv: AiEnv = env
    const store = getStore(env, log)
    const cap = dailyCap(env)

    if (req.method === 'GET' && mode === 'brief') {
      const status = getStatus(aiEnv)
      if (status.available) {
        const used = await dailyUsed(store)
        if (used >= cap) return json(200, { ...status, available: false, ask: false, problem: 'daily_cap' })
      }
      return json(200, status)
    }
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: mode === 'brief' ? 'GET, POST' : 'POST' })

    // Requiring a JSON content type forces a CORS preflight on cross-site pages, which is never approved.
    if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json(415, { error: 'unsupported_media_type' })

    const raw = await readBody(req, mode === 'ask' ? ASK_MAX_BYTES : DOSSIER_MAX_BYTES + 512)
    if (raw === null) return json(400, { error: 'bad_request', detail: 'payload too large' })
    let body: unknown
    try { body = JSON.parse(raw) } catch { return json(400, { error: 'bad_request', detail: 'invalid JSON' }) }

    const slot = await takeVisitorSlot(store, 'ai', visitorId(clientIp(req.headers), env))
    if (!slot.ok) {
      say(`${mode} 429 rate_limited (visitor) store=${store.kind}`)
      return json(429, { error: 'rate_limited', retryAfter: slot.retryAfterSec }, { 'Retry-After': String(slot.retryAfterSec) })
    }

    return await runStream(req, aiEnv, mode, body, {
      admit: async () => {
        if (await takeDailySlot(store, cap)) return
        throw new AiError(503, 'daily_cap', `daily cap of ${cap} AI requests reached`, secondsToUtcMidnight())
      },
      log: say,
    })
  } catch (e) {
    say(`${mode} 500 ${e instanceof Error ? e.name : 'error'}`)
    return json(500, { error: 'internal_error' })
  }
}

/**
 * Runs the core and answers with JSON for anything that fails before the first streamed text, or a 200 NDJSON stream
 * otherwise (same events as the dev plugin: delta / reset / done / error). Request cancellation aborts the model call.
 */
function runStream(
  req: Request, env: AiEnv, mode: 'brief' | 'ask', body: unknown,
  extra: { admit: () => Promise<void>; log: (s: string) => void },
): Promise<Response> {
  const enc = new TextEncoder()
  const ac = new AbortController()
  req.signal?.addEventListener('abort', () => ac.abort(), { once: true })

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const pending: string[] = []
  let started = false
  let closed = false
  const emit = (o: unknown) => {
    if (closed) return
    const line = JSON.stringify(o) + '\n'
    if (controller) controller.enqueue(enc.encode(line))
    else pending.push(line)
  }
  const close = () => {
    if (closed) return
    closed = true
    controller?.close()
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const l of pending.splice(0)) c.enqueue(enc.encode(l))
      if (closed) c.close()
    },
    cancel() { closed = true; ac.abort() },
  })
  const ndjson = () => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' },
  })

  return new Promise<Response>((resolve) => {
    const startStream = () => { if (!started) { started = true; resolve(ndjson()) } }
    const hooks = {
      signal: ac.signal,
      fresh: req.headers.get('x-brief-fresh') === '1',
      onDelta: (field: string, text: string) => { startStream(); emit({ type: 'delta', field, text }) },
      onReset: () => { if (started) emit({ type: 'reset' }) },
      admit: extra.admit,
      log: extra.log,
    }
    const run = mode === 'brief' ? getBrief(body, env, hooks) : getAnswer(body, env, hooks)
    run.then((result) => {
      startStream()
      emit({ type: 'done', ...result })
      close()
      const u = result.usage
      extra.log(`${mode} 200 ${result.provider} ${result.model} ${result.cached ? 'response-cache-hit' : `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} calls=${result.calls}${result.fellBack ? ' FALLBACK' : ''}`} ${result.ms}ms`)
    }, (e: unknown) => {
      const err = e instanceof AiError ? e : new AiError(500, 'internal_error')
      extra.log(`${mode} ${err.status} ${err.code}${err.status === 400 || err.status >= 500 ? ` (${err.message})` : ''}`)
      if (started) { if (err.code !== 'aborted') emit({ type: 'error', error: err.code }); close(); return }
      if (err.code === 'aborted') { resolve(new Response(null, { status: 499 })); return }
      const headers: Record<string, string> = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {}
      // 400 carries the validation message (field paths only, never echoed values); other errors only a code.
      resolve(json(err.status, err.status === 400 ? { error: err.code, detail: err.message } : { error: err.code, ...(err.retryAfterSec ? { retryAfter: err.retryAfterSec } : {}) }, headers))
    })
  })
}
