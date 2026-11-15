<script lang="ts" module>
  import { SvelteMap } from 'svelte/reactivity'
  import type { Brief } from '../brief/dossier'
  import type { RunMeta } from '../brief/client'

  /**
   * AI briefs the viewer asked for, by dossier key (area, month, options and statistics). Module level, so returning
   * to an area and month already written shows it again without a new request.
   */
  const written = new SvelteMap<string, { brief: Brief; meta: RunMeta }>()
</script>

<script lang="ts">
  // "In plain words": the rule-based brief shows at once. The AI-written brief is opt-in (it is a paid model call):
  // it is requested only when the viewer presses "Write a fuller brief", once per area / month / options, and cached.
  // Nothing here sends a request on load, on hot reload, on an option change or on a preset click.
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { templateBrief, type BriefInput } from '../brief/template'
  import { dossierFromSession } from '../brief/fromSession'
  import { dossierKey, type Dossier } from '../brief/dossier'
  import { AiClientError, streamBrief } from '../brief/client'
  import { aiStatus } from '../brief/status.svelte'
  import { LEVEL_LABEL, yearOf } from '../format'
  import { isSparse, monthStats } from '../analysisUtil'
  import AskHarmony from './AskHarmony.svelte'
  import { briefLead } from './briefLead.svelte'

  let { a }: { a: Analysis } = $props()

  type Phase = 'idle' | 'loading' | 'streaming'
  // A status probe (GET, no model call) tells whether the server can write briefs at all.
  $effect(() => { if (!session.isMock) aiStatus.ensure() })
  /** null until the one-off probe has answered. */
  const available = $derived(session.isMock ? false : (aiStatus.value?.available ?? null))
  let phase = $state<Phase>('idle')
  /** Key of the request in flight (its streamed text is shown only while that key is on screen). */
  let pendingKey = $state('')
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
          baseline: session.effectiveBaseline, analysis: a, dataThrough: session.meta?.data_through ?? null,
        }
      : null,
  )
  const dossier = $derived<Dossier | null>(dossierFromSession(a))
  /** Equal statistics give an equal key, so re-analysis with identical numbers never asks again. */
  const key = $derived(dossier ? dossierKey(dossier) : '')
  const local = $derived(input ? templateBrief(input).join(' ') : '')
  /** A sparse area or a month in progress has nothing for a model to add beyond the rule-based statement. */
  const aiUseful = $derived.by(() => {
    if (isSparse(a) || session.focus == null) return false
    const s = monthStats(a, session.focus)
    return !!s && !s.inProgress
  })

  const ai = $derived(key ? written.get(key) ?? null : null)
  const showingAi = $derived(ai != null)
  const streamingNow = $derived(phase === 'streaming' && pendingKey === key && (partial.headline.length > 0 || partial.summary.length > 0))
  const failed = $derived(errorCode != null && errorCode.key === key ? errorCode.code : null)
  const busy = $derived(phase !== 'idle')
  const busyHere = $derived(busy && pendingKey === key)

  /** What the card shows and what Copy / Read aloud use. */
  const shown = $derived.by(() => {
    if (ai) return { headline: ai.brief.headline, paras: [ai.brief.summary], watch: ai.brief.watch, caveat: ai.brief.caveat, level: ai.brief.level }
    if (streamingNow) return { headline: partial.headline, paras: [partial.summary], watch: [] as string[], caveat: '', level: null }
    return { headline: '', paras: local ? [local] : [], watch: [] as string[], caveat: '', level: null }
  })
  // Lift the opening line of an AI brief the viewer asked for into the answer card. The rule-based first sentence
  // repeats the card, so it stays here.
  $effect(() => {
    const text = ai ? (ai.brief.headline || ai.brief.summary.split(/(?<=\.)\s/)[0] || '') : ''
    briefLead.text = text
    briefLead.key = ai ? key : ''
  })
  $effect(() => () => { briefLead.text = ''; briefLead.key = '' })

  const plain = $derived(
    [shown.headline, ...shown.paras, shown.watch.length ? 'Watch: ' + shown.watch.join('; ') + '.' : '', shown.caveat].filter(Boolean).join(' '),
  )

  const REASONS: Record<string, string> = {
    no_key: 'no API key is configured on this server',
    bad_config: 'the server AI configuration is invalid',
    daily_cap: 'the daily limit of AI requests for this site has been reached',
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
    pendingKey = k
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
      written.set(k, { brief: done.brief, meta: done })
      if (errorCode?.key === k) errorCode = null
    } catch (e) {
      if (mine.signal.aborted) return // superseded or the card went away
      errorCode = { key: k, code: e instanceof AiClientError ? e.code : 'upstream_error' }
    } finally {
      if (ctl === mine) { phase = 'idle'; pendingKey = ''; partial = { headline: '', summary: '' }; ctl = null }
    }
  }
  // Leaving the analysis (another area) stops a request in flight; it never starts one.
  $effect(() => () => { ctl?.abort(); ctl = null })

  /** "Write a fuller brief" (first time for this key) or "Regenerate" (a fresh draft of the same statistics). */
  function write(fresh: boolean) {
    if (!dossier || !key || available !== true || busy || !aiUseful) return
    errorCode = null
    request(dossier, key, fresh)
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

<section class="brief" id="brief" aria-labelledby="brief-h">
  <div class="head">
    <h2 id="brief-h" class="q-title">In plain words</h2>
    <span class="src" class:ai={showingAi || streamingNow}>
      {#if ai}AI-written brief · {ai.meta.model}{#if mostlyCached(ai.meta)}{' · cached context'}{/if}
      {:else if streamingNow}AI-written brief · writing…
      {:else}Rule-based brief{#if busyHere} · asking the model…{/if}{/if}
    </span>
  </div>
  <p class="sub">A brief for the duty officer, written from the numbers on this page.</p>
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
  {#if ai && shown.level && dossier?.month.ratio != null}<p class="small muted lvl">Level: {LEVEL_LABEL[shown.level] ?? shown.level}</p>{/if}
  {#if failed}
    <p class="small err" role="status">AI brief unavailable ({REASONS[failed] ?? 'service error'}); showing the rule-based brief instead.</p>
  {:else if available === false && !session.isMock}
    <p class="small muted">AI-written briefs are not enabled on this server; showing the rule-based brief.</p>
  {:else if available === true && !ai && aiUseful}
    <p class="small muted">The brief above is built from rules. A fuller brief is written by a language model from the same numbers, on request.</p>
  {/if}
  <div class="actions">
    <button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
    {#if 'speechSynthesis' in globalThis}<button class="btn" onclick={speak} aria-pressed={speaking}>{speaking ? 'Stop reading' : 'Read aloud'}</button>{/if}
    {#if available === true && aiUseful}
      {#if ai}
        <button class="btn" onclick={() => write(true)} disabled={busy || !dossier} title="Ask the model to write this brief again">{busyHere ? 'Writing…' : 'Regenerate'}</button>
      {:else}
        <button class="btn primary" onclick={() => write(false)} disabled={busy || !dossier} aria-describedby="brief-h">{busyHere ? 'Writing…' : 'Write a fuller brief'}</button>
      {/if}
    {/if}
  </div>
  <p class="muted">Detections are not burned area; check local reports before acting.</p>

  <AskHarmony {a} />
</section>

<style>
  .brief { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .src { font-size: var(--fs-sm); color: var(--ink-3); border: 1px solid var(--rule-strong); border-radius: 999px; padding: 1px 9px; }
  .src.ai { color: var(--ink-2); }
  .text { margin: 12px 0 6px; padding: 4px 0 4px 16px; border-left: 2px solid var(--accent); font-size: var(--fs-base); line-height: 1.6; max-width: var(--measure); }
  .text p { margin: 0 0 0.6em; }
  .headline { font-weight: 650; font-size: var(--fs-lg); line-height: 1.35; }
  .watch { margin: 0 0 0.7em; padding-left: 1.1em; font-size: var(--fs-base); color: var(--ink-2); }
  .watch li { margin: 0 0 0.2em; }
  .caveat { font-size: var(--fs-base); color: var(--ink-2); }
  .sub { color: var(--ink-3); font-size: var(--fs-base); margin: 4px 0 0; }
  .lvl { margin: 0 0 8px 18px; }
  .err { color: var(--ink-2); margin: 0 0 8px; }
  .actions { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .actions .btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
