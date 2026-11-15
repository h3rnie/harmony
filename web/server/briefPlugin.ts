// Vite plugin that serves /api/brief in `vite dev` and `vite preview`, delegating to briefCore.
//
//   GET  /api/brief  -> 200 { available: boolean }        (cheap probe; never an error status)
//   POST /api/brief  -> 200 application/x-ndjson stream:  {"type":"delta","text":"..."} ... {"type":"done","text","model","usage","cached"}
//                       or {"type":"error","error":"..."} if the model call fails after streaming began.
//                       Before the stream starts: 400 bad_request · 429 rate_limited · 503 no_key · 502 upstream_error (JSON { error }).
//
// Secrets: ANTHROPIC_API_KEY is read server-side from <repo root>/.env.local, then .env, then process env
// (Vite's loadEnv precedence). It is never logged and never leaves this process.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadEnv, type Connect, type Plugin, type ResolvedConfig } from 'vite'
import { PAYLOAD_MAX_BYTES } from '../src/lib/brief/payloadTypes.ts'
import { BriefError, briefAvailable, getBrief, resolveModel, type BriefEnv } from './briefCore.ts'

const ROUTE = '/api/brief'

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

export function briefPlugin(opts: { envDir: string }): Plugin {
  let config: ResolvedConfig | undefined

  // Only the two variables the route needs are picked out; nothing else from the env files is used.
  const readEnv = (): BriefEnv => {
    const all = loadEnv(config?.mode ?? 'development', opts.envDir, '')
    return { ANTHROPIC_API_KEY: all.ANTHROPIC_API_KEY, BRIEF_MODEL: all.BRIEF_MODEL }
  }

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '') return next()
    const log = (msg: string) => config?.logger.info(`[brief] ${msg}`, { timestamp: true })

    try {
      if (req.method === 'GET') {
        const env = readEnv()
        return json(res, 200, { available: briefAvailable(env), model: briefAvailable(env) ? resolveModel(env) : null })
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' })

      // Requiring a JSON content type forces a CORS preflight on cross-site pages, which we never approve:
      // another website cannot make a visitor's browser spend this server's API credits.
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'unsupported_media_type' })

      const raw = await readBody(req, PAYLOAD_MAX_BYTES + 512)
      if (raw === null) return json(res, 400, { error: 'bad_request', detail: 'payload too large' })
      let body: unknown
      try { body = JSON.parse(raw) } catch { return json(res, 400, { error: 'bad_request', detail: 'invalid JSON' }) }

      const ac = new AbortController()
      res.on('close', () => { if (!res.writableFinished) ac.abort() })

      const started = Date.now()
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

      try {
        const result = await getBrief(body, readEnv(), {
          signal: ac.signal,
          fresh: req.headers['x-brief-fresh'] === '1',
          onText: (text) => { startStream(); line({ type: 'delta', text }) },
        })
        startStream()
        line({ type: 'done', ...result })
        res.end()
        log(`200 ${result.model} ${result.cached ? 'cache-hit' : `in=${result.usage.input_tokens} out=${result.usage.output_tokens}`} ${Date.now() - started}ms`)
      } catch (e) {
        const err = e instanceof BriefError ? e : new BriefError(500, 'internal_error')
        log(`${err.status} ${err.code}${err.status === 400 || err.status >= 500 ? ` (${err.message})` : ''}`)
        if (err.code === 'aborted') { res.end(); return }
        if (streaming) { line({ type: 'error', error: err.code }); res.end(); return }
        const headers: Record<string, string> = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {}
        // 400 carries the validation message (field paths only, never echoed values); other errors only a code.
        json(res, err.status, err.status === 400 ? { error: err.code, detail: err.message } : { error: err.code, ...(err.retryAfterSec ? { retryAfter: err.retryAfterSec } : {}) }, headers)
      }
    } catch (e) {
      log(`500 ${e instanceof Error ? e.name : 'error'}`)
      json(res, 500, { error: 'internal_error' })
    }
  }

  return {
    name: 'harmony-brief',
    configResolved(c) { config = c },
    configureServer(server) { server.middlewares.use(ROUTE, handler) },
    configurePreviewServer(server) { server.middlewares.use(ROUTE, handler) },
  }
}
