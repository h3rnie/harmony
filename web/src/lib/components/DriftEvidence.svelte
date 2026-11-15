<script lang="ts">
  // "Has MODIS itself changed?" — the orbit-drift fingerprint (docs/METHOD.md section 10, Tables M8a–c).
  // Global evidence from validation.json `drift`; independent of the selected area. Every number is read from the file.
  import { onMount } from 'svelte'
  import { validation, f2, ratioWords, signedPct, type DriftRow } from '../validation.svelte'
  import { linear, linePath, bandPath, niceTicks } from '../charts/scale'
  import Term from './Term.svelte'

  onMount(() => { validation.load() })

  const d = $derived(validation.data?.drift ?? null)
  const blind = $derived(validation.data?.noaa21_blind ?? null)
  let scope = $state('global')
  let showTable = $state(false)
  let width = $state(640)

  const groupIndex = $derived(scope.startsWith('group_') ? Number(scope.slice(6)) : null)
  const groupName = $derived(groupIndex != null && d ? d.group_names[groupIndex] : null)
  const where = $derived(groupName ? groupName.toLowerCase() : 'all land')

  const SATS = [
    { id: 'terra', title: 'Terra', pass: 'morning pass' },
    { id: 'aqua', title: 'Aqua', pass: 'afternoon pass' },
  ] as const
  const rows = (sat: string, dn: 0 | 1): DriftRow[] =>
    (d?.table ?? []).filter((r) => r.sat === sat && r.scope === scope && r.dn === dn).sort((p, q) => p.year - q.year)
  const series = $derived(SATS.map((s) => ({ ...s, day: rows(s.id, 0), night: rows(s.id, 1) })))
  const years = $derived([...new Set(series.flatMap((s) => [...s.day, ...s.night].map((r) => r.year)))].sort((p, q) => p - q))
  /** The latest complete year carries the headline; a later partial year is drawn hollow. */
  const headYear = $derived(Math.max(...series[0].day.filter((r) => r.months >= 12).map((r) => r.year)))
  const partial = $derived(series[0].day.find((r) => r.year > headYear) ?? null)
  const at = (list: DriftRow[], y: number) => list.find((r) => r.year === y) ?? null

  // ---- layout ----
  const stacked = $derived(width < 560)
  const gap = 28
  const panelW = $derived(stacked ? width : (width - gap) / 2)
  const H = 230
  const M = { t: 26, r: 48, b: 24, l: 40 }
  const x = $derived(linear([years[0] ?? 2012, years[years.length - 1] ?? 2026], [M.l, panelW - M.r]))
  const yDom = $derived.by(() => {
    let lo = 0.8, hi = 1.25
    for (const s of series) for (const r of [...s.day, ...s.night]) { lo = Math.min(lo, r.lo95_total); hi = Math.max(hi, r.hi95_total) }
    return [lo / 1.04, hi * 1.04] as [number, number]
  })
  const yLog = $derived(linear([Math.log(yDom[0]), Math.log(yDom[1])], [H - M.b, M.t]))
  const y = (v: number) => yLog(Math.log(v))
  const yTicks = $derived.by(() => {
    const cand = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]
    const inDom = cand.filter((v) => v >= yDom[0] && v <= yDom[1])
    return inDom.length >= 3 ? inDom : [...new Set([...inDom, 0.9, 1, 1.1])].filter((v) => v >= yDom[0] && v <= yDom[1]).sort()
  })
  const ref = $derived(d?.ref_years ?? [2012, 2019])

  const line = (list: DriftRow[]) => linePath(list.map((r) => [x(r.year), y(r.ratio)]))
  const band = (list: DriftRow[]) => bandPath(list.map((r) => x(r.year)), list.map((r) => y(r.lo95_total)), list.map((r) => y(r.hi95_total)))

  /** End labels "day" / "night", pushed apart when they would collide. */
  function endLabels(day: DriftRow[], night: DriftRow[]) {
    const a = day[day.length - 1], b = night[night.length - 1]
    if (!a || !b) return []
    let ya = y(a.ratio), yb = y(b.ratio)
    if (Math.abs(ya - yb) < 13) { const mid = (ya + yb) / 2, s = ya <= yb ? -1 : 1; ya = mid + s * 6.5; yb = mid - s * 6.5 }
    return [{ text: 'day', y: ya, x: x(a.year) + 8 }, { text: 'night', y: yb, x: x(b.year) + 8 }]
  }

  // ---- overpass shift (global, daytime): Terra, Aqua and the VIIRS reference ----
  const OH = 150
  const OM = { t: 14, r: 92, b: 24, l: 40 }
  const ox = $derived(linear([years[0] ?? 2012, years[years.length - 1] ?? 2026], [OM.l, width - OM.r]))
  const shifts = $derived.by(() => {
    const pick = (sat: string) => (d?.overpass ?? []).filter((r) => r.sat === sat && r.dn === 0 && r.year >= (years[0] ?? 2012)).sort((p, q) => p.year - q.year)
    return [
      { sat: 'Terra', label: 'Terra', cls: 'modis', list: pick('Terra') },
      { sat: 'Aqua', label: 'Aqua', cls: 'modis', list: pick('Aqua') },
      { sat: 'SNPP', label: 'VIIRS (S-NPP)', cls: 'viirs', list: pick('SNPP') },
    ].filter((s) => s.list.length)
  })
  const oDom = $derived.by(() => {
    let lo = -0.5, hi = 0.5
    for (const s of shifts) for (const r of s.list) { lo = Math.min(lo, r.shift_h); hi = Math.max(hi, r.shift_h) }
    return [Math.floor(lo * 2) / 2, Math.ceil(hi * 2) / 2] as [number, number]
  })
  const oy = $derived(linear(oDom, [OH - OM.b, OM.t]))
  const shiftAt = (sat: string, yr: number) => shifts.find((s) => s.sat === sat)?.list.find((r) => r.year === yr)?.shift_h ?? null
  const shiftLabels = $derived.by(() => {
    const out = shifts.map((s) => { const last = s.list[s.list.length - 1]; return { label: s.label, y: oy(last.shift_h), cls: s.cls } })
    out.sort((p, q) => p.y - q.y)
    for (let i = 1; i < out.length; i++) if (out[i].y - out[i - 1].y < 13) out[i].y = out[i - 1].y + 13
    return out
  })

  // ---- the takeaway, from the file ----
  const tDay = $derived(at(series[0].day, headYear)), tNight = $derived(at(series[0].night, headYear))
  const aDay = $derived(at(series[1].day, headYear)), aNight = $derived(at(series[1].night, headYear))
  const changed = $derived([tDay, tNight, aDay, aNight].some((r) => r && (r.lo95_total > 1 || r.hi95_total < 1) && Math.abs(r.ratio - 1) > 0.1))
  const terraShift = $derived(shiftAt('Terra', headYear))
  const diurnal = $derived(d?.diurnal_sensitivity?.terra ?? null)
  const explained = $derived.by(() => {
    if (!diurnal || !d) return null
    if (groupName) {
      const g = diurnal[groupName]?.day
      return g ? { kind: 'group' as const, share: g.share_post_explained } : null
    }
    const all = Object.values(diurnal).map((g) => g.day.share_post_explained)
    return { kind: 'global' as const, over90: all.filter((s) => s > 0.9).length, of: all.length }
  })
  const placebo = $derived.by(() => {
    const p = d?.placebo
    if (!p) return null
    const stats = ['terra', 'aqua'].flatMap((s) => { const x = p[s]?.[scope]; return x ? [x.day, x.night] : [] })
    if (!stats.length) return null
    const typ = stats.map((s) => (Math.exp(s.rms_log) - 1) * 100)
    return { lo: Math.max(1, Math.round(Math.min(...typ))), hi: Math.round(Math.max(...typ)), max: Math.round(Math.max(...stats.map((s) => s.max_abs_pct))) }
  })
  const blindLine = $derived.by(() => {
    const b = blind?.by_year
    if (!b?.length) return null
    const y0 = b[0].year, y1 = b[b.length - 1].year
    const n20 = Math.max(...b.map((r) => Math.abs(r.vs_noaa20_calibrated.bias_pct)))
    const dc = Math.max(...b.map((r) => Math.abs(r.vs_modis_drift_corrected.stratum_month.bias_pct)))
    const late = b.slice(-2).map((r) => `${signedPct(r.vs_modis.stratum_month.bias_pct)} in ${r.year}${r.months < 12 ? ` (${r.months} months)` : ''}`)
    return { y0, y1, n20, dc, late }
  })

  // ---- hover ----
  let hover = $state<{ sat: string; year: number; px: number } | null>(null)
  function onMove(e: PointerEvent, sat: string) {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * panelW
    const yr = Math.round(x.invert(px))
    hover = years.includes(yr) ? { sat, year: yr, px: x(yr) } : null
  }
  const fmtRow = (r: DriftRow | null) => (r ? `${f2(r.ratio)} (${f2(r.lo95_total)}–${f2(r.hi95_total)})` : '—')
</script>

{#if d && tDay}
  <section class="ev" aria-labelledby="drift-h">
    <div class="head">
      <h3 id="drift-h" class="sub-title">Has MODIS itself changed?</h3>
      <label class="where">Where
        <select name="drift-scope" bind:value={scope}>
          <option value="global">All land</option>
          {#each d.group_names as g, i (g)}<option value={`group_${i}`}>{g}</option>{/each}
        </select>
      </label>
    </div>
    <p class="scope muted">Global evidence, the same for every area you select.</p>

    <p class="take">
      <strong>{changed ? 'Yes.' : 'Not clearly here.'}</strong>
      By {headYear}, over {where}, Terra’s daytime detections ran {ratioWords(tDay.ratio)} against a fixed-overpass VIIRS reference
      (<span class="num">{f2(tDay.ratio)}</span>, 95 % <span class="num">{f2(tDay.lo95_total)}–{f2(tDay.hi95_total)}</span>){#if tNight}{' '}and its night detections {ratioWords(tNight.ratio)} (<span class="num">{f2(tNight.ratio)}</span>){/if}.
      {#if aDay && aNight}Aqua’s day detections were {ratioWords(aDay.ratio)} (<span class="num">{f2(aDay.ratio)}</span>), its night detections {ratioWords(aNight.ratio)} (<span class="num">{f2(aNight.ratio)}</span>).{/if}
    </p>
    <p class="body">
      The cause is <Term id="drift">orbit drift</Term>. Terra’s <Term id="overpasstime">overpass</Term> moved
      {#if terraShift != null}about <span class="num">{Math.abs(terraShift).toFixed(1)}</span> h {terraShift < 0 ? 'earlier' : 'later'} by {headYear}{/if}{#if explained?.kind === 'global'};
      in {explained.over90} of {explained.of} biome groups that shift alone explains over 90 % of the change in its daytime ratio since 2020{:else if explained?.kind === 'group'};
      here it explains <span class="num">{Math.round(explained.share * 100)} %</span> of the change in its daytime ratio since 2020{/if}.
      {#if placebo}In the <Term id="placebo">placebo years</Term> {ref[0]}–{ref[1]}, before the drift, the same ratios sit at 1 within a typical {placebo.lo}–{placebo.hi} % (largest single year {placebo.max} %).{/if}
    </p>

    <div class="charts" bind:clientWidth={width} class:stacked>
      {#each series as s (s.id)}
        <figure class="panel" style:width={`${panelW}px`}>
          <figcaption class="pt"><strong>{s.title}</strong> <span class="muted">{s.pass}, observed ÷ expected</span></figcaption>
          <svg width={panelW} height={H} role="img"
            aria-label={`${s.title}, observed over expected detections by year, ${where}. ${headYear}: day ${fmtRow(at(s.day, headYear))}, night ${fmtRow(at(s.night, headYear))}. Placebo years ${ref[0]}–${ref[1]} near 1.`}
            onpointermove={(e) => onMove(e, s.id)} onpointerleave={() => (hover = null)}>
            <rect class="placebo" x={Math.max(M.l, x(ref[0] - 0.5))} y={M.t - 14} width={x(ref[1] + 0.5) - Math.max(M.l, x(ref[0] - 0.5))} height={H - M.b - M.t + 14} />
            <text class="pl" x={Math.max(M.l, x(ref[0] - 0.5)) + 4} y={M.t - 3}>before the drift (placebo)</text>
            {#each yTicks as v (v)}
              <line class="grid" class:one={v === 1} x1={M.l} x2={panelW - M.r} y1={y(v)} y2={y(v)} />
              <text class="tk" x={M.l - 6} y={y(v)} dy="0.32em" text-anchor="end">{v}</text>
            {/each}
            {#each niceTicks(years[0], years[years.length - 1], stacked || panelW < 320 ? 3 : 4) as yr (yr)}
              <text class="tk" x={x(yr)} y={H - 6} text-anchor="middle">{yr}</text>
            {/each}
            <path class="band" d={band(s.day)} />
            <path class="band night" d={band(s.night)} />
            <path class="ln" d={line(s.day)} />
            <path class="ln night" d={line(s.night)} />
            {#each [s.day, s.night] as list, li (li)}
              {@const h = at(list, headYear)}
              {@const p = partial ? at(list, partial.year) : null}
              {#if p}<circle class="pt-partial" cx={x(p.year)} cy={y(p.ratio)} r="3.5" />{/if}
              {#if h}
                <circle class="pt-head" cx={x(h.year)} cy={y(h.ratio)} r="4" />
                <text class="val" x={x(h.year) - 7} y={y(h.ratio) + (h.ratio < 1 ? 15 : -7)} text-anchor="end">{f2(h.ratio)}</text>
              {/if}
            {/each}
            {#each endLabels(s.day, s.night) as l (l.text)}
              <text class="end" x={l.x} y={l.y} dy="0.32em">{l.text}</text>
            {/each}
            {#if hover?.sat === s.id}<line class="cross" x1={hover.px} x2={hover.px} y1={M.t} y2={H - M.b} />{/if}
          </svg>
          {#if hover?.sat === s.id}
            <div class="tip" style:left={`${Math.max(0, hover.px + 236 > panelW ? hover.px - 236 : hover.px + 10)}px`}>
              <p class="tt">{s.title}, {hover.year}{hover.year >= ref[0] && hover.year <= ref[1] ? ' · placebo' : ''}{partial && hover.year === partial.year ? ` · ${partial.months} months` : ''}</p>
              <p>Day <span class="num">{fmtRow(at(s.day, hover.year))}</span></p>
              <p>Night <span class="num">{fmtRow(at(s.night, hover.year))}</span></p>
            </div>
          {/if}
        </figure>
      {/each}
    </div>

    <figure class="shift">
      <figcaption class="pt"><strong>Overpass time</strong> <span class="muted">hours earlier (−) or later (+) than {ref[0]}–{ref[1]}, daytime, all land</span></figcaption>
      <svg width={width} height={OH} role="img" aria-label={`Overpass time shift by year. ${shifts.map((s) => `${s.label} ${headYear}: ${(shiftAt(s.sat, headYear) ?? 0).toFixed(2)} h`).join('; ')}.`}>
        <rect class="placebo" x={Math.max(OM.l, ox(ref[0] - 0.5))} y={OM.t} width={ox(ref[1] + 0.5) - Math.max(OM.l, ox(ref[0] - 0.5))} height={OH - OM.b - OM.t} />
        {#each niceTicks(oDom[0], oDom[1], 4) as v (v)}
          <line class="grid" class:one={v === 0} x1={OM.l} x2={width - OM.r} y1={oy(v)} y2={oy(v)} />
          <text class="tk" x={OM.l - 6} y={oy(v)} dy="0.32em" text-anchor="end">{v > 0 ? `+${v}` : v < 0 ? `−${-v}` : v}</text>
        {/each}
        {#each niceTicks(years[0], years[years.length - 1], width < 480 ? 3 : 6) as yr (yr)}
          <text class="tk" x={ox(yr)} y={OH - 6} text-anchor="middle">{yr}</text>
        {/each}
        {#each shifts as sh (sh.sat)}
          <path class="ln thin {sh.cls}" d={linePath(sh.list.map((r) => [ox(r.year), oy(r.shift_h)]))} />
        {/each}
        {#each shiftLabels as l (l.label)}
          <text class="end" x={width - OM.r + 8} y={l.y} dy="0.32em">{l.label}</text>
        {/each}
        {#if terraShift != null}
          <circle class="pt-head" cx={ox(headYear)} cy={oy(terraShift)} r="4" />
          <text class="val" x={ox(headYear) - 8} y={oy(terraShift) + (terraShift < 0 ? (oy(terraShift) + 15 < OH - OM.b - 2 ? 15 : 5) : -8)} text-anchor="end">{terraShift > 0 ? '+' : '−'}{Math.abs(terraShift).toFixed(1)} h</text>
        {/if}
      </svg>
    </figure>

    <div class="foot">
      <ul class="keys" aria-label="Legend">
        <li><span class="sw day"></span>day detections</li>
        <li><span class="sw night"></span>night detections</li>
        <li><span class="sw band"></span>95 % interval</li>
        <li><span class="sw hollow"></span>{partial ? `${partial.year}, ${partial.months} months` : 'partial year'}</li>
      </ul>
      <button class="btn small" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Hide table' : 'View as table'}</button>
    </div>

    {#if showTable}
      <div class="tw">
        <table class="dt">
          <caption class="small muted">Observed ÷ expected detections (95 % interval), {where}; overpass shift in hours, all land, daytime.</caption>
          <thead><tr><th scope="col">Year</th><th scope="col">Terra day</th><th scope="col">Terra night</th><th scope="col">Aqua day</th><th scope="col">Aqua night</th><th scope="col">Terra shift</th><th scope="col">Aqua shift</th></tr></thead>
          <tbody>
            {#each years as yr (yr)}
              <tr class:placebo-row={yr >= ref[0] && yr <= ref[1]}>
                <th scope="row">{yr}{yr >= ref[0] && yr <= ref[1] ? ' (placebo)' : ''}{partial && yr === partial.year ? ` (${partial.months} mo)` : ''}</th>
                <td class="num">{fmtRow(at(series[0].day, yr))}</td><td class="num">{fmtRow(at(series[0].night, yr))}</td>
                <td class="num">{fmtRow(at(series[1].day, yr))}</td><td class="num">{fmtRow(at(series[1].night, yr))}</td>
                <td class="num">{shiftAt('Terra', yr)?.toFixed(2) ?? '—'}</td><td class="num">{shiftAt('Aqua', yr)?.toFixed(2) ?? '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <p class="limit"><strong>What this cannot separate.</strong> A real change in the hour fires burn (crop-residue burning moved earlier or later in the day, say), a change in fire sizes, or a change on the VIIRS side would look the same as drift. The fused record divides MODIS by the whole ratio and counts half of that correction as uncertain, so MODIS weighs less as the drift grows.</p>
    {#if blindLine}
      <p class="evidence"><strong>Independent check.</strong> NOAA-21 never entered any calibration fit. On its own it lands within <span class="num">{blindLine.n20.toFixed(1)} %</span> of calibrated NOAA-20 in every year {blindLine.y0}–{blindLine.y1}, yet runs {blindLine.late.join(' and ')} against raw MODIS: the drift, seen by a satellite the calibration never used. Against drift-corrected MODIS it is within <span class="num">{blindLine.dc.toFixed(1)} %</span> (a consistency check, not proof: the correction itself uses the VIIRS composite).</p>
    {/if}
  </section>
{/if}

<style>
  .ev { padding: 22px 0 24px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
  .where { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--ink-2); }
  .where select { max-width: 260px; }
  .scope { margin: 4px 0 0; }
  .take { font-size: var(--fs-lg); line-height: 1.45; max-width: var(--measure); margin: 10px 0 6px; }
  .body, .limit, .evidence { color: var(--ink-2); max-width: var(--measure); margin: 8px 0 0; }
  .limit strong, .evidence strong { color: var(--ink); }
  .charts { display: flex; gap: 28px; margin-top: 14px; }
  .charts.stacked { flex-direction: column; gap: 10px; }
  figure { margin: 0; position: relative; }
  .pt { font-size: var(--fs-sm); margin-bottom: 2px; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .placebo { fill: var(--surface-2); }
  .pl, .tk, .end, .val { font-size: var(--fs-xs); fill: var(--ink-3); }
  .pl, .end { font-family: var(--font-ui); }
  .tk, .val { font-family: var(--font-num); }
  .end { fill: var(--ink-2); }
  .val { fill: var(--ink); font-weight: 600; }
  .val, .end { paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round; }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .grid.one { stroke: var(--ink-3); }
  .band { fill: color-mix(in srgb, var(--s-modis) 24%, transparent); }
  .band.night { fill: color-mix(in srgb, var(--s-modis) 12%, transparent); }
  .ln { fill: none; stroke: var(--s-modis); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .ln.night { stroke-dasharray: 5 3; }
  .ln.thin { stroke-width: 2; }
  .ln.viirs { stroke: var(--s-viirs); }
  .pt-head { fill: var(--s-modis); stroke: var(--surface); stroke-width: 2; }
  .pt-partial { fill: var(--surface); stroke: var(--s-modis); stroke-width: 1.5; }
  .cross { stroke: var(--ink-3); stroke-width: 1; }
  .shift { margin-top: 16px; }
  .tip {
    position: absolute; top: 30px; pointer-events: none; z-index: 5; width: 226px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: var(--fs-sm);
  }
  .tip p { margin: 0; display: flex; gap: 10px; justify-content: space-between; white-space: nowrap; }
  .tt { font-weight: 600; margin-bottom: 3px !important; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--s-modis); flex: none; }
  .sw.night { border-top-style: dashed; }
  .sw.band { height: 9px; border: 0; background: color-mix(in srgb, var(--s-modis) 24%, transparent); }
  .sw.hollow { width: 8px; height: 8px; border: 1.5px solid var(--s-modis); border-radius: 50%; }
  .tw { overflow-x: auto; margin-top: 10px; }
  .dt { border-collapse: collapse; font-size: var(--fs-sm); min-width: 560px; }
  .dt th, .dt td { padding: 3px 8px; border-bottom: 1px solid var(--rule); text-align: right; font-weight: 400; white-space: nowrap; }
  .dt th[scope='row'], .dt thead th:first-child { text-align: left; }
  .dt thead th { color: var(--ink-3); }
  .placebo-row { background: var(--surface-2); }
  .small { font-size: var(--fs-sm); }
</style>
