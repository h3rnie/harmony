<script lang="ts">
  // Scrubber over the whole record: global monthly total as a sparkline, year ticks, switch marker, playhead.
  import { monthLong, yearOf } from '../format'

  let { m0, m1, totals, switchM, value, onseek }: {
    m0: number; m1: number; totals: number[]; switchM: number; value: number; onseek: (m: number, done: boolean) => void
  } = $props()

  let width = $state(800)
  const HGT = 54, TOP = 6, BASE = 38
  const x = (m: number) => ((m - m0) / Math.max(1, m1 - m0)) * width
  const max = $derived(Math.max(1, ...totals.slice(0, m1 - m0 + 1)))
  const area = $derived.by(() => {
    let d = `M0,${BASE}`
    for (let m = m0; m <= m1; m++) d += `L${x(m).toFixed(1)},${(BASE - ((totals[m - m0] ?? 0) / max) * (BASE - TOP)).toFixed(1)}`
    return `${d}L${width},${BASE}Z`
  })
  const years = $derived.by(() => {
    const out: { m: number; y: number; label: boolean }[] = []
    for (let y = yearOf(m0) + 1; y <= yearOf(m1); y++) out.push({ m: (y - 2000) * 12, y, label: y % 5 === 0 })
    return out
  })
  const cur = $derived(Math.floor(value))

  let svg: SVGSVGElement
  let dragging = false
  function at(e: PointerEvent) {
    const r = svg.getBoundingClientRect()
    return Math.max(m0, Math.min(m1, Math.round(m0 + ((e.clientX - r.left) / r.width) * (m1 - m0))))
  }
</script>

<div class="tl" bind:clientWidth={width}>
  <svg
    bind:this={svg}
    width={width} height={HGT} role="slider" tabindex="0"
    aria-label="Month" aria-valuemin={m0} aria-valuemax={m1} aria-valuenow={cur} aria-valuetext={monthLong(cur)}
    onpointerdown={(e) => { dragging = true; try { svg.setPointerCapture(e.pointerId) } catch { /* gone */ } onseek(at(e), false) }}
    onpointermove={(e) => { if (dragging) onseek(at(e), false) }}
    onpointerup={(e) => { if (dragging) { dragging = false; onseek(at(e), true) } }}
    onpointercancel={() => (dragging = false)}
  >
    <path class="area" d={area} />
    {#if switchM > m0 && switchM < m1}
      <line class="switch" x1={x(switchM)} x2={x(switchM)} y1={TOP - 4} y2={BASE} />
      <text class="sw" x={x(switchM) + 4} y={TOP + 4}>VIIRS-calibrated</text>
    {/if}
    <line class="base" x1="0" x2={width} y1={BASE} y2={BASE} />
    {#each years as t (t.y)}
      <line class="tick" class:major={t.label} x1={x(t.m)} x2={x(t.m)} y1={BASE} y2={BASE + (t.label ? 6 : 3)} />
      {#if t.label && x(t.m) > 14 && x(t.m) < width - 14}<text class="yr" x={x(t.m)} y={HGT - 2}>{t.y}</text>{/if}
    {/each}
    <line class="head" x1={x(value)} x2={x(value)} y1={TOP - 4} y2={BASE + 2} />
    <circle class="knob" cx={x(value)} cy={BASE} r="4.5" />
  </svg>
</div>

<style>
  .tl { flex: 1; min-width: 0; }
  svg { display: block; overflow: visible; cursor: pointer; touch-action: none; }
  svg:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
  .area { fill: color-mix(in srgb, var(--ink-3) 30%, transparent); stroke: var(--ink-3); stroke-width: 0.8; }
  .base { stroke: var(--rule-strong); }
  .tick { stroke: var(--rule-strong); }
  .tick.major { stroke: var(--ink-3); }
  .yr { fill: var(--ink-3); font: var(--fs-xs) var(--font-num); text-anchor: middle; }
  .switch { stroke: var(--ink-3); stroke-dasharray: 2 3; }
  .sw { fill: var(--ink-3); font: 500 var(--fs-xs) var(--font-display); letter-spacing: var(--track-label); text-transform: uppercase; }
  .head { stroke: var(--accent); stroke-width: 1.4; }
  .knob { fill: var(--accent); stroke: var(--bg); stroke-width: 2; }
</style>
