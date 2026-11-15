// Provider / model / profile selection from server env. Nothing here reads files: the plugin hands in the env
// (repo-root .env.local, then .env, then process env). Keys are used only to construct adapters.
import { createAnthropicProvider } from './anthropic.ts'
import { createOpenRouterProvider, OPENROUTER_BASE } from './openrouter.ts'
import type { AiProvider, Effort, ProviderId } from './types.ts'

export interface AiEnv {
  /** anthropic (default) | openrouter */
  AI_PROVIDER?: string
  /** Overrides the model for the primary provider. BRIEF_MODEL is accepted as an alias. */
  AI_MODEL?: string
  /** Named model+effort profile, see PROFILES. Default sonnet-high. */
  AI_PROFILE?: string
  /** Ordered fallback provider, used only after a transient failure (outage / 5xx / 429) and one retry. */
  AI_FALLBACK?: string
  /** Model override for the fallback provider (slugs differ between providers). */
  AI_FALLBACK_MODEL?: string
  /** 5m (default) | 1h: lifetime of the prompt-cache breakpoints. */
  AI_CACHE_TTL?: string
  BRIEF_MODEL?: string
  ANTHROPIC_API_KEY?: string
  OPENROUTER_API_KEY?: string
  /** Sent as HTTP-Referer to OpenRouter. */
  OPENROUTER_REFERER?: string
  /** Test hook: point the OpenRouter adapter at a local mock server. */
  OPENROUTER_BASE_URL?: string
}

export interface Profile {
  label: string
  anthropic: { model: string; effort: Effort }
  /** OpenRouter slugs verified against https://openrouter.ai/api/v1/models (see the report). */
  openrouter: { model: string; effort: Effort }
}

/** The owner's decision: Sonnet 5.5 at high effort by default; Opus 5.5 at medium effort as the documented alternative. */
export const PROFILES = {
  'sonnet-high': {
    label: 'Claude Sonnet 5.5, high effort',
    anthropic: { model: 'claude-sonnet-5-5', effort: 'high' },
    openrouter: { model: 'anthropic/claude-sonnet-5.5', effort: 'high' },
  },
  'opus-medium': {
    label: 'Claude Opus 5.5, medium effort',
    anthropic: { model: 'claude-opus-5-5', effort: 'medium' },
    openrouter: { model: 'anthropic/claude-opus-5.5', effort: 'medium' },
  },
} as const satisfies Record<string, Profile>

export type ProfileName = keyof typeof PROFILES
export const DEFAULT_PROFILE: ProfileName = 'sonnet-high'

export interface Target {
  provider: AiProvider
  id: ProviderId
  model: string
  effort: Effort
}

export interface AiConfig {
  profile: ProfileName
  /** Null when the primary provider has no key: the AI features are unavailable (rule-based brief only). */
  primary: Target | null
  /** Null unless AI_FALLBACK names a different, configured provider. */
  fallback: Target | null
  cacheTtl: '5m' | '1h'
  /** Why `primary` is null, for the status endpoint. Never contains a key. */
  problem: 'no_key' | 'bad_provider' | null
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,79}$/
const clean = (s: string | undefined): string => (s ?? '').trim()

function providerId(s: string | undefined, dflt: ProviderId | null): ProviderId | null | 'invalid' {
  const v = clean(s).toLowerCase()
  if (!v) return dflt
  return v === 'anthropic' || v === 'openrouter' ? v : 'invalid'
}

function target(id: ProviderId, env: AiEnv, profile: ProfileName, modelOverride: string): Target | null {
  const p = PROFILES[profile]
  const spec = id === 'anthropic' ? p.anthropic : p.openrouter
  const model = MODEL_RE.test(modelOverride) ? modelOverride : spec.model
  if (id === 'anthropic') {
    const key = clean(env.ANTHROPIC_API_KEY)
    return key ? { provider: createAnthropicProvider(key), id, model, effort: spec.effort } : null
  }
  const key = clean(env.OPENROUTER_API_KEY)
  if (!key) return null
  const provider = createOpenRouterProvider({
    apiKey: key,
    baseUrl: clean(env.OPENROUTER_BASE_URL) || OPENROUTER_BASE,
    referer: clean(env.OPENROUTER_REFERER) || 'https://harmony.hernie.me',
    title: 'Harmony',
  })
  return { provider, id, model, effort: spec.effort }
}

export function resolveConfig(env: AiEnv): AiConfig {
  const wanted = clean(env.AI_PROFILE)
  const profile: ProfileName = (wanted in PROFILES ? wanted : DEFAULT_PROFILE) as ProfileName
  const cacheTtl = clean(env.AI_CACHE_TTL) === '1h' ? '1h' : '5m'
  const pid = providerId(env.AI_PROVIDER, 'anthropic')
  if (pid === 'invalid' || pid === null) return { profile, primary: null, fallback: null, cacheTtl, problem: 'bad_provider' }
  const primary = target(pid, env, profile, clean(env.AI_MODEL) || clean(env.BRIEF_MODEL))
  const fid = providerId(env.AI_FALLBACK, null)
  const fallback = fid && fid !== 'invalid' && fid !== pid ? target(fid, env, profile, clean(env.AI_FALLBACK_MODEL)) : null
  return { profile, primary, fallback: primary ? fallback : null, cacheTtl, problem: primary ? null : 'no_key' }
}
