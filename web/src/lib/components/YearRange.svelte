<script lang="ts">
  // Two-thumb year slider built from two native range inputs (keyboard + screen-reader friendly).
  let { min, max, value, label, onchange }: {
    min: number; max: number; value: [number, number]; label: string; onchange: (v: [number, number]) => void
  } = $props()

  let lo = $state(0)
  let hi = $state(0)
  $effect.pre(() => { lo = value[0]; hi = value[1] })

  const pct = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * 100)
  function commit() {
    if (lo > hi) [lo, hi] = [hi, lo]
    if (lo !== value[0] || hi !== value[1]) onchange([lo, hi])
  }
</script>

<div class="yr" role="group" aria-label={label}>
  <span class="val num" aria-hidden="true">{Math.min(lo, hi)}–{Math.max(lo, hi)}</span>
  <div class="track">
    <div class="fill" style:left={`${pct(Math.min(lo, hi))}%`} style:right={`${100 - pct(Math.max(lo, hi))}%`}></div>
    <input type="range" name="{label}-from" {min} {max} step="1" bind:value={lo} onchange={commit} aria-label={`${label}: first year`} aria-valuetext={String(lo)} />
    <input type="range" name="{label}-to" {min} {max} step="1" bind:value={hi} onchange={commit} aria-label={`${label}: last year`} aria-valuetext={String(hi)} />
  </div>
</div>

<style>
  .yr { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .val { font-size: 0.8rem; color: var(--ink); min-width: 6.6em; }
  .track { position: relative; flex: 1; min-width: 110px; height: 24px; }
  .track::before { content: ''; position: absolute; left: 0; right: 0; top: 11px; height: 2px; background: var(--rule-strong); border-radius: 1px; }
  .fill { position: absolute; top: 11px; height: 2px; background: var(--ink-2); }
  input[type='range'] {
    position: absolute; inset: 0; width: 100%; margin: 0; background: none; pointer-events: none;
    appearance: none; -webkit-appearance: none; height: 24px;
  }
  input[type='range']::-webkit-slider-runnable-track { background: transparent; height: 24px; }
  input[type='range']::-moz-range-track { background: transparent; }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none; pointer-events: auto; width: 14px; height: 14px; margin-top: 5px; border-radius: 50%;
    background: var(--surface); border: 2px solid var(--ink-2); cursor: grab;
  }
  input[type='range']::-moz-range-thumb {
    pointer-events: auto; width: 12px; height: 12px; border-radius: 50%; background: var(--surface); border: 2px solid var(--ink-2); cursor: grab;
  }
  input[type='range']:focus-visible { outline: none; }
  input[type='range']:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--focus); outline-offset: 2px; }
  input[type='range']:focus-visible::-moz-range-thumb { outline: 2px solid var(--focus); outline-offset: 2px; }
</style>
