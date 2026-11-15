<script lang="ts">
  import { untrack } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { templateBrief, type BriefInput } from '../brief/template'
  import { buildBriefPayload, payloadKey, type BriefPayload } from '../brief/payload'
  import { BriefClientError, probeBrief, streamBrief } from '../brief/client'
  import { yearOf } from '../format'

  let { a }: { a: Analysis } = $props()

  /** Wait this long after the statistics stop changing before asking the model (month scrubbing, baseline drags). */
  const DEBOUNCE_MS = 900

  type Phase = 'idle' | 'loading' | 'streaming'
  /** null until the one-off probe has answered. */
  let available = $state<boolean | null>(null)
  let phase = $state<Phase>('idle')
  /** Finished Claude brief for the statistics identified by `key`. */
  let ai = $state<{ key: string; text: string; model: string } | null>(null)
  /** Text received so far for the request in flight. */
  let partial = $state('')
  let errorCode = $state<{ key: string; code: string } | null>(null)
  let copied = $state(false)
  let speaking = $state(false)

  const input = $derived<BriefInput | null>(
    session.aoi && session.aoiInfo && session.focus != null
      ? {
          area: session.aoi.label, areaKm2: session.aoiInfo.areaKm2, focusM: session.focus,
          firstYear: session.meta ? yearOf(session.meta.m_first) : a.calendar.years[0],
          baseline: session.effectiveBaseline, analysis: a,
        }
      : null,
  )
  const payload = $derived<BriefPayload | null>(
    input && session.aoi && session.aoiInfo
      ? buildBriefPayload({
          areaLabel: input.area, isPreset: !!session.aoi.presetId, areaKm2: input.areaKm2, centroid: session.aoiInfo.centroid,
          focusM: input.focusM, firstYear: input.firstYear, baseline: input.baseline,
          dataThrough: session.meta?.data_through ?? null, analysis: a,
        })
      : null,
  )
  /** Equal statistics give an equal key, so re-analysis with identical numbers never triggers a new request. */
  const key = $derived(payload ? payloadKey(payload) : '')
  const local = $derived(input ? templateBrief(input).join(' ') : '')

  const showingAi = $derived(ai != null && ai.key === key)
  const streamingNow = $derived(phase === 'streaming' && partial.length > 0)
  const text = $derived(showingAi ? ai!.text : streamingNow ? partial : local)
  const failed = $derived(errorCode != null && errorCode.key === key ? errorCode.code : null)
  const busy = $derived(phase !== 'idle')

  const REASONS: Record<string, string> = {
    no_key: 'no API key is configured on this server',
    rate_limited: 'the request limit was reached, try again in a minute',
    refused: 'the model declined the request',
    bad_output: 'the model returned an unusable answer',
    upstream_error: 'the AI service did not respond',
    bad_request: 'the statistics could not be sent',
  }

  let ctl: AbortController | null = null

  async function request(p: BriefPayload, k: string, fresh: boolean) {
    ctl?.abort()
    const mine = (ctl = new AbortController())
    phase = 'loading'
    partial = ''
    try {
      const done = await streamBrief(p, {
        fresh, signal: mine.signal,
        onDelta: (t) => { if (ctl === mine) { phase = 'streaming'; partial += t } },
      })
      if (ctl !== mine) return
      ai = { key: k, text: done.text, model: done.model }
      errorCode = null
    } catch (e) {
      if (ctl !== mine || mine.signal.aborted) return // superseded or navigated away: a newer request owns the UI
      errorCode = { key: k, code: e instanceof BriefClientError ? e.code : 'upstream_error' }
    } finally {
      if (ctl === mine) { phase = 'idle'; partial = ''; ctl = null }
    }
  }

  // One probe per page load: GET /api/brief -> { available }. No failed request in the console on dev / preview.
  $effect(() => {
    if (session.isMock) { available = false; return }
    const ac = new AbortController()
    probeBrief(ac.signal).then((r) => { if (!ac.signal.aborted) available = r.available })
    return () => ac.abort()
  })

  // Re-request when the statistics for the selected month change, after a pause; abort whatever is in flight.
  $effect(() => {
    const k = key
    const p = untrack(() => payload)
    if (!k || !p || available !== true) return
    if (untrack(() => ai?.key === k || errorCode?.key === k)) return
    const timer = setTimeout(() => request(p, k, false), DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctl?.abort(); ctl = null; phase = 'idle'; partial = '' }
  })

  function regenerate() {
    if (!payload || !key || available !== true || phase !== 'idle') return
    errorCode = null
    request(payload, key, true)
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); copied = true; setTimeout(() => (copied = false), 1600) } catch { /* denied */ }
  }
  function speak() {
    if (!('speechSynthesis' in window)) return
    if (speaking) { speechSynthesis.cancel(); speaking = false; return }
    const u = new SpeechSynthesisUtterance(text.replace(/×/g, ' times').replace(/–/g, ' to ').replace(/%/g, ' percent'))
    u.lang = 'en-GB'
    u.onend = () => (speaking = false)
    speaking = true
    speechSynthesis.speak(u)
  }
</script>

<section class="brief" aria-labelledby="brief-h">
  <p class="eyebrow">07 · Situation brief</p>
  <div class="head">
    <h2 id="brief-h">For the duty officer</h2>
    <span class="src" class:ai={showingAi || streamingNow}>
      {#if showingAi}Claude-written brief · {ai!.model}
      {:else if streamingNow}Claude-written brief · writing…
      {:else}Rule-based brief{#if phase === 'loading'} · asking Claude…{/if}{/if}
    </span>
  </div>
  <blockquote class="text" aria-live="polite" aria-busy={phase === 'streaming'}>
    {#each text.split(/\n{2,}/) as para, i (i)}<p>{para}</p>{/each}
  </blockquote>
  {#if failed}
    <p class="small err" role="status">Claude brief unavailable ({REASONS[failed] ?? 'service error'}); showing the rule-based brief instead.</p>
  {:else if available === false && !session.isMock}
    <p class="small muted">Claude-written briefs are not enabled on this server; showing the rule-based brief.</p>
  {/if}
  <div class="actions">
    <button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
    {#if 'speechSynthesis' in globalThis}<button class="btn" onclick={speak} aria-pressed={speaking}>{speaking ? 'Stop reading' : 'Read aloud'}</button>{/if}
    <button class="btn" onclick={regenerate} disabled={available !== true || busy || !payload} title={available === true ? 'Ask Claude to write the brief again' : 'Claude-written briefs are not enabled on this server'}>
      {busy ? 'Writing…' : 'Regenerate'}
    </button>
  </div>
  <p class="small muted">Generated from the statistics on this page only. Detections are not burned area; check local reports before acting.</p>
</section>

<style>
  .brief { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .src { font-size: 0.74rem; color: var(--ink-3); border: 1px solid var(--rule-strong); border-radius: 999px; padding: 1px 9px; }
  .src.ai { color: var(--ink-2); }
  .text { margin: 12px 0; padding: 4px 0 4px 16px; border-left: 2px solid var(--accent); font-size: 1.04rem; line-height: 1.62; max-width: 70ch; }
  .text p { margin: 0 0 0.6em; }
  .err { color: var(--ink-2); margin: 0 0 8px; }
  .actions { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .actions .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
