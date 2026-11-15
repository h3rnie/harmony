<script lang="ts">
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'

  const through = $derived.by(() => {
    const d = session.meta?.data_through
    if (!d) return null
    const dt = new Date(`${d}T00:00:00Z`)
    return Number.isNaN(+dt) ? d : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  })
</script>

<header class="hdr">
  <div class="brand">
    <svg class="mark" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 23C11 23 10 16 16 16" fill="none" stroke="var(--s-modis)" stroke-width="2.4" stroke-linecap="round" />
      <path d="M3 9C11 9 10 16 16 16" fill="none" stroke="var(--s-viirs)" stroke-width="2.4" stroke-linecap="round" />
      <path d="M16 16h13" stroke="var(--accent)" stroke-width="2.8" stroke-linecap="round" />
      <circle cx="16" cy="16" r="2.6" fill="var(--accent)" />
    </svg>
    <div class="words">
      <h1>Harmony</h1>
      <p class="tagline">One fire record, two generations of satellites</p>
    </div>
  </div>
  <div class="right">
    {#if session.isMock}
      <span class="badge demo" title={session.sel?.reason ?? ''}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9.5 9h-9z" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
        Demo data
      </span>
    {:else if session.sel}
      <span class="badge live" title="Rust/WASM kernel on pipeline tiles">WASM kernel</span>
    {/if}
    {#if through}
      <span class="badge fresh"><span class="dot" aria-hidden="true"></span>Data through <span class="num">{through}</span></span>
    {/if}
    <button class="btn pulse-btn" onclick={() => dispatchEvent(new CustomEvent('harmony:open-pulse'))} title="26 years of global fire seasons on a globe">
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M1.8 8h12.4M8 1.8c-2.4 2.6-2.4 9.8 0 12.4M8 1.8c2.4 2.6 2.4 9.8 0 12.4" fill="none" stroke="currentColor" stroke-width="1.1" /></svg>
      Global pulse
    </button>
    <a class="link" href="#method" onclick={(e) => {
      e.preventDefault()
      dispatchEvent(new CustomEvent('harmony:open-method'))
      requestAnimationFrame(() => document.getElementById('method')?.scrollIntoView({ behavior: themeState.reducedMotion ? 'auto' : 'smooth' }))
    }}>Method</a>
    <button class="btn icon" onclick={() => themeState.toggle()} aria-label={`Switch to ${themeState.theme === 'dark' ? 'light' : 'dark'} theme`}>
      {#if themeState.theme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
      {/if}
    </button>
  </div>
</header>

<style>
  .hdr {
    position: sticky; top: 0; z-index: 20; height: var(--header-h);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 0 16px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .words { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  h1 { font-size: 1.22rem; font-weight: 700; letter-spacing: -0.03em; }
  .tagline { margin: 0; color: var(--ink-3); font-size: 0.86rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .right { display: flex; align-items: center; gap: 10px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; font-size: 0.76rem; color: var(--ink-2);
    border: 1px solid var(--rule-strong); border-radius: 999px; padding: 2px 10px; white-space: nowrap;
  }
  .badge.demo { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 50%, transparent); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
  .link { font-size: 0.86rem; color: var(--ink-2); }
  .icon { padding: 0; width: 32px; justify-content: center; }
  .pulse-btn { border-color: color-mix(in srgb, var(--accent) 55%, var(--rule-strong)); color: var(--accent-ink); }
  .pulse-btn:hover { background: var(--accent-soft); }
  @media (max-width: 860px) { .tagline { display: none; } }
  @media (max-width: 560px) { .badge.live, .link { display: none; } .badge { font-size: 0.7rem; padding: 2px 7px; } }
</style>
