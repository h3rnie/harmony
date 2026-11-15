<script lang="ts">
  import { untrack } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { templateBrief, type BriefInput } from '../brief/template'
  import { dossierFromSession } from '../brief/fromSession'
  import { dossierKey, type Brief, type Dossier } from '../brief/dossier'
  import { AiClientError, streamBrief, type RunMeta } from '../brief/client'
  import { aiStatus } from '../brief/status.svelte'
  import { LEVEL_LABEL, yearOf } from '../format'
  import AskHarmony from './AskHarmony.svelte'

  let { a }: { a: Analysis } = $props()

  /** Wait this long after the statistics stop changing before asking the model (month scrubbing, baseline drags). */
  const DEBOUNCE_MS = 900

  type Phase = 'idle' | 'loading' | 'streaming'
  $effect(() => { if (!session.isMock) aiStatus.ensure() })
  /** null until the one-off probe has answered. */
  const available = $derived(session.isMock ? false : (aiStatus.value?.available ?? null))
  let phase = $state<Phase>('idle')
  /** Finished AI brief for the statistics identified by `key`. */
  let ai = $state<{ key: string; brief: Brief; meta: RunMeta } | null>(null)
  /** Text received so far for the request in flight. */
  let partial = $state({ headline: '', summary: '' })
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
  const dossier = $derived<Dossier | null>(dossierFromSession(a))
  /** Equal statistics give an equal key, so re-analysis with identical numbers never triggers a new request. */
  const key = $derived(dossier ? dossierKey(dossier) : '')
  const local = $derived(input ? templateBrief(input).join(' ') : '')

  const showingAi = $derived(ai != null && ai.key === key)
  const streamingNow = $derived(phase === 'streaming' && (partial.headline.length > 0 || partial.summary.length > 0))
  const failed = $derived(errorCode != null && errorCode.key === key ? errorCode.code : null)
  const busy = $derived(phase !== 'idle')

  /** What the card shows and what Copy / Read aloud use. */
  const shown = $derived.by(() => {
    if (showingAi) return { headline: ai!.brief.headline, paras: [ai!.brief.summary], watch: ai!.brief.watch, caveat: ai!.brief.caveat, level: ai!.brief.level }
    if (streamingNow) return { headline: partial.headline, paras: [partial.summary], watch: [] as string[], caveat: '', level: null }
    return { headline: '', paras: local ? [local] : [], watch: [] as string[], caveat: '', level: null }
  })
  const plain = $derived(
    [shown.headline, ...shown.paras, shown.watch.length ? 'Watch: ' + shown.watch.join('; ') + '.' : '', shown.caveat].filter(Boolean).join(' '),
  )

  const REASONS: Record<string, string> = {
    no_key: 'no API key is configured on this server',
    bad_config: 'the server AI configuration is invalid',
    rate_limited: 'the request limit was reached, try again in a minute',
    refused: 'the model declined the request',
    bad_output: 'the draft did not pass the checks against the statistics, even after one retry',
    upstream_error: 'the AI service did not respond',
    bad_request: 'the statistics could not be sent',
  }

  /** Truthful hint: only when most of the prompt really was served from the provider's prompt cache. */
  const mostlyCached = (m: RunMeta): boolean => {
    const total = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite
    return !!m.cache && total > 0 && m.cache.read / total >= 0.5
  }

  let ctl: AbortController | null = null

  async function request(d: Dossier, k: string, fresh: boolean) {
    ctl?.abort()
    const mine = (ctl = new AbortController())
    phase = 'loading'
    partial = { headline: '', summary: '' }
    try {
      const done = await streamBrief(d, {
        fresh, signal: mine.signal,
        onDelta: (field, t) => {
          if (ctl !== mine) return
          phase = 'streaming'
          if (field === 'headline') partial.headline += t
          else if (field === 'summary') partial.summary += t
        },
        onReset: () => { if (ctl === mine) partial = { headline: '', summary: '' } },
      })
      if (ctl !== mine) return
      ai = { key: k, brief: done.brief, meta: done }
      errorCode = null
    } catch (e) {
      if (ctl !== mine || mine.signal.aborted) return // superseded or navigated away: a newer request owns the UI
      errorCode = { key: k, code: e instanceof AiClientError ? e.code : 'upstream_error' }
    } finally {
      if (ctl === mine) { phase = 'idle'; partial = { headline: '', summary: '' }; ctl = null }
    }
  }

  // Re-request when the statistics for the selected month change, after a pause; abort whatever is in flight.
  $effect(() => {
    const k = key
    const d = untrack(() => dossier)
    if (!k || !d || available !== true) return
    if (untrack(() => ai?.key === k || errorCode?.key === k)) return
    const timer = setTimeout(() => request(d, k, false), DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctl?.abort(); ctl = null; phase = 'idle'; partial = { headline: '', summary: '' } }
  })

  function regenerate() {
    if (!dossier || !key || available !== true || phase !== 'idle') return
    errorCode = null
    request(dossier, key, true)
  }

  async function copy() {
    try { await navigator.clipboard.writeText(plain); copied = true; setTimeout(() => (copied = false), 1600) } catch { /* denied */ }
  }
  function speak() {
    if (!('speechSynthesis' in window)) return
    if (speaking) { speechSynthesis.cancel(); speaking = false; return }
    const u = new SpeechSynthesisUtterance(plain.replace(/×/g, ' times').replace(/–/g, ' to ').replace(/%/g, ' percent'))
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
      {#if showingAi}AI-written brief · {ai!.meta.model}{#if mostlyCached(ai!.meta)}{' · cached context'}{/if}
      {:else if streamingNow}AI-written brief · writing…
      {:else}Rule-based brief{#if phase === 'loading'} · asking the model…{/if}{/if}
    </span>
  </div>
  <div class="text" aria-live="polite" aria-busy={phase === 'streaming'}>
    {#if shown.headline}<p class="headline">{shown.headline}</p>{/if}
    {#each shown.paras as para, i (i)}<p>{para}</p>{/each}
    {#if shown.watch.length}
      <ul class="watch" aria-label="Watch">
        {#each shown.watch as w, i (i)}<li>{w}</li>{/each}
      </ul>
    {/if}
    {#if shown.caveat}<p class="caveat">{shown.caveat}</p>{/if}
  </div>
  {#if showingAi && shown.level}<p class="small muted lvl">Level: {LEVEL_LABEL[shown.level] ?? shown.level}</p>{/if}
  {#if failed}
    <p class="small err" role="status">AI brief unavailable ({REASONS[failed] ?? 'service error'}); showing the rule-based brief instead.</p>
  {:else if available === false && !session.isMock}
    <p class="small muted">AI-written briefs are not enabled on this server; showing the rule-based brief.</p>
  {/if}
  <div class="actions">
    <button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
    {#if 'speechSynthesis' in globalThis}<button class="btn" onclick={speak} aria-pressed={speaking}>{speaking ? 'Stop reading' : 'Read aloud'}</button>{/if}
    <button class="btn" onclick={regenerate} disabled={available !== true || busy || !dossier} title={available === true ? 'Ask the model to write the brief again' : 'AI-written briefs are not enabled on this server'}>
      {busy ? 'Writing…' : 'Regenerate'}
    </button>
  </div>
  <p class="small muted">Generated from the statistics on this page only. Detections are not burned area; check local reports before acting.</p>

  <AskHarmony {a} />
</section>

<style>
  .brief { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .src { font-size: 0.74rem; color: var(--ink-3); border: 1px solid var(--rule-strong); border-radius: 999px; padding: 1px 9px; }
  .src.ai { color: var(--ink-2); }
  .text { margin: 12px 0 6px; padding: 4px 0 4px 16px; border-left: 2px solid var(--accent); font-size: 1.04rem; line-height: 1.62; max-width: 70ch; }
  .text p { margin: 0 0 0.6em; }
  .headline { font-weight: 650; font-size: 1.12rem; line-height: 1.35; }
  .watch { margin: 0 0 0.7em; padding-left: 1.1em; font-size: 0.96rem; color: var(--ink-2); }
  .watch li { margin: 0 0 0.2em; }
  .caveat { font-size: 0.92rem; color: var(--ink-2); }
  .lvl { margin: 0 0 8px 18px; }
  .err { color: var(--ink-2); margin: 0 0 8px; }
  .actions { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .actions .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
