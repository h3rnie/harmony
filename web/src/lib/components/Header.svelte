<script lang="ts">
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { live, fmtAge } from '../live/store.svelte'
  import BrandMark from '../brand/BrandMark.svelte'
  import About from '../brand/About.svelte'
  import { TAGLINE, openAbout, openMethod } from '../brand/copy'

  const through = $derived.by(() => {
    const d = session.meta?.data_through
    if (!d) return null
    const dt = new Date(`${d}T00:00:00Z`)
    return Number.isNaN(+dt) ? d : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  })
  // Age of the newest near-real-time acquisition, when the live proxy is available and has data.
  const busy = $derived(session.aoi != null && (session.status === 'loading' || session.status === 'analyzing'))
  const liveAge = $derived(live.available && live.latestT != null ? fmtAge(live.now / 1000 - live.latestT) : null)
</script>

<header class="hdr">
  <a class="brand" href="./" aria-label="Harmony, home" onclick={(e) => { if (!session.aoi) e.preventDefault(); else { e.preventDefault(); session.setAoi(null) } }}>
    <BrandMark size={22} />
    <h1 class="wm">Harmony</h1>
    <span class="tagline" aria-hidden="true">{TAGLINE}</span>
  </a>
  <div class="right">
    {#if session.isMock}
      <span class="chip warn" title={session.sel?.reason ?? ''}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9.5 9h-9z" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
        Demo data
      </span>
    {/if}
    <!-- Always rendered with a reserved width, so the header does not shift when the dates arrive. -->
    {#if !through}<span class="chip fresh placeholder" aria-hidden="true"></span>
    {:else}
      <span class="chip fresh" title={liveAge ? 'Science record (calendar) through this date · newest near-real-time FIRMS detection, provisional' : 'Science record (calendar) through this date'}>
        <span class="dot" aria-hidden="true"></span>Data to <span class="num">{through}</span>{#if liveAge}<span class="sep" aria-hidden="true">·</span><span class="live-t">live <span class="num">{liveAge === 'just now' ? 'just now' : `${liveAge} ago`}</span></span>{/if}
      </span>
    {/if}
    <button class="btn pulse-btn" onclick={() => dispatchEvent(new CustomEvent('harmony:open-pulse'))} title="26 years of global fire seasons on a globe">
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M1.8 8h12.4M8 1.8c-2.4 2.6-2.4 9.8 0 12.4M8 1.8c2.4 2.6 2.4 9.8 0 12.4" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
      Global pulse
    </button>
    <nav class="nav" aria-label="Site">
      <a class="nl" href="#method" onclick={(e) => { e.preventDefault(); openMethod(!themeState.reducedMotion) }}>Method</a>
      <button class="nl" onclick={openAbout}>About</button>
    </nav>
    <button class="btn icon" onclick={() => themeState.toggle()} aria-label={`Switch to ${themeState.theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${themeState.theme === 'dark' ? 'light' : 'dark'} theme`}>
      {#if themeState.theme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
      {/if}
    </button>
  </div>
  {#if busy}
    <div class="progress" role="progressbar" aria-label="Loading analysis"
      aria-valuemin="0" aria-valuemax={session.progress.total || 1} aria-valuenow={session.progress.done}>
      <div class="bar" class:indeterminate={!session.progress.total}
        style:width={session.progress.total ? `${(100 * session.progress.done) / session.progress.total}%` : '30%'}></div>
    </div>
  {/if}
</header>
<About />

<style>
  .hdr {
    position: sticky; top: 0; z-index: 20; height: var(--header-h);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 0 16px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 36px; color: var(--ink); text-decoration: none; }
  .wm {
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-base); line-height: 1;
    letter-spacing: var(--track-wordmark); margin-right: calc(-1 * var(--track-wordmark)); text-transform: uppercase;
  }
  .tagline {
    margin-left: 10px; padding-left: 14px; border-left: 1px solid var(--rule-strong); line-height: 1.2;
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-xs); letter-spacing: 0.2em; text-transform: uppercase;
    color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .right { display: flex; align-items: center; gap: 10px; }
  .chip { padding: 5px 8px; }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; }
  .bar { height: 100%; background: var(--accent); transition: width 0.2s; }
  .bar.indeterminate { animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  .sep { color: var(--ink-faint); }
  .fresh .num { color: var(--ink); }
  .fresh { min-width: 20em; justify-content: center; }
  .fresh.placeholder { visibility: hidden; min-height: 1.9em; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
  .nav { display: flex; align-items: center; gap: 2px; }
  .nl {
    background: none; border: 0; cursor: pointer; padding: 8px 7px; color: var(--ink-3); text-decoration: none;
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-xs); letter-spacing: var(--track-label); text-transform: uppercase;
    transition: color 0.15s, box-shadow 0.15s;
  }
  .nl:hover { color: var(--ink); box-shadow: inset 0 -1px 0 var(--ink-3); }
  .icon { padding: 0; width: 32px; justify-content: center; }
  .pulse-btn { border-color: color-mix(in srgb, var(--accent) 60%, var(--rule-strong)); color: var(--accent-ink); }
  .pulse-btn:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
  @media (max-width: 1180px) { .tagline { display: none; } }
  @media (max-width: 720px) { .live-t, .fresh .sep { display: none; } .fresh { min-width: 11.5em; } }
  /* Below this width the date chip no longer fits beside the wordmark. */
  @media (max-width: 700px) { .fresh { display: none; } }
  @media (max-width: 560px) {
    .hdr { padding: 0 10px; gap: 8px; }
    .right { gap: 6px; }
    .fresh { display: none; }
    .nav a { display: none; }
    .pulse-btn { padding: 0.25em 0.6em; }
  }
  @media (max-width: 380px) { .wm { letter-spacing: 0.22em; margin-right: -0.22em; } }
</style>
