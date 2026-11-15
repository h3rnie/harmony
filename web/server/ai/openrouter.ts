// OpenRouter adapter: OpenAI-compatible Chat Completions over plain fetch + SSE parsing (no extra SDK).
//
// Verified against OpenRouter's docs (see the report): POST {base}/chat/completions, Bearer auth, optional
// HTTP-Referer / X-Title headers, SSE with ": comment" keep-alive lines and a final "data: [DONE]", usage in the last
// chunk before [DONE], mid-stream errors as a data event with a top-level `error` and finish_reason "error".
//
// Caching: Anthropic models on OpenRouter accept the same `cache_control: {type:'ephemeral'}` breakpoints on content
// parts (system message as an array of text parts). We send them only for `anthropic/…` slugs. Cache accounting comes
// back in usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}; prompt_tokens INCLUDES both.
// Parameters: OpenRouter lists no `temperature` for the Claude 5.x slugs, and we send none. Effort goes in the unified
// `reasoning: { effort }` parameter.
import { kindForStatus, ProviderError, type AiProvider, type StreamArgs, type StreamResult } from './types.ts'

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
const REQUEST_TIMEOUT_MS = 120_000

export interface OpenRouterOptions {
  apiKey: string
  /** Test hook / proxy: defaults to https://openrouter.ai/api/v1 */
  baseUrl?: string
  /** Sent as HTTP-Referer (identifies the app on openrouter.ai). */
  referer?: string
  /** Sent as X-Title. */
  title?: string
}

interface ChunkUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
}
interface Chunk {
  model?: string
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: ChunkUsage | null
  error?: { code?: number; message?: string; metadata?: { error_type?: string } }
}

function kindForErrorCode(code: number | undefined): ProviderError {
  const status = typeof code === 'number' ? code : 502
  return new ProviderError(kindForStatus(status), status, 'openrouter status ' + String(status))
}

export function createOpenRouterProvider(o: OpenRouterOptions): AiProvider {
  const base = (o.baseUrl || OPENROUTER_BASE).replace(/\/+$/, '')
  return {
    id: 'openrouter',
    async streamText(a: StreamArgs): Promise<StreamResult> {
      const anthropicModel = a.model.startsWith('anthropic/')
      const cc = { type: 'ephemeral', ...(a.cacheTtl === '1h' ? { ttl: '1h' } : {}) }
      const systemMessage = anthropicModel
        ? { role: 'system', content: [{ type: 'text', text: a.system, cache_control: cc }, { type: 'text', text: a.context, cache_control: cc }] }
        : { role: 'system', content: `${a.system}\n\n${a.context}` }
      const body: Record<string, unknown> = {
        model: a.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: a.maxTokens,
        messages: [systemMessage, ...a.messages.map((m) => ({ role: m.role, content: m.content }))],
      }
      if (a.effort) body.reasoning = { effort: a.effort }
      if (a.json) body.response_format = { type: 'json_schema', json_schema: { name: a.json.name, strict: true, schema: a.json.schema } }

      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
      if (a.signal) signals.push(a.signal)
      const signal = AbortSignal.any(signals)

      const headers: Record<string, string> = {
        Authorization: `Bearer ${o.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }
      if (o.referer) headers['HTTP-Referer'] = o.referer
      if (o.title) headers['X-Title'] = o.title

      const st = { text: '', usage: null as ChunkUsage | null, model: a.model, finish: null as string | null }
      try {
        const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
        if (!res.ok) {
          let code: number | undefined = res.status
          try { const j = (await res.json()) as Chunk; if (typeof j.error?.code === 'number') code = j.error.code } catch { /* not JSON */ }
          throw kindForErrorCode(code)
        }
        if (!res.body) throw new ProviderError('network')
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        const handleLine = (line: string): void => {
          if (!line.startsWith('data:')) return // blank lines and ": OPENROUTER PROCESSING" comments
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') return
          let ch: Chunk
          try { ch = JSON.parse(payload) as Chunk } catch { return }
          if (ch.error) throw kindForErrorCode(ch.error.code)
          if (ch.model) st.model = ch.model
          const c = ch.choices?.[0]
          const d = c?.delta?.content
          if (typeof d === 'string' && d) { st.text += d; a.onText?.(d) }
          if (c?.finish_reason) st.finish = c.finish_reason
          if (ch.usage) st.usage = ch.usage
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (value) {
            buf += dec.decode(value, { stream: !done })
            let nl: number
            while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl).replace(/\r$/, '')); buf = buf.slice(nl + 1) }
          }
          if (done) break
        }
        if (buf.trim()) handleLine(buf.replace(/\r$/, ''))
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (a.signal?.aborted) throw new ProviderError('aborted')
        if (e instanceof DOMException && e.name === 'TimeoutError') throw new ProviderError('timeout')
        if (e instanceof DOMException && e.name === 'AbortError') throw new ProviderError('aborted')
        throw new ProviderError('network', undefined, e instanceof Error ? e.name : 'error')
      }

      if (st.finish === 'error') throw new ProviderError('server')
      if (st.finish === 'length') throw new ProviderError('truncated')
      if (st.finish === 'content_filter') throw new ProviderError('refused')
      if (!st.text.trim()) throw new ProviderError('empty')

      const u: ChunkUsage = st.usage ?? {}
      const details = u.prompt_tokens_details
      const read = details?.cached_tokens ?? 0
      const write = details?.cache_write_tokens ?? 0
      const prompt = u.prompt_tokens ?? 0
      return {
        text: st.text,
        usage: { input: Math.max(0, prompt - read - write), output: u.completion_tokens ?? 0, cacheRead: read, cacheWrite: write },
        model: st.model,
        cache: details ? { read, write } : null,
        stopReason: st.finish,
      }
    },
  }
}
