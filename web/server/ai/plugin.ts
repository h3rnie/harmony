// Vite plugin that serves the AI routes in `vite dev` and `vite preview`, delegating to core.ts.
//
//   GET  /api/brief -> 200 { available, ask, provider, model, profile, effort, fallback, cacheTtl, problem, usage }
//                      (cheap probe; never an error status; never a secret)
//   POST /api/brief -> body = the area dossier. 200 application/x-ndjson stream:
//                      {"type":"delta","field":"headline"|"summary","text"} ... {"type":"reset"}? ... {"type":"done","brief",...meta}
//                      or {"type":"error","error"} if it fails after streaming began.
//   POST /api/ask   -> body = { dossier, messages }. Same stream with field "text" and a done event carrying `text`.
//   Before the stream starts: 400 bad_request · 415 · 429 rate_limited (+Retry-After) · 503 no_key / bad_config ·
//   502 upstream_error / refused / bad_output (JSON { error }).
//
// Secrets: ANTHROPIC_API_KEY / OPENROUTER_API_KEY are read server-side from <repo root>/.env.local, then .env, then
// process env (Vite's loadEnv precedence). They are never logged and never leave this process.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadEnv, type Connect, type Plugin, type ResolvedConfig } from 'vite'
import { ASK_MAX_ANSWER_CHARS, ASK_MAX_QUESTION_CHARS, ASK_MAX_TURNS, DOSSIER_MAX_BYTES } from '../../src/lib/brief/dossierTypes.ts'
import { AiError, getAnswer, getBrief, getStatus, type AiEnv } from './core.ts'

const ENV_KEYS = [
  'AI_PROVIDER', 'AI_MODEL', 'AI_PROFILE', 'AI_FALLBACK', 'AI_FALLBACK_MODEL', 'AI_CACHE_TTL', 'BRIEF_MODEL',
  'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_REFERER', 'OPENROUTER_BASE_URL',
] as const

const ASK_MAX_BYTES = DOSSIER_MAX_BYTES + ASK_MAX_TURNS * 4 * Math.max(ASK_MAX_QUESTION_CHARS, ASK_MAX_ANSWER_CHARS) + 1024

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

/** Reads the body up to the cap; resolves null when it is larger (the rest is discarded). */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) { tooBig = true; chunks.length = 0 } else if (!tooBig) chunks.push(c)
    })
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function aiPlugin(opts: { envDir: string }): Plugin {
  let config: ResolvedConfig | undefined

  // Only the variables the routes need are picked out; nothing else from the env files is used.
  const readEnv = (): AiEnv => {
    const all = loadEnv(config?.mode ?? 'development', opts.envDir, '')
    const env: Record<string, string | undefined> = {}
    for (const k of ENV_KEYS) env[k] = all[k]
    return env as AiEnv
  }

  const handler = (mode: 'brief' | 'ask'): Connect.NextHandleFunction => async (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '') return next()
    const log = (msg: string) => config?.logger.info(`[ai] ${msg}`, { timestamp: true })

    try {
      if (req.method === 'GET' && mode === 'brief') return json(res, 200, getStatus(readEnv()))
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: mode === 'brief' ? 'GET, POST' : 'POST' })

      // Requiring a JSON content type forces a CORS preflight on cross-site pages, which we never approve:
      // another website cannot make a visitor's browser spend this server's API credits.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'unsupported_media_type' })

      const raw = await readBody(req, mode === 'ask' ? ASK_MAX_BYTES : DOSSIER_MAX_BYTES + 512)
      if (raw === null) return json(res, 400, { error: 'bad_request', detail: 'payload too large' })
      let body: unknown
      try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'bad_request', detail: 'invalid JSON' }) }

      const ac = new AbortController()
      res.on('close', () => { if (!res.writableFinished) ac.abort() })

      let streaming = false
      const startStream = () => {
        if (streaming) return
        streaming = true
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()
      }
      const line = (o: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n') }
      const hooks = {
        signal: ac.signal,
        fresh: req.headers['x-brief-fresh'] === '1',
        onDelta: (field: string, text: string) => { startStream(); line({ type: 'delta', field, text }) },
        onReset: () => { if (streaming) line({ type: 'reset' }) },
        log,
      }

      try {
        const result = mode === 'brief' ? await getBrief(body, readEnv(), hooks) : await getAnswer(body, readEnv(), hooks)
        startStream()
        line({ type: 'done', ...result })
        res.end()
        const u = result.usage
        log(`${mode} 200 ${result.provider} ${result.model} ${result.cached ? 'response-cache-hit' : `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} calls=${result.calls}${result.fellBack ? ' FALLBACK' : ''}`} ${result.ms}ms`)
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError(500, 'internal_error')
        log(`${mode} ${err.status} ${err.code}${err.status === 400 || err.status >= 500 ? ` (${err.message})` : ''}`)
        if (err.code === 'aborted') { res.end(); return }
        if (streaming) { line({ type: 'error', error: err.code }); res.end(); return }
        const headers: Record<string, string> = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {}
        // 400 carries the validation message (field paths only, never echoed values); other errors only a code.
        json(res, err.status, err.status === 400 ? { error: err.code, detail: err.message } : { error: err.code, ...(err.retryAfterSec ? { retryAfter: err.retryAfterSec } : {}) }, headers)
      }
    } catch (e) {
      log(`${mode} 500 ${e instanceof Error ? e.name : 'error'}`)
      json(res, 500, { error: 'internal_error' })
    }
  }

  return {
    name: 'harmony-ai',
    configResolved(c) { config = c },
    configureServer(server) {
      server.middlewares.use('/api/brief', handler('brief'))
      server.middlewares.use('/api/ask', handler('ask'))
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/brief', handler('brief'))
      server.middlewares.use('/api/ask', handler('ask'))
    },
  }
}
