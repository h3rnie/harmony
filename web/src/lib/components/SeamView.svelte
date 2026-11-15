<script lang="ts">
  import { Tween } from 'svelte/motion'
  import { cubicInOut } from 'svelte/easing'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { linear, linePath, bandPath, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, fmtRatio, monthShort, yearOf } from '../format'
  import { SOURCE_SHORT } from '../analysisUtil'

  let { a }: { a: Analysis } = $props()

  let harmonized = $state(false)
  let width = $state(640)
  const height = 280
  const M = { t: 16, r: 14, b: 26, l: 48 }
  const t = new Tween(0, { duration: 1100, easing: cubicInOut })
  $effect(() => { t.set(harmonized ? 1 : 0, { duration: themeState.reducedMotion ? 0 : 1100 }) })

  const meta = $derived(session.meta!)
  const vStart = $derived(meta.viirs_start_m)
  const sw = $derived(session.effectiveSwitchM)
  const n = $derived(a.months.length)
  const x = $derived(linear([a.months[0], a.months[n - 1]], [M.l, width - M.r]))
  const xs = $derived(a.months.map((m) => x(m)))

  const rawMax = $derived(niceMax(Math.max(1, ...a.series.naive, ...a.series.rawModisCount)))
  const harmMax = $derived(niceMax(Math.max(1, ...a.series.harmonized.map((v) => v ?? 0), ...a.series.modisEq.map((v) => v ?? 0), ...a.series.viirsCal.map((v) => v ?? 0)) * 1.05))
  const yRaw = $derived(linear([0, rawMax], [height - M.b, M.t]))
  const yHarm = $derived(linear([0, harmMax], [height - M.b, M.t]))
  const clampY = (v: number) => Math.max(M.t - 4, v)

  // Pixel y arrays in each state, morphed by t.
  const mainRaw = $derived(a.series.naive.map((v) => yRaw(v)))
  const mainHarm = $derived(a.series.harmonized.map((v) => (v == null ? yHarm(0) : yHarm(v))))
  const modRaw = $derived(a.series.rawModisCount.map((v) => yRaw(v)))
  const modHarm = $derived(a.series.modisEq.map((v) => (v == null ? yHarm(0) : yHarm(v))))
  const viiHarm = $derived(a.series.viirsCal.map((v) => (v == null ? null : yHarm(v))))

  const lerp = (p: number, q: number, k: number) => p + (q - p) * k
  const k = $derived(t.current)
  const seg = (arr0: number[], arr1: number[], from: number, to: number) => {
    const pts: ([number, number] | null)[] = []
    for (let i = 0; i < n; i++) {
      const m = a.months[i]
      pts.push(m >= from && m < to ? [xs[i], clampY(lerp(arr0[i], arr1[i], k))] : null)
    }
    return linePath(pts)
  }
  // Main record: MODIS part and VIIRS part (raw: naive counts; harmonized: one AFCD-M line).
  const pathA = $derived(seg(mainRaw, mainHarm, -Infinity, vStart))
  const pathB = $derived(seg(mainRaw, mainHarm, vStart, Infinity))
  // MODIS continuing through the VIIRS era (raw counts -> MODIS-derived AFCD-M).
  const pathMod = $derived(seg(modRaw, modHarm, vStart, Infinity))
  const pathVii = $derived(linePath(a.months.map((m, i) => (m >= vStart && viiHarm[i] != null ? [xs[i], clampY(viiHarm[i]!)] : null))))
  const band80 = $derived(bandPath(xs, a.series.lo80.map((v) => (v == null ? null : clampY(yHarm(v)))), a.series.hi80.map((v) => (v == null ? null : clampY(yHarm(v))))))
  const band95 = $derived(bandPath(xs, a.series.lo95.map((v) => (v == null ? null : clampY(yHarm(v)))), a.series.hi95.map((v) => (v == null ? null : clampY(yHarm(v))))))

  const ticksRaw = $derived(niceTicks(0, rawMax, 4))
  const ticksHarm = $derived(niceTicks(0, harmMax, 4))
  const xTicks = $derived.by(() => {
    const y0 = yearOf(a.months[0]), y1 = yearOf(a.months[n - 1])
    const step = width < 480 ? 8 : 4
    const out: number[] = []
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) out.push(y)
    return out
  })

  // Switch-year slider
  const firstSwitch = $derived(yearOf(vStart) + 1)
  const lastSwitch = $derived(yearOf(meta.m_last))
  const switchYear = $derived(yearOf(sw))
  let sliderYear = $state(2023)
  $effect.pre(() => { sliderYear = switchYear })
  function commitSwitch() {
    const def = yearOf(meta.default_switch_m)
    session.setSwitchYear(sliderYear === def && meta.default_switch_m % 12 === 0 ? null : sliderYear)
  }

  // Hover read-out
  let hover = $state<number | null>(null)
  function onMove(e: PointerEvent) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * width
    const m = Math.round(x.invert(px))
    const i = m - a.months[0]
    hover = i >= 0 && i < n ? i : null
  }
  const hv = $derived(hover == null ? null : {
    m: a.months[hover], x: xs[hover],
    naive: a.series.naive[hover], modis: a.series.rawModisCount[hover], viirs: a.series.rawViirsCount[hover],
    h: a.series.harmonized[hover], meq: a.series.modisEq[hover], vc: a.series.viirsCal[hover],
    lo: a.series.lo80[hover], hi: a.series.hi80[hover], src: a.series.source[hover],
  })

  const s = $derived(a.seam)
  const summary = $derived(
    s.ratioNaive == null
      ? 'No overlap months with both sensors in this area.'
      : `Raw VIIRS reports ${fmtRatio(s.ratioNaive)} as many hotspots as MODIS here; after harmonization the ratio is ${fmtRatio(s.ratioHarmonized)}${s.r != null ? `, r = ${s.r.toFixed(2)}` : ''}.`,
  )
</script>

<section class="seam" aria-labelledby="seam-h">
  <div class="head">
    <div>
      <p class="eyebrow">03 · Why harmonize?</p>
      <h2 id="seam-h">The 2012 seam</h2>
    </div>
    <div class="seg toggle" role="radiogroup" aria-label="Series shown">
      <button role="radio" aria-checked={!harmonized} onclick={() => (harmonized = false)}>Raw sensors</button>
      <button role="radio" aria-checked={harmonized} onclick={() => (harmonized = true)}>Harmonized</button>
    </div>
  </div>

  <p class="lede">
    {#if !harmonized}
      Stitching hotspot counts together — MODIS until {yearOf(vStart)}, VIIRS after — invents a jump: the finer VIIRS sensor simply sees more.
    {:else}
      One unit across both eras: MODIS-equivalent active-fire cell-days. Calibrated VIIRS (green) tracks MODIS (blue) where both fly; the band is the 80 / 95 % interval once VIIRS carries the record.
    {/if}
  </p>

  <div class="nums">
    <div><span class="eyebrow">Raw VIIRS ÷ MODIS</span><strong class="num">{fmtRatio(s.ratioNaive)}</strong></div>
    <div><span class="eyebrow">Harmonized ratio</span><strong class="num">{fmtRatio(s.ratioHarmonized)}</strong></div>
    <div><span class="eyebrow">Agreement r</span><strong class="num">{s.r == null ? '—' : s.r.toFixed(2)}</strong></div>
    <div><span class="eyebrow">Bias</span><strong class="num">{s.biasPct == null ? '—' : `${s.biasPct >= 0 ? '+' : '−'}${Math.abs(s.biasPct).toFixed(1)} %`}</strong></div>
    <div class="small muted ov">{s.nMonths} overlap months, {monthShort(s.overlap[0])} – {monthShort(s.overlap[1])}</div>
  </div>

  <div class="chart" bind:clientWidth={width}>
    <svg {width} {height} role="img" aria-label={summary} onpointermove={onMove} onpointerleave={() => (hover = null)}>
      <!-- grid + y axis (cross-fading between units) -->
      <g class="axis" style:opacity={1 - k}>
        {#each ticksRaw as v (v)}
          <line x1={M.l} x2={width - M.r} y1={yRaw(v)} y2={yRaw(v)} class="grid" />
          <text x={M.l - 6} y={yRaw(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
        {/each}
      </g>
      <g class="axis" style:opacity={k}>
        {#each ticksHarm as v (v)}
          <line x1={M.l} x2={width - M.r} y1={yHarm(v)} y2={yHarm(v)} class="grid" />
          <text x={M.l - 6} y={yHarm(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
        {/each}
      </g>
      <text class="unit" x={M.l} y={M.t - 4}>{k < 0.5 ? 'hotspot detections / month' : 'AFCD-M / month'}</text>
      {#each xTicks as y (y)}
        <text class="xt" x={x((y - 2000) * 12)} y={height - 8} text-anchor="middle">{y}</text>
      {/each}

      <!-- era markers -->
      <line class="era" x1={x(vStart)} x2={x(vStart)} y1={M.t} y2={height - M.b} />
      <text class="era-l" x={x(vStart) + 4} y={M.t + 10}>VIIRS starts</text>
      {#if sw > vStart}
        <line class="era sw" x1={x(sw)} x2={x(sw)} y1={M.t} y2={height - M.b} style:opacity={k} />
        <text class="era-l" x={x(sw) + 4} y={M.t + 22} style:opacity={k}>switch {yearOf(sw)}</text>
      {/if}

      <!-- uncertainty -->
      <path d={band95} class="band95" style:opacity={k} />
      <path d={band80} class="band80" style:opacity={k} />

      <!-- MODIS continuing through the overlap -->
      <path d={pathMod} class="line modis thin" style:opacity={0.45 + 0.4 * k} />
      <!-- calibrated VIIRS overlay (harmonized only) -->
      <path d={pathVii} class="line viirs thin" style:opacity={0.85 * k} />
      <!-- the record -->
      <path d={pathA} class="line main" style:stroke={k > 0.5 ? 'var(--s-harm)' : 'var(--s-modis)'} />
      <path d={pathB} class="line main" style:stroke={k > 0.5 ? 'var(--s-harm)' : 'var(--s-viirs)'} />

      {#if hv}
        <line class="cross" x1={hv.x} x2={hv.x} y1={M.t} y2={height - M.b} />
      {/if}
    </svg>
    {#if hv}
      <div class="tip" style:left={`${Math.min(width - 190, Math.max(0, hv.x + 10))}px`}>
        <p class="tt">{monthShort(hv.m)} · {SOURCE_SHORT[hv.src]}</p>
        {#if !harmonized}
          <p><span class="sw modis"></span>MODIS detections <span class="num">{fmtNum(hv.modis)}</span></p>
          {#if hv.m >= vStart}<p><span class="sw viirs"></span>VIIRS detections <span class="num">{fmtNum(hv.viirs)}</span></p>{/if}
        {:else}
          <p><span class="sw harm"></span>Harmonized <span class="num">{fmtNum(hv.h)}</span></p>
          {#if hv.lo != null}<p class="muted">80 %: <span class="num">{fmtNum(hv.lo)} – {fmtNum(hv.hi)}</span></p>{/if}
          <p><span class="sw modis"></span>MODIS-derived <span class="num">{fmtNum(hv.meq)}</span></p>
          {#if hv.vc != null}<p><span class="sw viirs"></span>Calibrated VIIRS <span class="num">{fmtNum(hv.vc)}</span></p>{/if}
        {/if}
      </div>
    {/if}
  </div>

  <div class="foot">
    <ul class="keys" aria-label="Legend">
      {#if !harmonized}
        <li><span class="sw modis"></span>MODIS hotspot count</li>
        <li><span class="sw viirs"></span>VIIRS hotspot count (naive continuation)</li>
      {:else}
        <li><span class="sw harm"></span>Harmonized record</li>
        <li><span class="sw modis"></span>MODIS-derived</li>
        <li><span class="sw viirs"></span>Calibrated VIIRS</li>
        <li><span class="sw band"></span>80 / 95 % interval</li>
      {/if}
    </ul>
    <label class="slider">
      <span>Calibrated VIIRS carries the record from <strong class="num">{sliderYear}</strong></span>
      <input type="range" name="switch-year" min={firstSwitch} max={lastSwitch} step="1" bind:value={sliderYear} onchange={commitSwitch} aria-label="Switch year: first year served from calibrated VIIRS" />
    </label>
  </div>
  <p class="sr-only" aria-live="polite">{harmonized ? 'Showing harmonized record.' : 'Showing raw sensor counts.'} {summary}</p>
</section>

<style>
  .seam { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .toggle button { min-height: 34px; padding: 0 14px; font-size: 0.86rem; }
  .lede { color: var(--ink-2); max-width: 62ch; margin: 10px 0 12px; min-height: 3em; }
  .nums { display: flex; flex-wrap: wrap; gap: 8px 26px; align-items: flex-end; margin-bottom: 8px; }
  .nums > div { display: grid; }
  .nums strong { font-size: 1.45rem; font-weight: 600; letter-spacing: -0.03em; }
  .ov { align-self: end; }
  .chart { position: relative; width: 100%; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .axis text, .xt, .unit, .era-l { font-family: var(--font-num); font-size: 10px; fill: var(--ink-3); }
  .unit { font-family: var(--font-ui); font-size: 11px; }
  .era { stroke: var(--ink-3); stroke-width: 1; }
  .era.sw { stroke: var(--ink-2); }
  .band80 { fill: var(--band-80); }
  .band95 { fill: var(--band-95); }
  .line { fill: none; stroke-linejoin: round; stroke-linecap: round; }
  .line.main { stroke-width: 1.6; transition: stroke 0.5s; }
  .line.thin { stroke-width: 1; }
  .line.modis { stroke: var(--s-modis); }
  .line.viirs { stroke: var(--s-viirs); }
  .cross { stroke: var(--ink-3); stroke-width: 1; }
  .tip {
    position: absolute; top: 18px; pointer-events: none; z-index: 5; min-width: 180px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: 0.76rem;
  }
  .tip p { margin: 0; display: flex; align-items: center; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; margin-bottom: 3px !important; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; font-size: 0.76rem; color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 14px; height: 2px; background: var(--ink); flex: none; }
  .sw.modis { background: var(--s-modis); }
  .sw.viirs { background: var(--s-viirs); }
  .sw.harm { background: var(--s-harm); height: 3px; }
  .sw.band { height: 9px; background: var(--band-80); }
  .slider { display: grid; gap: 2px; font-size: 0.8rem; color: var(--ink-2); min-width: 240px; }
</style>
