// Anthropic adapter (official SDK). Request shape:
//  - system = two text blocks, each with a cache breakpoint: [rules][area dossier]; the conversation / task is in
//    `messages`, after the last breakpoint, so only the variable tail is ever uncached.
//  - effort goes in output_config.effort; thinking is left at the model default (adaptive on Claude 5.x).
//  - no temperature / top_p / top_k (rejected on the 5.x models), no assistant prefill, no budget_tokens.
//  - structured output: output_config.format = { type: 'json_schema', schema }. Text deltas are the JSON text.
//  - usage: input_tokens is the uncached remainder; cache_read_input_tokens / cache_creation_input_tokens are separate.
// The API key is only ever passed to the SDK constructor; it is not stored on the adapter, logged or put in errors.
import Anthropic from '@anthropic-ai/sdk'
import { kindForStatus, ProviderError, type AiProvider, type StreamArgs, type StreamResult } from './types.ts'

const REQUEST_TIMEOUT_MS = 120_000

/** Models that take output_config.effort (Claude 4.6+ and the 5.x family). */
const EFFORT_MODELS = /^claude-(sonnet|opus|haiku|fable|mythos)-(5|4-[6-8])/

const clients = new Map<string, Anthropic>()
function getClient(apiKey: string): Anthropic {
  let c = clients.get(apiKey)
  if (!c) {
    // Retries are owned by core.ts (one retry, then the fallback provider), so the SDK does none of its own.
    c = new Anthropic({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS })
    clients.set(apiKey, c)
  }
  return c
}

function mapError(e: unknown, signal?: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e
  if (signal?.aborted) return new ProviderError('aborted')
  if (e instanceof Anthropic.APIUserAbortError) return new ProviderError('aborted')
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout')
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('network')
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0
    // Status only: SDK error messages are never forwarded to the client or logged verbatim.
    return new ProviderError(status ? kindForStatus(status) : 'server', status || undefined, 'anthropic status ' + String(status))
  }
  return new ProviderError('server', undefined, e instanceof Error ? e.name : 'error')
}

export function createAnthropicProvider(apiKey: string): AiProvider {
  return {
    id: 'anthropic',
    async streamText(a: StreamArgs): Promise<StreamResult> {
      const cc = { type: 'ephemeral' as const, ...(a.cacheTtl === '1h' ? { ttl: '1h' as const } : {}) }
      const outputConfig: Anthropic.OutputConfig = {}
      if (a.effort && EFFORT_MODELS.test(a.model)) outputConfig.effort = a.effort
      if (a.json) outputConfig.format = { type: 'json_schema', schema: a.json.schema }

      const params: Anthropic.MessageCreateParamsStreaming = {
        model: a.model,
        max_tokens: a.maxTokens,
        stream: true,
        system: [
          { type: 'text', text: a.system, cache_control: cc },
          { type: 'text', text: a.context, cache_control: cc },
        ],
        messages: a.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      }

      let message: Anthropic.Message
      try {
        const stream = getClient(apiKey).messages.stream(params, { signal: a.signal })
        if (a.onText) stream.on('text', (d) => a.onText!(d))
        message = await stream.finalMessage()
      } catch (e) {
        throw mapError(e, a.signal)
      }

      // The SDK returns the accumulated snapshot when the stream ends early; without message_delta there is no
      // stop_reason. Treat that as a cut-off connection (retried / falls back, never cached).
      if (message.stop_reason == null) throw new ProviderError('network', undefined, 'stream ended without a stop_reason')
      if (message.stop_reason === 'refusal') throw new ProviderError('refused')
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') throw new ProviderError('truncated')
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      if (!text.trim()) throw new ProviderError('empty')
      const u = message.usage
      const read = u.cache_read_input_tokens ?? 0
      const write = u.cache_creation_input_tokens ?? 0
      return {
        text,
        usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: read, cacheWrite: write },
        model: message.model || a.model,
        cache: { read, write },
        stopReason: message.stop_reason,
      }
    },
  }
}
