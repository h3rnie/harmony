<script lang="ts">
  import { session } from '../session.svelte'
  import YearRange from './YearRange.svelte'
  import type { CalMode, Dn } from '../urlState'

  const span = $derived(session.yearSpan)
  const range = $derived<[number, number]>(session.rangeYears ?? span)
  const baseline = $derived(session.effectiveBaseline)
  const busy = $derived(session.status === 'loading' || session.status === 'analyzing')

  const DN: [Dn, string][] = [['both', 'Both'], ['day', 'Day'], ['night', 'Night']]
  const MODES: [CalMode, string][] = [['activity', 'Activity'], ['anomaly', 'Anomaly'], ['percentile', 'Percentile']]

  function setRange(v: [number, number]) {
    session.setRange(v[0] === span[0] && v[1] === span[1] ? null : v)
  }
  function setBaseline(v: [number, number]) {
    if (v[1] - v[0] < 4) v = [v[0], Math.min(span[1], v[0] + 4)]
    session.setBaseline(v)
  }
</script>

<div class="controls" aria-label="Analysis options" role="group">
  <div class="ctl wide">
    <span class="eyebrow">Years shown</span>
    <YearRange min={span[0]} max={span[1]} value={range} label="Years shown" onchange={setRange} />
  </div>
  <div class="ctl wide">
    <span class="eyebrow">Baseline</span>
    <YearRange min={span[0] + 1} max={span[1]} value={baseline} label="Baseline years" onchange={setBaseline} />
  </div>
  <div class="ctl">
    <span class="eyebrow" id="dn-l">Overpass</span>
    <div class="seg" role="radiogroup" aria-labelledby="dn-l">
      {#each DN as [v, l] (v)}
        <button role="radio" aria-checked={session.dn === v} onclick={() => session.setDn(v)}>{l}</button>
      {/each}
    </div>
  </div>
  <div class="ctl">
    <span class="eyebrow" id="cm-l">Calendar</span>
    <div class="seg" role="radiogroup" aria-labelledby="cm-l">
      {#each MODES as [v, l] (v)}
        <button role="radio" aria-checked={session.calMode === v} onclick={() => session.setCalMode(v)}>{l}</button>
      {/each}
    </div>
  </div>
  {#if busy}
    <div class="progress" role="progressbar" aria-label="Loading analysis"
      aria-valuemin="0" aria-valuemax={session.progress.total || 1} aria-valuenow={session.progress.done}>
      <div class="bar" class:indeterminate={!session.progress.total}
        style:width={session.progress.total ? `${(100 * session.progress.done) / session.progress.total}%` : '30%'}></div>
    </div>
  {/if}
</div>

<style>
  .controls {
    position: sticky; top: var(--header-h); z-index: 10;
    display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: flex-end;
    padding: 10px 0 12px; background: color-mix(in srgb, var(--bg) 95%, transparent); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .ctl { display: grid; gap: 3px; }
  .ctl.wide { flex: 1 1 210px; }
  .seg button { min-height: 28px; }
  .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; }
  .bar { height: 100%; background: var(--accent); transition: width 0.2s; }
  .bar.indeterminate { animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
</style>
