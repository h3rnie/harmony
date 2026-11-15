<script lang="ts">
  import { activityInverse, divColor, seqColor, type ActDomain } from '../color'
  import { themeState } from '../theme.svelte'
  import { fmtNum } from '../format'
  import type { OverlayMode } from './cellOverlay'

  let { mode, domain, month, readout, onmode }: {
    mode: OverlayMode; domain: ActDomain; month: string; readout: string | null; onmode: (m: OverlayMode) => void
  } = $props()

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

<div class="legend" aria-label="Map overlay legend">
  <div class="row">
    <span class="eyebrow">Cells · {month}</span>
    <div class="seg" role="radiogroup" aria-label="Overlay mode">
      <button role="radio" aria-checked={mode === 'harmonized'} onclick={() => onmode('harmonized')}>Activity</button>
      <button role="radio" aria-checked={mode === 'ratio'} onclick={() => onmode('ratio')}>vs normal</button>
    </div>
  </div>
  <div class="bar" style:background={gradient} role="img" aria-label={mode === 'harmonized' ? `Activity from 0 to ${ticks[2]} AFCD-M per cell, log scale` : 'Ratio to the monthly median, from one eighth to eight times, log scale'}></div>
  <div class="ticks num"><span>{ticks[0]}</span><span>{ticks[1]}</span><span>{ticks[2]}{mode === 'harmonized' ? '+' : ''}</span></div>
  <p class="unit">{mode === 'harmonized' ? 'AFCD-M per cell (log scale) · empty = no detections' : 'Ratio to baseline median for this month (log₂)'}</p>
  {#if readout}<p class="readout num" aria-live="off">{readout}</p>{/if}
</div>

<style>
  .legend {
    position: absolute; left: 12px; bottom: 34px; z-index: 2; width: 252px; max-width: calc(100% - 70px);
    background: var(--overlay-bg); border: 1px solid var(--rule-strong);
    border-radius: var(--radius); padding: 8px 10px; backdrop-filter: blur(6px); box-shadow: var(--shadow-sm);
  }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 7px; }
  .seg { flex: none; }
  .seg button { min-height: 24px; font-size: var(--fs-sm); padding: 0 7px; white-space: nowrap; }
  .bar { height: 8px; border-radius: 1px; }
  .ticks { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--ink-3); margin-top: 3px; }
  .unit { font-size: var(--fs-xs); color: var(--ink-3); margin: 3px 0 0; line-height: 1.4; }
  @container map (max-width: 620px) { .legend { width: 212px; padding: 6px 8px; } .unit { display: none; } }
  .readout { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--ink); }
</style>
