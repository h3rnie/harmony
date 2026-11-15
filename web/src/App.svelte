<script lang="ts">
  import { onMount } from 'svelte'
  import { session } from './lib/session.svelte'
  import { themeState } from './lib/theme.svelte'
  import Footer from './lib/brand/Footer.svelte'
  import Header from './lib/components/Header.svelte'
  import MapPanel from './lib/map/MapPanel.svelte'
  import Intro from './lib/components/Intro.svelte'
  import StatusStrip from './lib/components/StatusStrip.svelte'
  import SectionIndex, { type IndexItem } from './lib/components/SectionIndex.svelte'
  import NowCard from './lib/components/NowCard.svelte'
  import { live } from './lib/live/store.svelte'
  import CalendarView from './lib/components/CalendarView.svelte'
  import SeasonView from './lib/components/SeasonView.svelte'
  import TrendView from './lib/components/TrendView.svelte'
  import OutlookView from './lib/components/OutlookView.svelte'
  import BriefCard from './lib/components/BriefCard.svelte'
  import HowWeKnow from './lib/components/HowWeKnow.svelte'
  import ExportsPanel from './lib/components/ExportsPanel.svelte'
  import MethodSection from './lib/components/MethodSection.svelte'
  import Deferred from './lib/components/Deferred.svelte'
  import type { Component } from 'svelte'

  // Global fire pulse: full-viewport view, lazy-loaded; `#view=pulse&t=YYYY-MM` keeps it shareable.
  let Pulse = $state.raw<Component<{ onclose: () => void }> | null>(null)
  let pulseOpen = $state(false)
  /** Bumped when the hash changes from outside while the pulse is open, so it re-reads `t`. */
  let pulseKey = $state(0)
  let pulseOpener: HTMLElement | null = null
  const hashView = () => new URLSearchParams(location.hash.slice(1)).get('view')

  async function openPulse() {
    if (pulseOpen) return
    pulseOpener = document.activeElement as HTMLElement | null
    if (hashView() !== 'pulse') {
      const q = new URLSearchParams(location.hash.slice(1))
      q.set('view', 'pulse')
      history.replaceState(null, '', `${location.pathname}${location.search}#${q.toString().replace(/%2C/g, ',')}`)
    }
    Pulse ??= (await import('./lib/pulse/PulseView.svelte')).default
    pulseOpen = true
  }
  function closePulse() {
    pulseOpen = false
    const q = new URLSearchParams(location.hash.slice(1))
    if (q.has('view') || q.has('t') || q.has('mode')) {
      q.delete('view'); q.delete('t'); q.delete('mode')
      const h = q.toString().replace(/%2C/g, ',')
      history.replaceState(null, '', `${location.pathname}${location.search}${h ? `#${h}` : ''}`)
    }
    pulseOpener?.focus()
  }

  onMount(() => {
    themeState.apply()
    session.boot()
    live.init()
    if (hashView() === 'pulse') openPulse()
    const onOpen = () => openPulse()
    const onHash = () => {
      if (hashView() === 'pulse') { if (pulseOpen) pulseKey++; else openPulse() }
      else if (pulseOpen) pulseOpen = false
    }
    addEventListener('harmony:open-pulse', onOpen)
    addEventListener('hashchange', onHash)
    return () => { removeEventListener('harmony:open-pulse', onOpen); removeEventListener('hashchange', onHash) }
  })

  const a = $derived(session.analysis)
  const noDetections = $derived(a != null && a.annual.total.every((t) => !t))
  const busy = $derived(session.status === 'loading' || session.status === 'analyzing')

  // The guided scroll, in the order of a newcomer's questions. Short labels for the index; the titles are questions.
  const index = $derived<IndexItem[]>([
    { id: 'when', label: 'When', title: 'When does it burn?' },
    { id: 'unusual', label: 'This year', title: 'Is this year unusual?' },
    { id: 'trend', label: 'Trend', title: 'Is it getting worse?' },
    { id: 'next', label: 'Next', title: 'What’s next?' },
    ...(live.available ? [{ id: 'now', label: 'Right now', title: 'What is burning right now?' }] : []),
    { id: 'brief', label: 'In plain words', title: 'In plain words' },
    { id: 'how', label: 'How we know', title: 'How we know' },
    { id: 'export', label: 'Export', title: 'Take it with you' },
  ])
</script>

<a class="skip" href="#analysis" onclick={(e) => { e.preventDefault(); document.getElementById('analysis')?.focus() }}>Skip to analysis</a>
<Header />

<main class="layout">
  <div class="map-pane">
    <MapPanel />
  </div>

  <div class="analysis" id="analysis" tabindex="-1" aria-busy={busy}>
    {#if session.isMock}
      <p class="demo-banner small" role="note">
        <strong>Demo data.</strong> {session.sel?.reason}. Numbers are synthetic but internally consistent so every view can be explored; real FIRMS-derived values appear automatically once the pipeline output and WASM kernel are present.
      </p>
    {/if}

    {#if session.status === 'error'}
      <div class="error" role="alert">
        <h2>Something went wrong</h2>
        <p>{session.error}</p>
        <button class="btn" onclick={() => session.aoi && session.setAoi(session.aoi, { keepFocus: true })}>Try again</button>
      </div>
    {/if}

    {#if !session.aoi}
      <Intro />
      <MethodSection />
    {:else if a && noDetections}
      <div class="nodata" class:stale={busy} role="status">
        <h2>No fire detections in this area, {a.calendar.years[0]}–{a.calendar.years[a.calendar.years.length - 1]}</h2>
        <p class="muted">Either it rarely burns, or it lies outside the area covered by the current data build. Try a larger area or one of the stories.</p>
        <button class="btn" onclick={() => session.setAoi(null)}>Show the stories</button>
      </div>
    {:else if a}
      <div class="results" class:stale={busy}>
        <StatusStrip {a} />
        <SectionIndex items={index} />
        <CalendarView {a} />
        <!-- Below the first screen: built once the answer has painted (or on approach). -->
        <Deferred minHeight={520}><SeasonView {a} /></Deferred>
        <Deferred minHeight={420}><TrendView {a} /></Deferred>
        <Deferred minHeight={520}><OutlookView {a} /></Deferred>
        <Deferred minHeight={live.available ? 560 : 0}><NowCard {a} /></Deferred>
        <Deferred minHeight={600}><BriefCard {a} /></Deferred>
        <Deferred minHeight={900}><HowWeKnow {a} /></Deferred>
        <Deferred minHeight={520}><ExportsPanel {a} /></Deferred>
      </div>
    {:else if session.status !== 'error'}
      <div class="loading" role="status">
        <div class="skel line"></div>
        <div class="skel big"></div>
        <div class="skel"></div>
        <div class="skel grid"></div>
        <p class="small muted">
          {#if session.status === 'loading' && session.progress.total}
            Loading {session.progress.done} of {session.progress.total} data tiles…
          {:else}
            Preparing the analysis…
          {/if}
        </p>
      </div>
    {/if}

    <Footer />
  </div>
</main>

{#if pulseOpen && Pulse}
  {#key pulseKey}<Pulse onclose={closePulse} />{/key}
{/if}

<div class="sr-only" aria-live="polite" aria-atomic="true">{session.announce}</div>

<style>
  .skip {
    position: absolute; left: 8px; top: -60px; z-index: 100; background: var(--surface); color: var(--ink);
    padding: 8px 12px; border: 1px solid var(--focus); border-radius: var(--radius);
  }
  .skip:focus { top: 8px; }
  .layout { display: grid; grid-template-columns: minmax(0, 42fr) minmax(0, 58fr); min-height: calc(100vh - var(--header-h)); }
  .map-pane {
    position: sticky; top: var(--header-h); height: calc(100vh - var(--header-h)); height: calc(100dvh - var(--header-h));
    border-right: 1px solid var(--rule);
  }
  .analysis { padding: 0 clamp(16px, 3vw, 40px) 40px; min-width: 0; outline: none; }
  .demo-banner {
    margin: 12px 0 0; padding: 8px 12px; border-left: 2px solid var(--warning); background: var(--surface);
    color: var(--ink-2); border-radius: 0 var(--radius) var(--radius) 0;
  }
  .results { transition: opacity 0.25s; }
  .results.stale { opacity: 0.55; }
  .results :global(section[id]) { scroll-margin-top: calc(var(--header-h) + 56px); }
  .nodata { padding: 26px 0; border-bottom: 1px solid var(--rule); }
  .nodata h2 { margin: 0 0 8px; }
  .error { padding: 24px 0; border-bottom: 1px solid var(--rule); }
  .error h2 { color: var(--critical); margin-bottom: 6px; }
  .loading { padding: 22px 0; display: grid; gap: 14px; }
  .skel { height: 22px; border-radius: 4px; background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  .skel.line { height: 14px; width: 30%; }
  .skel.big { height: 84px; width: 60%; }
  .skel.grid { height: 360px; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
    .map-pane { position: relative; top: 0; height: 42vh; min-height: 280px; border-right: 0; border-bottom: 1px solid var(--rule); }
  }
</style>
