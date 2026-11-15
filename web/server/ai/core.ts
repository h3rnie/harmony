// Framework-agnostic core of POST /api/brief and POST /api/ask:
//   validate -> response cache -> rate limit -> provider (retry once, then fallback provider) -> validate output.
// No Vite, Node http or Svelte imports, so the same functions can back a serverless handler: pass the env in.
// API keys only ever come in through `env`; they are never logged, returned or placed in an error message.
//
// Failure policy
//  - transient provider failure (429 / 5xx / overload / timeout / network): retried once on the same provider, then
//    the ordered fallback (AI_FALLBACK) gets one go (two attempts). Never for validation or refusals.
//  - the model's draft fails validation (structure, lengths, numbers not in the statistics): ONE corrective retry on
//    the same provider, then the route answers 502 bad_output and the client shows the rule-based brief.
//  - Ask answers are streamed to the screen, so they cannot be retracted: ungrounded figures come back as a warning.
import { createHash } from 'node:crypto'
import type { Brief, ChatTurn, Dossier } from '../../src/lib/brief/dossierTypes.ts'
import { DOSSIER_MAX_BYTES } from '../../src/lib/brief/dossierTypes.ts'
import { resolveConfig, type AiConfig, type AiEnv, type Target } from './config.ts'
import { askPool, checkBrief, toPlainAnswer, ungroundedNumbers, wordCount } from './grounding.ts'
import { FieldStreamer } from './partialJson.ts'
import { askMessages, briefMessages, BRIEF_SCHEMA, buildContext, SYSTEM_PROMPT } from './prompt.ts'
import { ProviderError, type StreamArgs, type StreamResult, type Usage } from './types.ts'
import { canonicalDossier, PayloadError, validateConversation, validateDossier } from './validate.ts'
import { crossSiteReason, type HeaderBag } from '../sameOrigin.ts'

export type { AiEnv }

/** error codes: no_key / bad_config / daily_cap 503 · bad_request 400 · forbidden 403 · rate_limited 429 · upstream_error / refused / bad_output 502 */
export class AiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec: number | undefined
  constructor(status: number, code: string, message?: string, retryAfterSec?: number) {
    super(message ?? code)
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

export interface RunMeta {
  provider: string
  model: string
  profile: string
  /** Summed over every provider call made for this request (a corrective retry adds a second call). */
  usage: Usage
  /** Cache accounting of the LAST call (the one whose output was accepted); null when the provider reports none. */
  cache: { read: number; write: number } | null
  /** True when served from the in-memory response cache (no model call; usage is that of the original call). */
  cached: boolean
  /** Provider calls made (1 normally; 2 after a transient retry, a fallback or a corrective retry). */
  calls: number
  /** True when the fallback provider produced the answer. */
  fellBack: boolean
  ms: number
  dossierBytes: number
}

export interface BriefResult extends RunMeta { brief: Brief }
export interface AskResult extends RunMeta {
  text: string
  /** Figures in the answer that could not be matched to the statistics (empty when everything matched). */
  ungrounded: string[]
}

export interface RunHooks {
  /** Brief: text deltas of the headline / summary fields as the JSON streams. Ask: field is 'text'. */
  onDelta?: (field: string, text: string) => void
  /** The text so far must be discarded (retry after a failure or a rejected draft). */
  onReset?: () => void
  signal?: AbortSignal
  /** Skip the response cache (Regenerate). The new result replaces the cached one. */
  fresh?: boolean
  /** One-line, secret-free dev log. */
  log?: (line: string) => void
  /**
   * Called once per request that will reach a model (after the response cache and the per-process rate limit, before
   * the first provider call). A deployment uses it for its shared daily cap; throw an AiError to refuse.
   */
  admit?: (kind: 'brief' | 'ask') => Promise<void>
}

/**
 * Call first on every AI route (the status GET included): refuses cross-site browser requests with 403 forbidden
 * (see sameOrigin.ts). The JSON content type required on POST stays as a second line of defence.
 */
export function assertSameOrigin(headers: HeaderBag, allowedOrigins: readonly string[] = []): void {
  const why = crossSiteReason(headers, allowedOrigins)
  if (why) throw new AiError(403, 'forbidden', why)
}

const LIMITS = { brief: { max: 10, windowMs: 60_000 }, ask: { max: 20, windowMs: 60_000 } } as const
const CACHE = { max: 200, ttlMs: 60 * 60_000 }
const MAX_TOKENS = { brief: 10_000, ask: 8_000 } as const // thinking counts toward max_tokens; this leaves ample room
const RETRY_DELAY_MS = 700

type Kind = keyof typeof LIMITS

/** In-memory state: per process (per serverless instance), by design. */
const hits: Record<Kind, number[]> = { brief: [], ask: [] }
const cache = new Map<string, { at: number; result: BriefResult | AskResult }>()
const totals = { requests: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHits: 0 }

export function resetAiState(): void {
  hits.brief.length = 0
  hits.ask.length = 0
  cache.clear()
  Object.assign(totals, { requests: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHits: 0 })
}

function takeRateSlot(kind: Kind, now: number): void {
  const h = hits[kind]
  const { max, windowMs } = LIMITS[kind]
  while (h.length && now - h[0] >= windowMs) h.shift()
  if (h.length >= max) throw new AiError(429, 'rate_limited', 'too many requests', Math.max(1, Math.ceil((windowMs - (now - h[0])) / 1000)))
  h.push(now)
}

const sha = (...parts: string[]): string => {
  const h = createHash('sha256')
  parts.forEach((p) => h.update(p).update('\0'))
  return h.digest('hex')
}

/**
 * Public status (GET /api/brief): only what the page needs to offer the brief and Ask. Never a key, and no usage
 * counters or configuration detail; those go to the server log (`statusLogLine`).
 */
export interface AiStatus {
  available: boolean
  /** Ask Harmony is offered (same condition as `available`: a configured primary provider, cap not reached). */
  ask: boolean
  provider: string | null
  model: string | null
  profile: string
  /** The shared daily cap of AI requests is reached (until UTC midnight). */
  capReached: boolean
}

export function getStatus(env: AiEnv, o: { capReached?: boolean } = {}): AiStatus {
  const cfg = resolveConfig(env)
  const p = cfg.primary
  const capReached = p != null && o.capReached === true
  return {
    available: p != null && !capReached,
    ask: p != null && !capReached,
    provider: p?.id ?? null,
    model: p?.model ?? null,
    profile: cfg.profile,
    capReached,
  }
}

/** Server-log line for a status probe: configuration problems and the usage counters since process start. */
export function statusLogLine(env: AiEnv): string {
  const cfg = resolveConfig(env)
  const p = cfg.primary
  const fb = cfg.fallback ? `${cfg.fallback.id}/${cfg.fallback.model}` : 'none'
  return `status ${p ? `${p.id}/${p.model} effort=${p.effort ?? '-'}` : `unavailable (${cfg.problem ?? 'unknown'})`} fallback=${fb} ` +
    `cacheTtl=${cfg.cacheTtl} usage=${JSON.stringify(totals)}`
}

// ---------------------------------------------------------------- provider orchestration

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

const asProviderError = (e: unknown): ProviderError => (e instanceof ProviderError ? e : new ProviderError('server', undefined, e instanceof Error ? e.name : 'error'))

interface Generated { result: StreamResult; target: Target; calls: number }

/**
 * Defence in depth behind the adapters: a result whose stop reason says it is incomplete or failed is an error, so it
 * is retried / falls back like one and never reaches the response cache.
 */
function incompleteStop(stopReason: string | null): ProviderError | null {
  switch (stopReason) {
    case 'length': case 'max_tokens': case 'model_context_window_exceeded': return new ProviderError('truncated')
    case 'error': return new ProviderError('server')
    case 'refusal': case 'content_filter': return new ProviderError('refused')
    default: return null
  }
}

/** One logical generation: transient failures retry once on the same provider, then the fallback gets its turn. */
async function generate(
  cfg: AiConfig,
  base: Pick<StreamArgs, 'system' | 'context' | 'messages' | 'json'>,
  maxTokens: number,
  hooks: RunHooks,
  onText: (d: string) => void,
  reset: () => void,
): Promise<Generated> {
  const chain: Target[] = [cfg.primary as Target, ...(cfg.fallback ? [cfg.fallback] : [])]
  let last: ProviderError = new ProviderError('server')
  let calls = 0
  for (const target of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++
      try {
        const result = await target.provider.streamText({
          ...base, model: target.model, effort: target.effort, maxTokens, cacheTtl: cfg.cacheTtl, signal: hooks.signal, onText,
        })
        const bad = incompleteStop(result.stopReason)
        if (bad) throw bad
        return { result, target, calls }
      } catch (e) {
        const pe = asProviderError(e)
        if (hooks.signal?.aborted || pe.kind === 'aborted') throw new AiError(499, 'aborted')
        last = pe
        hooks.log?.(`${target.id} ${target.model} failed: ${pe.kind}${pe.status ? ' ' + String(pe.status) : ''}`)
        if (!pe.transient) throw toAiError(pe)
        reset()
        if (attempt === 0) await sleep(RETRY_DELAY_MS, hooks.signal)
      }
    }
  }
  throw toAiError(last)
}

function toAiError(pe: ProviderError): AiError {
  switch (pe.kind) {
    case 'refused': return new AiError(502, 'refused')
    case 'truncated':
    case 'empty': return new AiError(502, 'bad_output', pe.kind)
    case 'auth': return new AiError(502, 'upstream_error', 'upstream auth')
    default: return new AiError(502, 'upstream_error', 'upstream ' + pe.kind)
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

function record(u: Usage, calls: number): void {
  totals.requests++
  totals.calls += calls
  totals.input += u.input
  totals.output += u.output
  totals.cacheRead += u.cacheRead
  totals.cacheWrite += u.cacheWrite
}

function prepare(env: AiEnv): AiConfig {
  const cfg = resolveConfig(env)
  if (!cfg.primary) throw new AiError(503, cfg.problem === 'bad_provider' ? 'bad_config' : 'no_key')
  return cfg
}

function validated<T>(fn: () => T): T {
  try { return fn() } catch (e) {
    if (e instanceof PayloadError) throw new AiError(400, 'bad_request', e.message)
    throw e
  }
}

const cacheGet = <T extends BriefResult | AskResult>(key: string, fresh: boolean | undefined): T | null => {
  if (fresh) return null
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at >= CACHE.ttlMs) { cache.delete(key); return null }
  return hit.result as T
}
const cachePut = (key: string, result: BriefResult | AskResult): void => {
  cache.set(key, { at: Date.now(), result })
  if (cache.size > CACHE.max) cache.delete(cache.keys().next().value as string)
}

// ---------------------------------------------------------------- brief

/**
 * @param body untrusted, already JSON-parsed request body (the dossier)
 * @throws AiError
 */
export async function getBrief(body: unknown, env: AiEnv, hooks: RunHooks = {}): Promise<BriefResult> {
  const cfg = prepare(env)
  const started = Date.now()
  const dossier: Dossier = validated(() => validateDossier(body))
  const canon = canonicalDossier(dossier)
  const primary = cfg.primary as Target
  const key = sha('brief', primary.id, primary.model, primary.effort, canon)
  const hit = cacheGet<BriefResult>(key, hooks.fresh)
  if (hit) { totals.cacheHits++; return { ...hit, cached: true, ms: Date.now() - started } }

  takeRateSlot('brief', started)
  await hooks.admit?.('brief')
  const streamer = new FieldStreamer(['headline', 'summary'], (f, t) => hooks.onDelta?.(f, t))
  const reset = () => { streamer.reset(); hooks.onReset?.() }
  const context = buildContext(canon)
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let calls = 0
  let problems: string[] | undefined

  for (let round = 0; round < 2; round++) {
    if (round > 0) reset()
    const g = await generate(
      cfg,
      { system: SYSTEM_PROMPT, context, messages: briefMessages(problems), json: { name: 'situation_brief', schema: BRIEF_SCHEMA as unknown as Record<string, unknown> } },
      MAX_TOKENS.brief, hooks, (d) => streamer.push(d), reset,
    )
    calls += g.calls
    usage = addUsage(usage, g.result.usage)
    const check = checkBrief(g.result.text, dossier)
    if (check.brief && check.problems.length === 0) {
      record(usage, calls)
      const result: BriefResult = {
        brief: check.brief, provider: g.target.id, model: g.result.model, profile: cfg.profile, usage, cache: g.result.cache,
        cached: false, calls, fellBack: g.target.id !== primary.id, ms: Date.now() - started, dossierBytes: Buffer.byteLength(canon),
      }
      cachePut(key, result)
      return result
    }
    problems = check.problems
    hooks.log?.(`brief draft rejected (round ${round + 1}): ${problems.join(' | ')}`)
    hooks.log?.(`rejected draft: ${g.result.text.length} chars`)
  }
  record(usage, calls)
  throw new AiError(502, 'bad_output', (problems ?? []).join('; ').slice(0, 300))
}

// ---------------------------------------------------------------- ask

/**
 * @param body untrusted body: { dossier, messages }
 * @throws AiError
 */
export async function getAnswer(body: unknown, env: AiEnv, hooks: RunHooks = {}): Promise<AskResult> {
  const cfg = prepare(env)
  const started = Date.now()
  const { dossier, turns } = validated(() => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new PayloadError('body: expected object')
    const o = body as Record<string, unknown>
    for (const k of Object.keys(o)) if (k !== 'dossier' && k !== 'messages') throw new PayloadError(`body: unexpected field "${k}"`)
    return { dossier: validateDossier(o.dossier), turns: validateConversation(o.messages) as ChatTurn[] }
  })
  const canon = canonicalDossier(dossier)
  const primary = cfg.primary as Target
  const key = sha('ask', primary.id, primary.model, primary.effort, canon, JSON.stringify(turns), JSON.stringify(dossier.now ?? null))
  const hit = cacheGet<AskResult>(key, hooks.fresh)
  if (hit) { totals.cacheHits++; return { ...hit, cached: true, ms: Date.now() - started } }

  takeRateSlot('ask', started)
  await hooks.admit?.('ask')
  const context = buildContext(canon)
  const g = await generate(
    cfg,
    { system: SYSTEM_PROMPT, context, messages: askMessages(turns, dossier.now) },
    MAX_TOKENS.ask, hooks, (d) => hooks.onDelta?.('text', d), () => hooks.onReset?.(),
  )
  record(g.result.usage, g.calls)
  const text = toPlainAnswer(g.result.text)
  if (wordCount(text) < 1) throw new AiError(502, 'bad_output', 'empty')
  const userTexts = turns.filter((t) => t.role === 'user').map((t) => t.content)
  const ungrounded = [...new Set(ungroundedNumbers(text, askPool(dossier, userTexts)))].slice(0, 6)
  const result: AskResult = {
    text, ungrounded, provider: g.target.id, model: g.result.model, profile: cfg.profile, usage: g.result.usage, cache: g.result.cache,
    cached: false, calls: g.calls, fellBack: g.target.id !== primary.id, ms: Date.now() - started, dossierBytes: Buffer.byteLength(canon),
  }
  cachePut(key, result)
  return result
}

export { DOSSIER_MAX_BYTES }
