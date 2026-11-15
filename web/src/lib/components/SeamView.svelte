<script lang="ts">
  // The area-specific lead of "How we know": raw counts (the seam) against the harmonized record.
  // Default: the fused record (every satellite flying, weighted by measured reliability) with its interval for every
  // month, the two input streams faint behind it, and a strip showing which sensor family carries the record.
  // The original hard switch survives as a comparison under "Advanced".
  import { Tween } from 'svelte/motion'
  import { cubicInOut } from 'svelte/easing'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { linear, linePath, bandPath, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, fmtRatio, monthShort, toM, yearOf } from '../format'
  import { SOURCE_SHORT } from '../analysisUtil'
  import Term from './Term.svelte'

  let { a }: { a: Analysis } = $props()

  let harmonized = $state(true)
  let width = $state(640)
  const height = 280
  const STRIP = 58 // room under the x axis for the "who carries the record" strip and satellite markers
  const M = { t: 16, r: 14, b: 26, l: 48 }
  const t = new Tween(1, { duration: 1100, easing: cubicInOut })
  $effect(() => { t.set(harmonized ? 1 : 0, { duration: themeState.reducedMotion ? 0 : 1100 }) })

  const meta = $derived(session.meta!)
  const vStart = $derived(meta.viirs_start_m)
  const fused = $derived((a.harmonization?.mode ?? 'switch') === 'fused')
  const sw = $derived(session.effectiveSwitchM)
  const unit = $derived(session.unitLabel)
  const n = $derived(a.months.length)
  const x = $derived(linear([a.months[0], a.months[n - 1]], [M.l, width - M.r]))
  const xs = $derived(a.months.map((m) => x(m)))
  const modisLine = $derived(a.series.modisAdj ?? a.series.modisEq)

  const rawMax = $derived(niceMax(Math.max(1, ...a.series.naive, ...a.series.rawModisCount)))
  const harmMax = $derived(niceMax(Math.max(1, ...a.series.harmonized.map((v) => v ?? 0), ...modisLine.map((v) => v ?? 0), ...a.series.viirsCal.map((v) => v ?? 0)) * 1.05))
  const yRaw = $derived(linear([0, rawMax], [height - M.b, M.t]))
  const yHarm = $derived(linear([0, harmMax], [height - M.b, M.t]))
  const clampY = (v: number) => Math.max(M.t - 4, v)

  // Pixel y arrays in each state, morphed by t.
  const mainRaw = $derived(a.series.naive.map((v) => yRaw(v)))
  const mainHarm = $derived(a.series.harmonized.map((v) => (v == null ? yHarm(0) : yHarm(v))))
  const modRaw = $derived(a.series.rawModisCount.map((v) => yRaw(v)))
  const modHarm = $derived(modisLine.map((v) => (v == null ? yHarm(0) : yHarm(v))))
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
  // Main record: MODIS part and VIIRS part (raw: naive counts; harmonized: one line in the record's unit).
  const pathA = $derived(seg(mainRaw, mainHarm, -Infinity, vStart))
  const pathB = $derived(seg(mainRaw, mainHarm, vStart, Infinity))
  // MODIS continuing through the VIIRS era (raw counts -> MODIS-derived, drift-corrected in the drift years).
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

  // ---- who carries the record: MODIS share of each month's value (switch mode: 1 or 0) ----
  const weights = $derived(a.series.modisWeight ?? null)
  const stripY = height + 18
  const stripH = 9
  const bandW = $derived(n > 1 ? (xs[n - 1] - xs[0]) / (n - 1) : 4)
  const stripFill = (w: number) => `color-mix(in oklab, var(--s-modis) ${Math.round(w * 100)}%, var(--s-viirs))`
  // Labelled spans: MODIS alone, shared, VIIRS alone (only where wide enough to read).
  const spans = $derived.by(() => {
    if (!weights) return []
    const out: { kind: 'modis' | 'shared' | 'viirs'; i0: number; i1: number }[] = []
    let cur: (typeof out)[number] | null = null
    weights.forEach((w, i) => {
      if (w == null) return
      const kind = w >= 0.995 ? 'modis' : w <= 0.005 ? 'viirs' : 'shared'
      // Months without a weight (no value, or zero) do not break a span: quiet areas would otherwise lose every label.
      if (cur && cur.kind === kind) cur.i1 = i
      else { cur = { kind, i0: i, i1: i }; out.push(cur) }
    })
    return out.filter((s) => xs[s.i1] - xs[s.i0] > 70)
  })
  const SPAN_LABEL = { modis: 'MODIS alone', shared: 'shared', viirs: 'VIIRS alone' } as const

  // Satellite launches and ends (record months). NOAA-20 / NOAA-21 from the VIIRS satellite bitmask in meta.json.
  const SNPP_END = toM(2026, 11) // S-NPP stopped on 2 Nov 2026 (docs/METHOD.md section 13)
  const firstWithBit = (bit: number) => {
    const sats = meta.months.viirs_sats
    for (let m = 0; m < sats.length; m++) if (sats[m] & bit) return m
    return null
  }
  const markers = $derived.by(() => {
    const list: { m: number | null; label: string; end?: boolean }[] = [
      { m: meta.m_first, label: 'Terra' },
      { m: meta.aqua_start_m, label: 'Aqua' },
      { m: firstWithBit(1) ?? vStart, label: 'S-NPP' },
      { m: firstWithBit(2), label: 'NOAA-20' },
      { m: firstWithBit(4), label: 'NOAA-21' },
      { m: SNPP_END, label: 'S-NPP ends', end: true },
    ]
    const lo = a.months[0], hi = a.months[n - 1]
    // Greedy placement on two label rows; a label that fits on neither is left to the table / aria text.
    const rowsEnd = [-Infinity, -Infinity]
    const out: { x: number; label: string; row: number; end?: boolean; m: number }[] = []
    for (const mk of list) {
      if (mk.m == null || mk.m < lo || mk.m > hi) continue
      const px = x(mk.m)
      const w = mk.label.length * 6.6 + 6
      const left = Math.min(px, width - M.r - w)
      const row = rowsEnd.findIndex((e) => left > e + 4)
      if (row < 0) continue
      rowsEnd[row] = left + w
      out.push({ x: px, label: mk.label, row, end: mk.end, m: mk.m })
    }
    return out
  })
  const markersText = $derived(markers.map((mk) => `${mk.label} ${monthShort(mk.m)}`).join(', '))

  /** Value-weighted MODIS share in a year span, for this area. */
  function shareIn(y0: number, y1: number): number | null {
    if (!weights) return null
    let sw = 0, sh = 0
    a.months.forEach((m, i) => {
      const w = weights[i], h = a.series.harmonized[i]
      const y = yearOf(m)
      if (w == null || h == null || y < y0 || y > y1 || a.series.partial?.[i]) return
      sw += w * h; sh += h
    })
    return sh > 0 ? sw / sh : null
  }
  const lastYear = $derived(yearOf(a.current.m))
  const shareEarly = $derived(fused ? shareIn(2012, 2019) : null)
  const shareLate = $derived(fused ? shareIn(lastYear, lastYear) : null)

  // Switch-year slider (Advanced comparison)
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
    h: a.series.harmonized[hover], meq: a.series.modisEq[hover], adj: a.series.modisAdj?.[hover] ?? null, vc: a.series.viirsCal[hover],
    lo: a.series.lo80[hover], hi: a.series.hi80[hover], src: a.series.source[hover], w: weights?.[hover] ?? null,
  })

  const s = $derived(a.seam)
  const summary = $derived(
    s.ratioNaive == null
      ? 'No overlap months with both sensors in this area.'
      : `Raw VIIRS reports ${fmtRatio(s.ratioNaive)} as many hotspots as MODIS here; after harmonization the ratio is ${fmtRatio(s.ratioHarmonized)}${s.r != null ? `, r = ${s.r.toFixed(2)}` : ''}.`,
  )
  const shareText = $derived(
    shareEarly != null && shareLate != null
      ? `Here MODIS carries ${Math.round(shareEarly * 100)} % of the record in 2012–2019 and ${Math.round(shareLate * 100)} % in ${lastYear}.`
      : '',
  )
</script>

<section class="seam" id="seam" aria-labelledby="seam-h">
  <div class="head">
    <h3 id="seam-h" class="sub-title">Why two satellites had to be joined</h3>
    <div class="seg toggle" role="radiogroup" aria-label="Series shown">
      <button role="radio" aria-checked={!harmonized} onclick={() => (harmonized = false)}>Raw sensors</button>
      <button role="radio" aria-checked={harmonized} onclick={() => (harmonized = true)}>Harmonized</button>
    </div>
  </div>

  <p class="lede">
    {#if !harmonized}
      Joining the raw counts end to end, <Term id="sensors">MODIS</Term> until {yearOf(vStart)} and VIIRS after, invents a jump: the finer VIIRS sensor simply sees more small fires. That is <Term id="seam">the 2012 seam</Term>.
    {:else if fused}
      One unit across both eras, <Term id="afcdm" />. Where both satellite families fly, the record <Term id="fusion">combines them</Term>, each weighted by how reliable it has proved; MODIS (blue) and calibrated VIIRS (green) run faintly behind. The band is the likely range of every month.
    {:else}
      Comparison view: the original record, MODIS until {yearOf(sw)} and calibrated VIIRS from then on, one sensor at a time. The band is each month’s likely range.
    {/if}
  </p>

  <div class="nums">
    <div><span class="nl">Raw VIIRS ÷ MODIS</span><strong class="num">{fmtRatio(s.ratioNaive)}</strong></div>
    <div><span class="nl">After harmonizing</span><strong class="num">{fmtRatio(s.ratioHarmonized)}</strong></div>
    <div><span class="nl">Agreement (r)</span><strong class="num">{s.r == null ? '—' : s.r.toFixed(2)}</strong></div>
    <div><span class="nl">Bias</span><strong class="num">{s.biasPct == null ? '—' : `${s.biasPct >= 0 ? '+' : '−'}${Math.abs(s.biasPct).toFixed(1)} %`}</strong></div>
    <div class="muted ov">{s.nMonths} months with both sensors, {monthShort(s.overlap[0])} – {monthShort(s.overlap[1])}</div>
  </div>

  <div class="chart" bind:clientWidth={width}>
    <svg {width} height={height + STRIP} role="img" aria-label={`${summary} ${harmonized && weights ? `Strip below the axis: which sensor carries the record. ${shareText} Satellites: ${markersText}.` : ''}`} onpointermove={onMove} onpointerleave={() => (hover = null)}>
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
      <text class="unit" x={M.l} y={M.t - 4}>{k < 0.5 ? 'hotspot detections / month' : `${unit} / month`}</text>
      {#each xTicks as y (y)}
        <text class="xt" x={x((y - 2000) * 12)} y={height - 8} text-anchor="middle">{y}</text>
      {/each}

      <!-- era markers -->
      <line class="era" x1={x(vStart)} x2={x(vStart)} y1={M.t} y2={height - M.b} />
      <text class="era-l" x={x(vStart) + 4} y={M.t + 10}>VIIRS starts</text>
      {#if !fused && sw > vStart}
        <line class="era sw" x1={x(sw)} x2={x(sw)} y1={M.t} y2={height - M.b} style:opacity={k} />
        <text class="era-l" x={x(sw) + 4} y={M.t + 22} style:opacity={k}>switch {yearOf(sw)}</text>
      {/if}

      <!-- uncertainty -->
      <path d={band95} class="band95" style:opacity={k} />
      <path d={band80} class="band80" style:opacity={k} />

      <!-- MODIS continuing through the overlap -->
      <path d={pathMod} class="line modis thin" style:opacity={lerp(0.85, 0.55, k)} />
      <!-- calibrated VIIRS (harmonized only) -->
      <path d={pathVii} class="line viirs thin" style:opacity={0.6 * k} />
      <!-- the record -->
      <path d={pathA} class="line main" style:stroke={k > 0.5 ? 'var(--s-harm)' : 'var(--s-modis)'} />
      <path d={pathB} class="line main" style:stroke={k > 0.5 ? 'var(--s-harm)' : 'var(--s-viirs)'} />

      {#if hv}
        <line class="cross" x1={hv.x} x2={hv.x} y1={M.t} y2={height - M.b + (weights ? stripY + stripH - height + M.b : 0) * k} />
      {/if}

      <!-- who carries the record -->
      {#if weights}
        <g class="strip" style:opacity={k} aria-hidden="true">
          <rect class="track" x={xs[0] - bandW / 2} y={stripY} width={xs[n - 1] - xs[0] + bandW} height={stripH} />
          {#each weights as w, i (i)}
            {#if w != null}<rect x={xs[i] - bandW / 2} y={stripY} width={bandW + 0.6} height={stripH} style:fill={stripFill(w)} />{/if}
          {/each}
          {#each spans as sp (sp.i0)}
            <text class="span-l" x={(xs[sp.i0] + xs[sp.i1]) / 2} y={stripY - 4} text-anchor="middle">{SPAN_LABEL[sp.kind]}</text>
          {/each}
          {#each markers as mk (mk.label)}
            <line class="mk" x1={mk.x} x2={mk.x} y1={stripY + stripH} y2={stripY + stripH + 5 + mk.row * 13} />
          {/each}
          {#each markers as mk (mk.label)}
            <text class="mk-l" x={Math.min(mk.x, width - M.r - mk.label.length * 6.6)} y={stripY + stripH + 15 + mk.row * 13}>{mk.label}</text>
          {/each}
        </g>
      {/if}
    </svg>
    {#if hv}
      <div class="tip" style:left={`${Math.min(width - 210, Math.max(0, hv.x + 10))}px`}>
        <p class="tt">{monthShort(hv.m)}{harmonized && hv.w != null && fused ? '' : ` · ${SOURCE_SHORT[hv.src]}`}</p>
        {#if !harmonized}
          <p><span class="sw modis"></span>MODIS detections <span class="num">{fmtNum(hv.modis)}</span></p>
          {#if hv.m >= vStart}<p><span class="sw viirs"></span>VIIRS detections <span class="num">{fmtNum(hv.viirs)}</span></p>{/if}
        {:else}
          <p><span class="sw harm"></span>{fused ? 'Fused record' : 'Harmonized'} <span class="num">{fmtNum(hv.h)}</span></p>
          {#if hv.lo != null}<p class="muted">likely range <span class="num">{fmtNum(hv.lo)} – {fmtNum(hv.hi)}</span></p>{/if}
          {#if hv.meq != null}<p><span class="sw modis"></span>MODIS-derived <span class="num">{fmtNum(hv.meq)}</span></p>{/if}
          {#if hv.adj != null && hv.meq != null && Math.abs(hv.adj - hv.meq) > 0.005 * Math.max(1, hv.meq)}<p class="muted">drift-corrected <span class="num">{fmtNum(hv.adj)}</span></p>{/if}
          {#if hv.vc != null}<p><span class="sw viirs"></span>Calibrated VIIRS <span class="num">{fmtNum(hv.vc)}</span></p>{/if}
          {#if hv.w != null}<p class="muted">MODIS weight <span class="num">{hv.w.toFixed(2)}</span></p>{/if}
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
        <li><span class="sw harm"></span>{fused ? 'Fused record' : 'Harmonized record'}</li>
        <li><span class="sw modis"></span>MODIS-derived{fused ? ', drift-corrected from 2020' : ''}</li>
        <li><span class="sw viirs"></span>Calibrated VIIRS</li>
        <li><span class="sw band"></span>80 / 95 % likely range</li>
        {#if weights}<li><span class="sw grad"></span>Strip: who carries the record, MODIS → VIIRS</li>{/if}
      {/if}
    </ul>
  </div>
  {#if harmonized && shareText}<p class="share">{shareText}</p>{/if}

  <details class="more">
    <summary>Advanced: compare with the old hard switch</summary>
    <div class="more-body">
      <p class="why">Harmony used to switch from MODIS to VIIRS on one date. Fusion replaced it because it uses every satellite flying each month and lets MODIS count for less as its orbit drifts, instead of dropping one sensor outright.</p>
      <div class="seg" role="radiogroup" aria-label="How the record is built">
        <button role="radio" aria-checked={session.recordMode === 'fused'} onclick={() => session.setRecordMode('fused')}>Fused (default)</button>
        <button role="radio" aria-checked={session.recordMode === 'switch'} onclick={() => session.setRecordMode('switch')}>Hard switch</button>
      </div>
      {#if session.recordMode === 'switch'}
        <label class="slider">
          <span>Calibrated VIIRS carries the record from <strong class="num">{sliderYear}</strong></span>
          <input type="range" name="switch-year" min={firstSwitch} max={lastSwitch} step="1" bind:value={sliderYear} onchange={commitSwitch} aria-label="Switch year: first year served from calibrated VIIRS" />
        </label>
      {/if}
    </div>
  </details>
  <p class="sr-only" aria-live="polite">{harmonized ? (fused ? 'Showing the fused record.' : 'Showing the hard-switch record.') : 'Showing raw sensor counts.'} {summary}</p>
</section>

<style>
  .seam { padding: 22px 0 24px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .nl { font-size: var(--fs-sm); color: var(--ink-3); }
  .toggle button { min-height: 34px; padding: 0 14px; font-size: var(--fs-md); }
  .lede { color: var(--ink-2); max-width: var(--measure); margin: 10px 0 12px; min-height: 3em; }
  .nums { display: flex; flex-wrap: wrap; gap: 8px 26px; align-items: flex-end; margin-bottom: 8px; }
  .nums > div { display: grid; }
  .nums strong { font-size: var(--fs-stat); font-weight: 600; letter-spacing: -0.03em; }
  .ov { align-self: end; }
  .chart { position: relative; width: 100%; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .axis text, .xt, .unit, .era-l, .span-l, .mk-l { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .unit, .span-l, .mk-l { font-family: var(--font-ui); }
  .unit { font-size: var(--fs-sm); }
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
  .track { fill: var(--surface-2); }
  .mk { stroke: var(--ink-3); stroke-width: 1; }
  .mk-l { paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round; }
  .tip {
    position: absolute; top: 18px; pointer-events: none; z-index: 5; min-width: 200px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: var(--fs-sm);
  }
  .tip p { margin: 0; display: flex; align-items: center; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; margin-bottom: 3px !important; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 14px; height: 2px; background: var(--ink); flex: none; }
  .sw.modis { background: var(--s-modis); }
  .sw.viirs { background: var(--s-viirs); }
  .sw.harm { background: var(--s-harm); height: 3px; }
  .sw.band { height: 9px; background: var(--band-80); }
  .sw.grad { height: 9px; width: 28px; background: linear-gradient(90deg, var(--s-modis), var(--s-viirs)); }
  .share { margin: 8px 0 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .why { margin: 0 0 8px; font-size: var(--fs-sm); color: var(--ink-2); max-width: var(--measure); }
  .more-body { display: grid; gap: 8px; justify-items: start; }
  .slider { display: grid; gap: 2px; font-size: var(--fs-sm); color: var(--ink-2); max-width: 360px; width: 100%; }
</style>
