// Vite plugin that serves /api/live in `vite dev` and `vite preview`, delegating to liveCore.
//
//   GET /api/live/status              -> 200 { available, sources, latest_t, limits, upstream_requests }  (never an error status)
//   GET /api/live?bbox=w,s,e,n&days=N -> 200 LiveResponse (columnar JSON), Cache-Control: private, max-age=<cache time left>
//                                        400 bad_request | too_large (+limit, area) · 429 rate_limited · 503 no_key | busy · 502 upstream_error
//   anything but GET                  -> 405
//
// Secrets: FIRMS_MAP_KEY is read server-side from <repo root>/.env.local, then .env, then process env
// (Vite's loadEnv precedence). It is never logged and never leaves this process.
import type { ServerResponse } from 'node:http'
import { loadEnv, type Connect, type Plugin, type ResolvedConfig } from 'vite'
import { LiveError, getLive, liveMaxAge, liveStatus, redact, type LiveEnv } from './liveCore.ts'

const ROUTE = '/api/live'

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

export function livePlugin(opts: { envDir: string }): Plugin {
  let config: ResolvedConfig | undefined

  // Only the variable the route needs is picked out; nothing else from the env files is used.
  const readEnv = (): LiveEnv => ({ FIRMS_MAP_KEY: loadEnv(config?.mode ?? 'development', opts.envDir, '').FIRMS_MAP_KEY })

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== '' && path !== '/status') return next()
    const env = readEnv()
    const log = (msg: string) => config?.logger.info(`[live] ${redact(msg, env.FIRMS_MAP_KEY)}`, { timestamp: true })

    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' })
      if (path === '/status') return json(res, 200, liveStatus(env))

      const started = Date.now()
      try {
        const data = await getLive(url.searchParams, env)
        const errs = Object.entries(data.sources).filter(([, s]) => s.error).map(([k]) => k)
        log(`200 ${data.bbox.join(',')} ${data.days}d n=${data.n} ${data.stale ? 'stale' : data.cached ? 'cache-hit' : 'upstream'}${errs.length ? ` partial(${errs.join(',')})` : ''} ${Date.now() - started}ms`)
        json(res, 200, data, { 'Cache-Control': `private, max-age=${liveMaxAge(data)}` })
      } catch (e) {
        const err = e instanceof LiveError ? e : new LiveError(500, 'internal_error')
        log(`${err.status} ${err.code} (${err.message})`)
        const headers: Record<string, string> = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {}
        // 400s carry the validation message (no echoed values beyond numbers); 5xx carry a code and a redacted detail.
        json(res, err.status, {
          error: err.code,
          detail: redact(err.message, env.FIRMS_MAP_KEY),
          ...err.extra,
          ...(err.retryAfterSec ? { retryAfter: err.retryAfterSec } : {}),
        }, headers)
      }
    } catch (e) {
      log(`500 ${e instanceof Error ? e.name : 'error'}`)
      json(res, 500, { error: 'internal_error' })
    }
  }

  return {
    name: 'harmony-live',
    configResolved(c) { config = c },
    configureServer(server) { server.middlewares.use(ROUTE, handler) },
    configurePreviewServer(server) { server.middlewares.use(ROUTE, handler) },
  }
}
