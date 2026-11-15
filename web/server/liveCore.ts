// Framework-agnostic core of GET /api/live: validate -> snap -> cache -> usage guard -> FIRMS NRT (3 sources) -> columnar JSON.
// No Vite, Node http or Svelte imports here, so a serverless handler can wrap it:
//   getLive(new URL(req.url).searchParams, { FIRMS_MAP_KEY }, {})  ->  LiveResponse | throws LiveError
// The MAP_KEY only ever comes in through `env`; it is never logged, returned or placed in an error message
// (every upstream-derived string goes through redact()).
import {
  LIVE_SOURCES, SAT_AQUA, SAT_N20, SAT_N21, SAT_TERRA,
  type LiveLimits, type LiveResponse, type LiveSource, type LiveSourceInfo, type LiveStatus,
} from '../src/lib/live/types.ts'
import { crossSiteReason, type HeaderBag } from './sameOrigin.ts'

export interface LiveEnv { FIRMS_MAP_KEY?: string }

export interface LiveDeps {
  fetch?: typeof fetch
  now?: () => number
}

export interface LiveParams { bbox: [number, number, number, number]; days: number }

/** codes: bad_request / too_large 400 · forbidden 403 · rate_limited 429 · busy / no_key 503 · upstream_error 502 */
export class LiveError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec?: number
  readonly extra: Record<string, number>
  constructor(status: number, code: string, message?: string, extra: Record<string, number> = {}, retryAfterSec?: number) {
    super(message ?? code)
    this.status = status
    this.code = code
    this.extra = extra
    this.retryAfterSec = retryAfterSec
  }
}

export const LIVE_LIMITS: LiveLimits = { maxAreaDeg2: 900, maxDays: 7, snapDeg: 0.5, ttlSec: 600 }

const FIRMS = 'https://firms.modaps.eosdis.nasa.gov'
const FIRMS_MAX_RANGE = 5
const CACHE_MAX = 48
const STALE_KEEP_MS = 6 * 3600_000 // expired entries stay available as a fallback while FIRMS is busy
const PARTIAL_TTL_MS = 120_000 // results with a failed source are retried sooner
const RATE = { max: 12, windowMs: 60_000 } // upstream batches per process per minute (cache hits are free)
const BUSY_SHARE = 0.9
const USAGE_TTL_MS = 60_000
const UPSTREAM_TIMEOUT_MS = 30_000

interface Entry { at: number; ttlMs: number; data: LiveResponse }

/** In-memory state: per process (per serverless instance), by design. */
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<LiveResponse>>()
const hits: number[] = []
let usage: { at: number; share: number | null } | null = null
let upstreamRequests = 0

export function resetLiveState(): void {
  cache.clear(); inflight.clear(); hits.length = 0; usage = null; upstreamRequests = 0
}

/** Call first on every live route: refuses cross-site browser requests with 403 forbidden (see sameOrigin.ts). */
export function assertSameOrigin(headers: HeaderBag, allowedOrigins: readonly string[] = []): void {
  const why = crossSiteReason(headers, allowedOrigins)
  if (why) throw new LiveError(403, 'forbidden', why)
}

/** Appends without spreading into arguments: `push(...src)` throws RangeError past ~125k elements. */
function append<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i])
}

export function liveAvailable(env: LiveEnv): boolean {
  return typeof env.FIRMS_MAP_KEY === 'string' && /^[A-Za-z0-9]{8,64}$/.test(env.FIRMS_MAP_KEY.trim())
}

/** Removes the key (and any key-shaped URL segment) from a string that may come from upstream. */
export function redact(s: string, key: string | undefined): string {
  let out = s
  if (key) out = out.split(key).join('***')
  return out
    .replace(/(\/api\/area\/csv\/)[^/\s]+/g, '$1***')
    .replace(/(MAP_KEY=)[^&\s]+/gi, '$1***')
}

// ---------------------------------------------------------------- params

const NUM = /^-?\d{1,3}(\.\d{1,8})?$/

/** Strict validation; throws LiveError 400 (too_large carries the limit and the snapped area). */
export function parseLiveParams(q: URLSearchParams): LiveParams {
  for (const k of q.keys()) if (k !== 'bbox' && k !== 'days') throw new LiveError(400, 'bad_request', `unknown parameter "${k.slice(0, 20)}"`)
  const raw = q.get('bbox')
  if (!raw) throw new LiveError(400, 'bad_request', 'bbox is required: west,south,east,north in degrees')
  const parts = raw.split(',')
  if (parts.length !== 4 || !parts.every((p) => NUM.test(p.trim()))) throw new LiveError(400, 'bad_request', 'bbox must be four decimal numbers: west,south,east,north')
  const [w, s, e, n] = parts.map((p) => Number(p.trim()))
  if (w < -180 || e > 180 || s < -90 || n > 90) throw new LiveError(400, 'bad_request', 'bbox outside world bounds (lon -180..180, lat -90..90)')
  if (!(w < e)) throw new LiveError(400, 'bad_request', 'west must be less than east (bboxes crossing the antimeridian are not supported)')
  if (!(s < n)) throw new LiveError(400, 'bad_request', 'south must be less than north')
  const dRaw = q.get('days') ?? '1'
  if (!/^[1-9]$/.test(dRaw) || Number(dRaw) > LIVE_LIMITS.maxDays) throw new LiveError(400, 'bad_request', `days must be an integer from 1 to ${LIVE_LIMITS.maxDays}`)
  const bbox = snapBbox([w, s, e, n])
  const area = bboxArea(bbox)
  if (area > LIVE_LIMITS.maxAreaDeg2) {
    throw new LiveError(400, 'too_large', `area too large: ${Math.round(area)} square degrees after snapping; the limit is ${LIVE_LIMITS.maxAreaDeg2}`, { limit: LIVE_LIMITS.maxAreaDeg2, area: Math.round(area) })
  }
  return { bbox, days: Number(dRaw) }
}

export function snapBbox([w, s, e, n]: [number, number, number, number], g = LIVE_LIMITS.snapDeg): [number, number, number, number] {
  const fl = (v: number) => Math.floor(v / g + 1e-9) * g
  const ce = (v: number) => Math.ceil(v / g - 1e-9) * g
  return [Math.max(-180, fl(w)), Math.max(-90, fl(s)), Math.min(180, ce(e)), Math.min(90, ce(n))]
}
export const bboxArea = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1])

// ---------------------------------------------------------------- CSV

export interface ParsedCsv { lat: number[]; lon: number[]; t: number[]; sat: number[]; conf: number[]; frp: number[]; dn: number[] }

function satIndex(v: string, source: LiveSource): number {
  const s = v.trim().toUpperCase()
  if (source === 'VIIRS_NOAA20_NRT') return SAT_N20
  if (source === 'VIIRS_NOAA21_NRT') return SAT_N21
  if (s === 'A' || s.startsWith('AQUA')) return SAT_AQUA
  if (s === 'T' || s.startsWith('TERRA')) return SAT_TERRA
  return -1
}

function confIndex(v: string, source: LiveSource): number {
  const s = v.trim().toLowerCase()
  if (source === 'MODIS_NRT') {
    const c = Number(s)
    if (!Number.isFinite(c)) return -1
    return c >= 80 ? 2 : c >= 30 ? 1 : 0
  }
  if (s === 'h' || s === 'high') return 2
  if (s === 'n' || s === 'nominal') return 1
  if (s === 'l' || s === 'low') return 0
  return -1
}

/** "455" -> 04:55, "0" -> 00:00. Returns epoch seconds or NaN. */
export function acqEpoch(date: string, time: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const tt = time.trim()
  if (!m || !/^\d{1,4}$/.test(tt)) return NaN
  const p = tt.padStart(4, '0')
  const hh = Number(p.slice(0, 2)), mm = Number(p.slice(2))
  if (hh > 23 || mm > 59) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) / 1000
}

export class UpstreamFormatError extends Error {}

/** Parses a FIRMS NRT area CSV. Header-only = no rows. A body that is not CSV throws UpstreamFormatError. */
export function parseFirmsCsv(text: string, source: LiveSource, bbox?: [number, number, number, number]): ParsedCsv {
  const out: ParsedCsv = { lat: [], lon: [], t: [], sat: [], conf: [], frp: [], dn: [] }
  const body = text.trimStart() // also strips a BOM (U+FEFF is whitespace in JS)
  if (!body.startsWith('latitude,')) {
    const first = body.split(/\r?\n/, 1)[0].replace(/[^\x20-\x7E]/g, '').trim().slice(0, 160)
    throw new UpstreamFormatError(first || 'empty response')
  }
  const lines = body.split(/\r?\n/)
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase())
  const col = (name: string) => head.indexOf(name)
  const iLat = col('latitude'), iLon = col('longitude'), iDate = col('acq_date'), iTime = col('acq_time')
  const iSat = col('satellite'), iConf = col('confidence'), iFrp = col('frp'), iDn = col('daynight')
  if ([iLat, iLon, iDate, iTime, iConf].some((i) => i < 0)) throw new UpstreamFormatError('unexpected CSV header')
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]
    if (!line) continue
    const f = line.split(',')
    const lat = Number(f[iLat]), lon = Number(f[iLon])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    if (bbox && (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3])) continue
    const t = acqEpoch(f[iDate] ?? '', f[iTime] ?? '')
    if (!Number.isFinite(t)) continue
    const sat = satIndex(iSat >= 0 ? f[iSat] ?? '' : '', source)
    const conf = confIndex(f[iConf] ?? '', source)
    if (sat < 0 || conf < 0) continue
    const frp = iFrp >= 0 ? Number(f[iFrp]) : NaN
    const dnRaw = iDn >= 0 ? (f[iDn] ?? '').trim().toUpperCase() : ''
    out.lat.push(Math.round(lat * 1e5) / 1e5)
    out.lon.push(Math.round(lon * 1e5) / 1e5)
    out.t.push(t)
    out.sat.push(sat)
    out.conf.push(conf)
    out.frp.push(Number.isFinite(frp) ? Math.round(frp * 10) / 10 : 0)
    out.dn.push(dnRaw === 'N' ? 1 : 0)
  }
  return out
}

// ---------------------------------------------------------------- upstream

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** FIRMS allows 1..5 days per call: split longer windows. Without a start date the range ends today (UTC). */
export function plannedCalls(days: number, nowMs: number): { range: number; start?: string }[] {
  if (days <= FIRMS_MAX_RANGE) return [{ range: days }]
  const today0 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  return [{ range: FIRMS_MAX_RANGE }, { range: days - FIRMS_MAX_RANGE, start: isoDay(today0 - (days - 1) * 86400_000) }]
}

function areaUrl(key: string, source: LiveSource, bbox: number[], call: { range: number; start?: string }): string {
  return `${FIRMS}/api/area/csv/${key}/${source}/${bbox.join(',')}/${call.range}${call.start ? `/${call.start}` : ''}`
}

async function fetchSource(key: string, source: LiveSource, p: LiveParams, f: typeof fetch, nowMs: number): Promise<ParsedCsv> {
  const merged: ParsedCsv = { lat: [], lon: [], t: [], sat: [], conf: [], frp: [], dn: [] }
  for (const call of plannedCalls(p.days, nowMs)) {
    upstreamRequests++
    const res = await f(areaUrl(key, source, p.bbox, call), { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
    const text = await res.text()
    if (!res.ok) throw new UpstreamFormatError(`HTTP ${res.status}`)
    const part = parseFirmsCsv(text, source, p.bbox)
    for (const k of Object.keys(merged) as (keyof ParsedCsv)[]) append(merged[k], part[k])
  }
  return merged
}

/** Share of the 10-minute transaction budget in use (null = unknown). Cached for a minute. */
async function usageShare(key: string, f: typeof fetch, nowMs: number): Promise<number | null> {
  if (usage && nowMs - usage.at < USAGE_TTL_MS) return usage.share
  let share: number | null = null
  try {
    const res = await f(`${FIRMS}/mapserver/mapkey_status/?MAP_KEY=${key}`, { signal: AbortSignal.timeout(8000) })
    const j = (await res.json()) as { transaction_limit?: number; current_transactions?: number }
    if (typeof j.transaction_limit === 'number' && typeof j.current_transactions === 'number' && j.transaction_limit > 0) {
      share = j.current_transactions / j.transaction_limit
    }
  } catch { /* unknown usage does not block */ }
  usage = { at: nowMs, share }
  return share
}

function takeRateSlot(nowMs: number): void {
  while (hits.length && nowMs - hits[0] >= RATE.windowMs) hits.shift()
  if (hits.length >= RATE.max) {
    throw new LiveError(429, 'rate_limited', 'too many live requests', {}, Math.max(1, Math.ceil((RATE.windowMs - (nowMs - hits[0])) / 1000)))
  }
  hits.push(nowMs)
}

function remember(key: string, e: Entry): void {
  cache.delete(key)
  cache.set(key, e)
  const cutoff = Date.now() - STALE_KEEP_MS
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX && v.at >= cutoff) break
    cache.delete(k)
  }
}

async function fetchAll(key: string, p: LiveParams, f: typeof fetch, nowMs: number): Promise<LiveResponse> {
  const settled = await Promise.allSettled(LIVE_SOURCES.map((s) => fetchSource(key, s, p, f, nowMs)))
  const sources = {} as Record<LiveSource, LiveSourceInfo>
  const parts: ParsedCsv[] = []
  settled.forEach((r, i) => {
    const s = LIVE_SOURCES[i]
    if (r.status === 'fulfilled') { sources[s] = { rows: r.value.t.length }; parts.push(r.value) }
    else {
      const e = r.reason
      const msg = e instanceof UpstreamFormatError ? e.message
        : e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out'
        : 'network error'
      sources[s] = { rows: 0, error: redact(msg, key) }
    }
  })
  if (!parts.length) throw new LiveError(502, 'upstream_error', 'all FIRMS sources failed: ' + LIVE_SOURCES.map((s) => sources[s].error).join('; '))

  // Merge, newest first.
  const all: ParsedCsv = { lat: [], lon: [], t: [], sat: [], conf: [], frp: [], dn: [] }
  for (const part of parts) for (const k of Object.keys(all) as (keyof ParsedCsv)[]) append(all[k], part[k])
  const order = all.t.map((_, i) => i).sort((a, b) => all.t[b] - all.t[a])
  const pick = (arr: number[]) => order.map((i) => arr[i])
  const today0 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  return {
    v: 1,
    bbox: p.bbox,
    days: p.days,
    fetched_at: Math.floor(nowMs / 1000),
    latest_t: all.t.length ? all.t[order[0]] : null,
    window_start: (today0 - (p.days - 1) * 86400_000) / 1000,
    sources,
    cached: false,
    stale: false,
    n: order.length,
    lat: pick(all.lat), lon: pick(all.lon), t: pick(all.t), sat: pick(all.sat), conf: pick(all.conf), frp: pick(all.frp), dn: pick(all.dn),
  }
}

/**
 * @param query untrusted query string (bbox, days)
 * @throws LiveError
 */
export async function getLive(query: URLSearchParams, env: LiveEnv, deps: LiveDeps = {}): Promise<LiveResponse> {
  const p = parseLiveParams(query) // validate before anything else: a bad request is a 400 even without a key
  const key = env.FIRMS_MAP_KEY?.trim()
  if (!key || !liveAvailable(env)) throw new LiveError(503, 'no_key')
  const f = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const ck = `${p.bbox.join(',')}|${p.days}`

  const hit = cache.get(ck)
  if (hit && now() - hit.at < hit.ttlMs) {
    cache.delete(ck); cache.set(ck, hit) // LRU touch
    return { ...hit.data, cached: true }
  }
  const serveStale = (e: unknown): LiveResponse => {
    const err = e instanceof LiveError ? e : new LiveError(502, 'upstream_error', redact(e instanceof Error ? e.name : 'error', key))
    if (hit && now() - hit.at < STALE_KEEP_MS) return { ...hit.data, cached: true, stale: true }
    throw err
  }

  // Concurrent requests for the same snapped box share one upstream job (registered before any await).
  const pending = inflight.get(ck)
  if (pending) {
    try { return { ...(await pending), cached: true } } catch (e) { return serveStale(e) }
  }
  // The shared job is not tied to one client's connection: it completes and fills the cache even if that client leaves.
  const job = (async () => {
    const share = await usageShare(key, f, now())
    if (share != null && share >= BUSY_SHARE) {
      throw new LiveError(503, 'busy', `FIRMS key usage at ${Math.round(share * 100)} % of its 10-minute budget`, {}, 120)
    }
    takeRateSlot(now())
    const data = await fetchAll(key, p, f, now())
    const partial = LIVE_SOURCES.some((s) => data.sources[s].error)
    remember(ck, { at: now(), ttlMs: partial ? PARTIAL_TTL_MS : LIVE_LIMITS.ttlSec * 1000, data })
    return data
  })()
  inflight.set(ck, job)
  try {
    return await job
  } catch (e) {
    return serveStale(e)
  } finally {
    inflight.delete(ck)
  }
}

/** Seconds the browser may keep this response (what is left of the server cache lifetime). */
export function liveMaxAge(r: LiveResponse, nowMs = Date.now()): number {
  if (r.stale) return 60
  const partial = LIVE_SOURCES.some((s) => r.sources[s].error)
  const ttl = partial ? PARTIAL_TTL_MS / 1000 : LIVE_LIMITS.ttlSec
  return Math.max(0, Math.min(ttl, Math.round(r.fetched_at + ttl - nowMs / 1000)))
}

/** Never throws and never calls upstream. */
export function liveStatus(env: LiveEnv): LiveStatus {
  let latest: number | null = null
  const now = Date.now()
  for (const e of cache.values()) {
    if (now - e.at < e.ttlMs && e.data.latest_t != null && (latest == null || e.data.latest_t > latest)) latest = e.data.latest_t
  }
  return { available: liveAvailable(env), sources: LIVE_SOURCES, latest_t: latest, limits: LIVE_LIMITS, upstream_requests: upstreamRequests }
}
