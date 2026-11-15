<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { briefStats, templateBrief, type BriefInput } from '../brief/template'
  import { yearOf } from '../format'

  let { a }: { a: Analysis } = $props()

  // Once the route has answered 404/405 (static hosting, no key), stop asking for this page load.
  let routeMissing = false
  let ai = $state<{ key: string; text: string } | null>(null)
  let loadingAi = $state(false)
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
  const key = $derived(input ? JSON.stringify(briefStats(input)) : '')
  const local = $derived(input ? templateBrief(input) : [])
  const showingAi = $derived(ai != null && ai.key === key)
  const text = $derived(showingAi ? ai!.text : local.join(' '))

  async function requestAi(k: string) {
    if (routeMissing || !k) return
    loadingAi = true
    try {
      const res = await fetch('/api/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: k })
      if (res.status === 404 || res.status === 405 || res.status === 501) { routeMissing = true; return }
      if (!res.ok) return
      const ct = res.headers.get('content-type') ?? ''
      const body = ct.includes('json') ? await res.json() : { text: await res.text() }
      const t = typeof body?.text === 'string' ? body.text.trim() : ''
      if (t && k === key) ai = { key: k, text: t }
    } catch {
      /* offline or no route: keep the rule-based brief */
    } finally {
      loadingAi = false
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const k = key
    clearTimeout(timer)
    if (k && !session.isMock) timer = setTimeout(() => requestAi(k), 600)
    return () => clearTimeout(timer)
  })

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
    <span class="src" class:ai={showingAi}>
      {#if showingAi}AI brief (Claude) from the computed statistics{:else}Rule-based brief{#if loadingAi} · asking the AI…{/if}{/if}
    </span>
  </div>
  <blockquote class="text">
    {#if showingAi}
      {#each ai!.text.split(/\n{2,}/) as para, i (i)}<p>{para}</p>{/each}
    {:else}
      <p>{#each local as s, i (i)}{s}{' '}{/each}</p>
    {/if}
  </blockquote>
  <div class="actions">
    <button class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
    {#if 'speechSynthesis' in globalThis}<button class="btn" onclick={speak} aria-pressed={speaking}>{speaking ? 'Stop reading' : 'Read aloud'}</button>{/if}
  </div>
  <p class="small muted">Generated only from the statistics on this page. Detections are not burned area; check local reports before acting.</p>
</section>

<style>
  .brief { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .src { font-size: 0.74rem; color: var(--ink-3); border: 1px solid var(--rule-strong); border-radius: 999px; padding: 1px 9px; }
  .src.ai { color: var(--ink-2); }
  .text { margin: 12px 0; padding: 4px 0 4px 16px; border-left: 2px solid var(--accent); font-size: 1.04rem; line-height: 1.62; max-width: 70ch; }
  .text p { margin: 0 0 0.6em; }
  .actions { display: flex; gap: 8px; margin-bottom: 8px; }
</style>
