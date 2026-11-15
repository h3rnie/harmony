<script lang="ts">
  // The map's one legend: the month's cells (dated), and below it the live-detections row (separately dated).
  import { activityInverse, divColor, seqColor, type ActDomain } from '../color'
  import { themeState } from '../theme.svelte'
  import { fmtNum } from '../format'
  import type { OverlayMode } from './cellOverlay'
  import LiveControl from '../live/LiveControl.svelte'
  import Term from '../components/Term.svelte'
  import { session } from '../session.svelte'

  let { mode, domain, month, readout, onmode, liveOn, liveShown, onlive, compact = false }: {
    mode: OverlayMode; domain: ActDomain; month: string; readout: string | null; onmode: (m: OverlayMode) => void
    liveOn: boolean; liveShown: number; onlive: (on: boolean) => void
    /** Small maps (phones): the legend starts as one line and opens on request, so it never covers the area. */
    compact?: boolean
  } = $props()
  let expanded = $state(false)
  const full = $derived(!compact || expanded)

  const stops = $derived(
    Array.from({ length: 24 }, (_, i) => {
      const t = i / 23
      return mode === 'harmonized' ? seqColor(t, themeState.theme) : divColor(t * 2 - 1, themeState.theme)
    }),
  )
  const gradient = $derived(`linear-gradient(90deg, ${stops.join(',')})`)
  const ticks = $derived(
    mode === 'harmonized'
      ? [0.06, 0.53, 1].map((t) => fmtNum(activityInverse(t, domain)))
      : ['⅛×', '1×', '8×'],
  )
</script>

<div class="legend" role="group" aria-label="Map legend">
  <div class="row">
    <span class="title"><span class="m num">{month}</span> {mode === 'harmonized' ? 'fire activity' : 'vs normal'}</span>
    {#if full}
      <button class="btn sw" aria-pressed={mode === 'ratio'} onclick={() => onmode(mode === 'ratio' ? 'harmonized' : 'ratio')}>Compare with normal</button>
    {/if}
    {#if compact}
      <button class="btn sw more" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>{expanded ? 'Less' : 'More'}</button>
    {/if}
  </div>
  <div class="bar" style:background={gradient} role="img" aria-label={mode === 'harmonized' ? `Activity from 0 to ${ticks[2]} ${session.unitLabel} per cell, log scale` : 'Ratio to the monthly normal, from one eighth to eight times, log scale'}></div>
  <div class="ticks"><span class="num">{ticks[0]}</span>
    <span class="unit">{#if mode === 'harmonized'}<Term id="afcdm" /> per cell{:else}1× = <Term id="normal">normal</Term>{/if}</span>
    <span class="num">{ticks[2]}{mode === 'harmonized' ? '+' : ''}</span></div>
  {#if !full && liveOn}<p class="live-note"><span class="dot" aria-hidden="true"></span>Dots: live detections up to today (provisional)</p>{/if}
  {#if full}
    {#if readout}<p class="readout num" aria-live="off">{readout}</p>{/if}
    <LiveControl on={liveOn} shown={liveShown} onchange={onlive} />
  {/if}
</div>

<style>
  .legend {
    position: absolute; left: 12px; bottom: 34px; z-index: 2; width: 300px; max-width: calc(100% - 70px);
    background: var(--overlay-bg); border: 1px solid var(--rule-strong);
    border-radius: var(--radius); padding: 8px 10px; backdrop-filter: blur(6px); box-shadow: var(--shadow-sm);
  }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px 8px; margin-bottom: 7px; }
  .title { font-size: var(--fs-sm); color: var(--ink-2); white-space: nowrap; }
  .m { color: var(--ink); }
  .sw { min-height: 28px; font-size: var(--fs-sm); padding: 0 8px; }
  .more { margin-left: auto; }
  .live-note { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; font-size: var(--fs-xs); color: var(--ink-2); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }
  .sw[aria-pressed='true'] { color: var(--ink); background: var(--surface-3); }
  .bar { height: 8px; border-radius: 1px; }
  .ticks { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--fs-xs); color: var(--ink-3); margin-top: 3px; }
  .unit { font-size: var(--fs-xs); color: var(--ink-2); }
  @container map (max-width: 620px) { .legend { width: 262px; padding: 6px 8px; } }
  .readout { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--ink); }
</style>
