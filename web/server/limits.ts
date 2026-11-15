// Shared counters for the deployed routes: per-visitor rate limits and the hard daily cap on AI requests.
//
// Store, first match wins:
//   1. REDIS_URL (redis:// or rediss://): any Redis over TCP, e.g. the free "Redis" (Redis Cloud) database from the
//      Vercel Marketplace, which injects REDIS_URL.
//   2. UPSTASH_REDIS_REST_URL / _TOKEN, or the KV_REST_API_URL / _TOKEN names the Upstash Marketplace integration
//      injects: Upstash Redis over its REST API.
//   3. Otherwise, and for any call where the store errors, an in-memory counter per process (per serverless instance):
//      the limits still hold per instance but are not global.
//
// Visitors are keyed on an HMAC-SHA256 of their IP address (never the raw address). The HMAC key is IP_HASH_SECRET, or
// the store token when that is unset, or a random per-process key in memory-only mode.
//
// Fixed windows: key = <prefix>:<window index>, created with SET NX EX then INCR, so a key never outlives its window.
import { createHmac, randomBytes } from 'node:crypto'
import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

export interface LimitsEnv {
  REDIS_URL?: string
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
  KV_REST_API_URL?: string
  KV_REST_API_TOKEN?: string
  IP_HASH_SECRET?: string
  /** Hard cap on AI requests that reach a model, per UTC day, across all instances. Default 300; 0 disables AI. */
  AI_DAILY_CAP?: string
}

/** Fixed-window counter store. */
export interface CounterStore {
  readonly kind: 'redis' | 'upstash' | 'memory'
  /** Increments `key` (created with a TTL of `ttlSec` when absent) and returns the new value. */
  incr(key: string, ttlSec: number): Promise<number>
  /** Current value, 0 when absent. */
  get(key: string): Promise<number>
}

export class MemoryStore implements CounterStore {
  readonly kind = 'memory' as const
  private m = new Map<string, { n: number; until: number }>()
  async incr(key: string, ttlSec: number): Promise<number> {
    const now = Date.now()
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k)
    const e = this.m.get(key)
    if (!e || e.until <= now) { this.m.set(key, { n: 1, until: now + ttlSec * 1000 }); return 1 }
    e.n++
    return e.n
  }
  async get(key: string): Promise<number> {
    const e = this.m.get(key)
    return e && e.until > Date.now() ? e.n : 0
  }
}

class UpstashStore implements CounterStore {
  readonly kind = 'upstash' as const
  private r: Redis
  constructor(url: string, token: string) {
    this.r = new Redis({ url, token, automaticDeserialization: false, enableTelemetry: false, retry: { retries: 1, backoff: () => 100 } })
  }
  async incr(key: string, ttlSec: number): Promise<number> {
    const p = this.r.pipeline()
    p.set(key, 0, { nx: true, ex: ttlSec })
    p.incr(key)
    const out = await p.exec()
    return Number(out[1])
  }
  async get(key: string): Promise<number> {
    const v = await this.r.get<string>(key)
    return v == null ? 0 : Number(v) || 0
  }
}

/** Redis over TCP. One lazily opened connection per instance, reused across invocations (Fluid Compute). */
class TcpRedisStore implements CounterStore {
  readonly kind = 'redis' as const
  private client: ReturnType<typeof createClient>
  private ready: Promise<unknown> | null = null
  constructor(url: string) {
    this.client = createClient({
      url,
      socket: { connectTimeout: 2000, reconnectStrategy: (retries: number) => (retries > 3 ? false : 200 * (retries + 1)) },
      disableOfflineQueue: true,
    })
    // Errors surface on the command promises; this only keeps an emitted 'error' from crashing the instance.
    this.client.on('error', () => {})
  }
  private async conn() {
    if (!this.client.isOpen) {
      this.ready ??= this.client.connect().finally(() => { this.ready = null })
      await this.ready
    }
    return this.client
  }
  private timed<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500).unref())])
  }
  async incr(key: string, ttlSec: number): Promise<number> {
    const c = await this.timed(this.conn())
    const out = await this.timed(c.multi().set(key, '0', { condition: 'NX', expiration: { type: 'EX', value: ttlSec } }).incr(key).exec())
    return Number(out[1])
  }
  async get(key: string): Promise<number> {
    const c = await this.timed(this.conn())
    const v = await this.timed(c.get(key))
    return v == null ? 0 : Number(v) || 0
  }
}

/** Falls back to memory for the call that failed (logged once per process, without details that could carry secrets). */
class FallbackStore implements CounterStore {
  readonly kind: 'redis' | 'upstash'
  private warned = false
  private primary: CounterStore
  private backup: CounterStore
  private log: (s: string) => void
  constructor(primary: CounterStore, backup: CounterStore, log: (s: string) => void) {
    this.primary = primary
    this.kind = primary.kind === 'upstash' ? 'upstash' : 'redis'
    this.backup = backup
    this.log = log
  }
  /** After a failure the shared store is skipped for 30 s, so an outage costs one timeout, not one per request. */
  private downUntil = 0
  private warn(e: unknown) {
    this.downUntil = Date.now() + 30_000
    if (this.warned) return
    this.warned = true
    this.log(`[limits] shared store unavailable (${e instanceof Error ? e.name : 'error'}); using per-instance counters`)
  }
  async incr(key: string, ttlSec: number) {
    if (Date.now() < this.downUntil) return this.backup.incr(key, ttlSec)
    try { return await this.primary.incr(key, ttlSec) } catch (e) { this.warn(e); return this.backup.incr(key, ttlSec) }
  }
  async get(key: string) {
    if (Date.now() < this.downUntil) return this.backup.get(key)
    try { return await this.primary.get(key) } catch (e) { this.warn(e); return this.backup.get(key) }
  }
}

const clean = (s: string | undefined) => (s ?? '').trim()
let cached: { sig: string; store: CounterStore } | null = null
const memory = new MemoryStore()
const processKey = randomBytes(32)

export function getStore(env: LimitsEnv, log: (s: string) => void = console.log): CounterStore {
  const tcp = clean(env.REDIS_URL)
  const url = clean(env.UPSTASH_REDIS_REST_URL) || clean(env.KV_REST_API_URL)
  const token = clean(env.UPSTASH_REDIS_REST_TOKEN) || clean(env.KV_REST_API_TOKEN)
  const useTcp = tcp.startsWith('redis://') || tcp.startsWith('rediss://')
  const sig = useTcp ? `tcp|${tcp.length}|${tcp.slice(-12)}` : url && token ? `rest|${url}|${token.length}` : 'memory'
  if (cached?.sig === sig) return cached.store
  const store: CounterStore = useTcp ? new FallbackStore(new TcpRedisStore(tcp), memory, log)
    : url && token ? new FallbackStore(new UpstashStore(url, token), memory, log) : memory
  cached = { sig, store }
  return store
}

// ---------------------------------------------------------------- visitors

/** The client address as the platform reports it (x-vercel-forwarded-for cannot be set by the client on Vercel). */
export function clientIp(headers: Headers): string {
  const first = (v: string | null) => (v ?? '').split(',')[0].trim()
  return first(headers.get('x-vercel-forwarded-for')) || first(headers.get('x-real-ip')) || first(headers.get('x-forwarded-for')) || 'unknown'
}

/** 32 hex chars of HMAC-SHA256(secret, ip). The raw address is never stored or logged. */
export function visitorId(ip: string, env: LimitsEnv): string {
  const secret = clean(env.IP_HASH_SECRET) || clean(env.REDIS_URL) || clean(env.UPSTASH_REDIS_REST_TOKEN) || clean(env.KV_REST_API_TOKEN)
  return createHmac('sha256', secret || processKey).update(ip).digest('hex').slice(0, 32)
}

export interface Window { max: number; sec: number }

/** Per-visitor windows. Several windows may apply to one route; every one must pass. */
export const VISITOR_LIMITS = {
  /** /api/brief POST + /api/ask POST together (cache hits included: cheap, but they still cost an invocation). */
  ai: [{ max: 20, sec: 600 }, { max: 60, sec: 86_400 }],
  /** /api/live (the client refreshes every 10 minutes per area; area changes add requests). */
  live: [{ max: 40, sec: 600 }, { max: 400, sec: 86_400 }],
} as const satisfies Record<string, readonly Window[]>

export interface Verdict { ok: boolean; retryAfterSec: number }

/** Counts this request in every window of `route`; refuses when any window is over its limit. */
export async function takeVisitorSlot(store: CounterStore, route: keyof typeof VISITOR_LIMITS, visitor: string, nowMs = Date.now()): Promise<Verdict> {
  let retry = 0
  for (const w of VISITOR_LIMITS[route]) {
    const idx = Math.floor(nowMs / 1000 / w.sec)
    const n = await store.incr(`harmony:v:${route}:${w.sec}:${idx}:${visitor}`, w.sec + 5)
    if (n > w.max) retry = Math.max(retry, Math.ceil((idx + 1) * w.sec - nowMs / 1000))
  }
  return { ok: retry === 0, retryAfterSec: Math.max(1, retry) }
}

// ---------------------------------------------------------------- daily AI cap

export const DEFAULT_AI_DAILY_CAP = 300

export function dailyCap(env: LimitsEnv): number {
  const raw = clean(env.AI_DAILY_CAP)
  if (!raw) return DEFAULT_AI_DAILY_CAP
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_AI_DAILY_CAP
}

const dayKey = (nowMs: number) => `harmony:ai:day:${new Date(nowMs).toISOString().slice(0, 10)}`
/** Seconds until the next UTC midnight (when the cap resets). */
export function secondsToUtcMidnight(nowMs = Date.now()): number {
  const d = new Date(nowMs)
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs) / 1000))
}

/** Requests counted today (UTC). */
export async function dailyUsed(store: CounterStore, nowMs = Date.now()): Promise<number> {
  return store.get(dayKey(nowMs))
}

/** Counts one model-bound request; false when today's cap is already used up. */
export async function takeDailySlot(store: CounterStore, cap: number, nowMs = Date.now()): Promise<boolean> {
  if (cap <= 0) return false
  const n = await store.incr(dayKey(nowMs), 2 * 86_400)
  return n <= cap
}
