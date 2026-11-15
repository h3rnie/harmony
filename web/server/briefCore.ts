// Framework-agnostic core of POST /api/brief: validate -> cache -> rate limit -> Claude -> plain text.
// No Vite, Node http or Svelte imports here, so the same function can back a serverless handler
// (Vercel / Netlify / Cloudflare with nodejs_compat): call getBrief(body, { ANTHROPIC_API_KEY, BRIEF_MODEL }).
// The API key only ever comes in through `env`; it is never logged, returned or placed in an error message.
import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'node:crypto'
import type { BriefPayload } from '../src/lib/brief/payloadTypes.ts'
import { PAYLOAD_MAX_BYTES } from '../src/lib/brief/payloadTypes.ts'
import { BRIEF_SYSTEM_PROMPT, buildUserMessage } from './briefPrompt.ts'
import { PayloadError, validatePayload } from './briefValidate.ts'

/** Current Sonnet tier (claude-api skill, models table): fast, cheap, plenty for a 120-word summary. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

export interface BriefEnv {
  ANTHROPIC_API_KEY?: string
  /** Optional model override, e.g. claude-opus-5-5. */
  BRIEF_MODEL?: string
}

export interface BriefUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export interface BriefResult {
  text: string
  model: string
  usage: BriefUsage
  /** True when served from the in-memory response cache (no model call, usage is that of the original call). */
  cached: boolean
}

export interface BriefOptions {
  /** Receives text deltas as the model writes them (not called for cache hits). */
  onText?: (delta: string) => void
  /** Aborts the upstream request (e.g. client disconnected). */
  signal?: AbortSignal
  /** Skip the response cache (Regenerate). The new result replaces the cached one. */
  fresh?: boolean
}

/** error codes: no_key 503 · bad_request 400 · rate_limited 429 · upstream_error / refused / bad_output 502 */
export class BriefError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSec?: number
  constructor(status: number, code: string, message?: string, retryAfterSec?: number) {
    super(message ?? code)
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

const MAX_TOKENS_DEFAULT_MODEL = 500 // ~140 words is ~200 tokens; this leaves headroom without inviting rambling
const MAX_TOKENS_OTHER_MODEL = 2000 // models that cannot turn thinking off spend part of the budget on it
const RATE_LIMIT = { max: 10, windowMs: 60_000 }
const CACHE = { max: 200, ttlMs: 60 * 60_000 }
const REQUEST_TIMEOUT_MS = 30_000

/** In-memory state: per process (per serverless instance), by design. */
const hits: number[] = []
const cache = new Map<string, { at: number; result: BriefResult }>()
const clients = new Map<string, Anthropic>()

export function resetBriefState(): void {
  hits.length = 0
  cache.clear()
  clients.clear()
}

export function briefAvailable(env: BriefEnv): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim().length > 0
}

export function resolveModel(env: BriefEnv): string {
  const m = env.BRIEF_MODEL?.trim()
  return m && /^[a-z0-9][a-z0-9.\-]{0,63}$/.test(m) ? m : DEFAULT_MODEL
}

function takeRateSlot(now: number): void {
  while (hits.length && now - hits[0] >= RATE_LIMIT.windowMs) hits.shift()
  if (hits.length >= RATE_LIMIT.max) {
    throw new BriefError(429, 'rate_limited', 'too many requests', Math.max(1, Math.ceil((RATE_LIMIT.windowMs - (now - hits[0])) / 1000)))
  }
  hits.push(now)
}

function cacheKey(p: BriefPayload, model: string): string {
  return createHash('sha256').update(model).update('\0').update(JSON.stringify(p)).digest('hex')
}

function getClient(apiKey: string): Anthropic {
  let c = clients.get(apiKey)
  if (!c) {
    c = new Anthropic({ apiKey, maxRetries: 1, timeout: REQUEST_TIMEOUT_MS })
    clients.set(apiKey, c)
  }
  return c
}

/** Thinking off + low effort where the model supports it: a 120-word summary needs no reasoning budget. */
function tuning(model: string): Pick<Anthropic.MessageCreateParams, 'thinking' | 'output_config' | 'max_tokens'> {
  if (model === DEFAULT_MODEL) {
    return { max_tokens: MAX_TOKENS_DEFAULT_MODEL, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }
  }
  if (/^claude-(sonnet|opus|haiku|fable|mythos)-5/.test(model)) {
    return { max_tokens: MAX_TOKENS_OTHER_MODEL, output_config: { effort: 'low' } }
  }
  return { max_tokens: MAX_TOKENS_OTHER_MODEL }
}

/** Belt and braces: the prompt asks for plain text; strip any markdown that slips through. */
export function toPlainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_`]{1,3}([^*_`\n]+)[*_`]{1,3}/g, '$1')
    .replace(/[*`#]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length

/**
 * @param body untrusted, already JSON-parsed request body
 * @throws BriefError | PayloadError (status 400)
 */
export async function getBrief(body: unknown, env: BriefEnv, opts: BriefOptions = {}): Promise<BriefResult> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) throw new BriefError(503, 'no_key')

  // 1. Validate. Size is checked on the canonical form too, so non-HTTP callers get the same cap.
  let payload: BriefPayload
  try {
    if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > PAYLOAD_MAX_BYTES) throw new PayloadError('payload too large')
    payload = validatePayload(body)
  } catch (e) {
    if (e instanceof PayloadError) throw new BriefError(400, 'bad_request', e.message)
    throw e
  }

  // 2. Cache (does not count against the rate limit: it costs nothing).
  const model = resolveModel(env)
  const key = cacheKey(payload, model)
  const now = Date.now()
  if (!opts.fresh) {
    const hit = cache.get(key)
    if (hit && now - hit.at < CACHE.ttlMs) return { ...hit.result, cached: true }
    if (hit) cache.delete(key)
  }

  // 3. Rate limit, then the model call.
  takeRateSlot(now)
  const client = getClient(apiKey)
  let message: Anthropic.Message
  try {
    const stream = client.messages.stream(
      {
        model,
        ...tuning(model),
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(JSON.stringify(payload)) }],
      },
      { signal: opts.signal },
    )
    if (opts.onText) stream.on('text', (d) => opts.onText!(d))
    message = await stream.finalMessage()
  } catch (e) {
    if (opts.signal?.aborted) throw new BriefError(499, 'aborted')
    // Status and type only: error messages are not forwarded to the client or logged verbatim.
    const detail = e instanceof Anthropic.APIError ? 'status ' + String(e.status) : e instanceof Error ? e.name : 'error'
    throw new BriefError(502, 'upstream_error', 'upstream ' + detail)
  }

  if (message.stop_reason === 'refusal') throw new BriefError(502, 'refused')
  if (message.stop_reason === 'max_tokens') throw new BriefError(502, 'bad_output', 'truncated')
  const text = toPlainText(message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''))
  const words = wordCount(text)
  if (words < 25 || words > 250) throw new BriefError(502, 'bad_output', `unexpected length (${words} words)`)

  const u = message.usage
  const result: BriefResult = {
    text,
    model: message.model || model,
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
    cached: false,
  }
  cache.set(key, { at: Date.now(), result })
  if (cache.size > CACHE.max) cache.delete(cache.keys().next().value as string)
  return result
}
