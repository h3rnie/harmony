// Provider-agnostic contract. Adapters (anthropic.ts, openrouter.ts) implement AiProvider; core.ts only sees this.
import type { ChatTurn } from '../../src/lib/brief/dossierTypes.ts'

export type { ChatTurn }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ProviderId = 'anthropic' | 'openrouter'

export interface Usage {
  /** Prompt tokens that were NOT served from or written to the cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface StreamArgs {
  /** Stable block 1: role, rules, glossary, method caveats. Identical for every request (cache breakpoint 1). */
  system: string
  /** Stable block 2: the area dossier as canonical JSON. Identical for the same area/options (cache breakpoint 2). */
  context: string
  /** The variable part: the task and/or conversation turns. Never cached. */
  messages: ChatTurn[]
  model: string
  maxTokens: number
  effort?: Effort
  signal?: AbortSignal
  /** Receives raw text deltas as they stream (for JSON mode: fragments of the JSON document). */
  onText?: (delta: string) => void
  /** Ask for a JSON document matching this schema (structured outputs on Anthropic, response_format on OpenRouter). */
  json?: { name: string; schema: Record<string, unknown> }
  /** Cache lifetime for the two breakpoints. Default 5m. */
  cacheTtl?: '5m' | '1h'
}

export interface StreamResult {
  text: string
  usage: Usage
  /** The model that actually served the request, as reported by the provider. */
  model: string
  /** Cache accounting as reported by the provider; null when it reports none. */
  cache: { read: number; write: number } | null
  stopReason: string | null
}

export interface AiProvider {
  readonly id: ProviderId
  streamText(args: StreamArgs): Promise<StreamResult>
}

/**
 * kind -> meaning
 *  rate_limit / overloaded / server / timeout / network : transient, retried once, then the fallback provider
 *  auth / bad_request                                   : configuration or request problem, never retried
 *  refused / truncated / empty                          : the model answered unusably; the caller shows the rule-based brief
 *  aborted                                              : the client went away
 */
export type ProviderErrorKind =
  | 'rate_limit' | 'overloaded' | 'server' | 'timeout' | 'network'
  | 'auth' | 'bad_request' | 'refused' | 'truncated' | 'empty' | 'aborted'

const TRANSIENT: readonly ProviderErrorKind[] = ['rate_limit', 'overloaded', 'server', 'timeout', 'network']

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly status: number | undefined
  constructor(kind: ProviderErrorKind, status?: number, detail?: string) {
    super(detail ?? kind)
    this.kind = kind
    this.status = status
  }
  get transient(): boolean { return TRANSIENT.includes(this.kind) }
}

/** HTTP status -> kind, shared by both adapters. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status === 529 || status === 503) return 'overloaded'
  if (status >= 500) return 'server'
  return 'bad_request'
}
