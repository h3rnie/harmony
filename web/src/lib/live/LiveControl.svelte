<script lang="ts">
  import { live, fmtAge, WINDOW_HOURS, type LiveWindow } from './store.svelte'
  import { AGE_COLORS, AGE_LABELS } from './liveLayer'
  import { themeState } from '../theme.svelte'
  import { session } from '../session.svelte'

  let { shown }: { shown: number } = $props()

  const OPTIONS: { v: LiveWindow; label: string }[] = [
    { v: '24h', label: '24 h' }, { v: '48h', label: '48 h' }, { v: '7d', label: '7 d' }, { v: 'off', label: 'Off' },
  ]
  const colors = $derived(AGE_COLORS[themeState.theme])
  const hasAoi = $derived(session.aoi != null)
  const windowText = $derived(live.window === 'off' ? '' : live.window === '7d' ? 'the last 7 days' : `the last ${WINDOW_HOURS[live.window]} h`)
  const age = $derived(live.latestT != null ? fmtAge(live.now / 1000 - live.latestT) : null)
</script>

{#if live.available && hasAoi}
  <div class="live" role="group" aria-label="Live detections layer">
    <div class="row">
      <span class="eyebrow" title="FIRMS near-real-time detections (NOAA-20, NOAA-21, MODIS) through the Harmony proxy">Live</span>
      <div class="seg" role="radiogroup" aria-label="Live detections time window">
        {#each OPTIONS as o (o.v)}
          <button role="radio" aria-checked={live.window === o.v} disabled={!hasAoi} onclick={() => live.setWindow(o.v)}
            title={hasAoi ? '' : 'Select an area to see live detections'}>{o.label}</button>
        {/each}
      </div>
    </div>

    {#if !hasAoi}
      <p class="msg muted">Select an area to see what is burning now.</p>
    {:else if live.window !== 'off'}
      {#if live.phase === 'loading' && !live.data}
        <p class="msg muted" role="status">Loading live detections…</p>
      {:else if live.phase === 'too-large'}
        <p class="msg" role="status">Area too large for live data ({live.tooLarge?.area} of {live.tooLarge?.limit} sq. degrees). Draw a smaller area.</p>
      {:else if live.phase === 'error' && !live.data}
        <p class="msg warn" role="status">{live.error} <button class="link" onclick={() => live.retry()}>Retry</button></p>
      {:else if live.data}
        {#if shown === 0}
          <p class="msg" role="status">No detections in {windowText}.</p>
        {:else}
          <ul class="legend" aria-label="Detection age">
            {#each AGE_LABELS as l, k (l)}
              <li>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r={k === 0 ? 5.5 : k === 1 ? 4.6 : 3} fill={colors.fill[k]} fill-opacity={k === 2 ? 0.55 : 1} stroke={colors.ring[k]} stroke-width={k === 0 ? 1.2 : k === 1 ? 0.6 : 0} />
                </svg>{l}
              </li>
            {/each}
            <li class="frp">
              <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
                <circle cx="5" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="1" />
                <circle cx="17" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1" />
              </svg>FRP
            </li>
          </ul>
          <p class="msg muted"><span class="num">{shown.toLocaleString('en-US')}</span> in {windowText} · faint = outside area</p>
        {/if}
        <p class="msg muted latest">
          {#if age}Latest detection <span class="num">{age === 'just now' ? age : `${age} ago`}</span>{/if}
          {#if live.phase === 'loading'} · refreshing…{:else if live.phase === 'error'} · <span class="warn">refresh failed</span>{/if}
          {#if live.data.stale} · <span class="warn">cached copy (FIRMS busy)</span>{/if}
        </p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .live {
    position: absolute; right: 52px; bottom: 34px; z-index: 2; width: 236px; max-width: calc(100% - 24px);
    background: var(--overlay-bg); border: 1px solid var(--rule-strong);
    border-radius: var(--radius); padding: 8px 10px; box-shadow: var(--shadow-sm); backdrop-filter: blur(6px);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .seg button { padding: 0.15em 0.55em; min-height: 24px; font-size: var(--fs-sm); }
  .seg button:disabled { opacity: 0.45; cursor: not-allowed; }
  .msg { margin: 6px 0 0; color: var(--ink-2); line-height: 1.4; font-size: var(--fs-sm); }
  .msg.muted { color: var(--ink-3); }
  .warn { color: var(--warning); }
  .link { background: none; border: 0; padding: 0; color: var(--ink); text-decoration: underline; cursor: pointer; font-size: inherit; }
  .legend { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: var(--fs-sm); color: var(--ink-2); }
  .legend li { display: inline-flex; align-items: center; gap: 4px; }
  .frp { color: var(--ink-3); }
  @container map (max-width: 620px) {
    .live { right: auto; left: 12px; bottom: auto; top: 172px; width: 210px; padding: 6px 8px; }
    .legend, .latest { display: none; }
  }
</style>
