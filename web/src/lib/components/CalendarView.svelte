<script lang="ts">
  import { tick } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { activityDomain, activityInverse, activityT, divColor, inkOn, percentileT, rangeHalfPct, ratioT, seqColor, uncertaintyClass, vsupColor, UNC_WORD, type UncClass } from '../color'
  import { MONTHS_LONG, MONTHS_SHORT, fmtCell, fmtNum, fmtRatio, ordinal, toM, yearOf } from '../format'
  import { inProgressDays, inProgressOf, isSparse, monthSource, monthStats, onPace, seasonOneMonth, seasonUndefined, seriesIndex, viirsMark, type MonthSource } from '../analysisUtil'
  import type { CalMode } from '../urlState'
  import type { Snippet } from 'svelte'
  import AnalysisSettings from './AnalysisSettings.svelte'
  import Term from './Term.svelte'
  import { HINT_KEY } from './livePace'
  import UncertaintyLegend from './UncertaintyLegend.svelte'
  import { listen } from '../sound/listen.svelte'

  let {
    a,
    tools,
    units,
  }: {
    a: Analysis
    /** Insertion point: extra header tools next to the mode switch (e.g. a "Listen" sonification button). */
    tools?: Snippet
    /** Insertion point passed through to the settings popover (units lens). */
    units?: Snippet
  } = $props()

  /** Calendar colour modes shown in the header. Append here to add a mode (e.g. 'uncertainty'). */
  const MODES: { v: CalMode; label: string }[] = [
    { v: 'activity', label: 'Activity' },
    { v: 'anomaly', label: 'Compared with normal' },
    { v: 'percentile', label: 'Percentile among baseline years' },
    { v: 'uncertainty', label: 'Activity with confidence' },
  ]
  const sparse = $derived(isSparse(a))
  const ip = $derived(inProgressOf(a))
  const ipDays = $derived(ip ? inProgressDays(ip, session.meta) : null)
  const lead = $derived.by(() => {
    const se = a.season
    if (sparse) return 'Too little fire here to describe a season: the calendar shows what was detected, without ranks.'
    const top = a.records.topYears[0]
    const when = seasonUndefined(a) ? '' : se.lengthMonths >= 12
      ? `Fires occur all year here, most in ${MONTHS_LONG[se.peakMonth - 1]}.`
      : seasonOneMonth(a)
        ? `Most burning here happens in ${MONTHS_LONG[se.peakMonth - 1]}.`
        : `Most burning here happens from ${MONTHS_LONG[se.startMonth - 1]} to ${MONTHS_LONG[se.endMonth - 1]}, peaking in ${MONTHS_LONG[se.peakMonth - 1]}.`
    return [when, top ? `The most active year was ${top.year}.` : ''].filter(Boolean).join(' ')
  })

  let showNumbers = $state(false)
  let showTable = $state(false)
  let activeR = $state(0)
  let activeC = $state(0)
  let tip = $state<{ r: number; c: number; x: number; y: number; below: boolean } | null>(null)
  let gridEl: HTMLDivElement | undefined = $state()
  let wrapEl: HTMLDivElement | undefined = $state()

  const mode = $derived(session.calMode)
  const modeLabel = $derived(MODES.find((x) => x.v === mode)?.label ?? mode)
  const theme = $derived(themeState.theme)
  // Rows: latest year on top, limited to "Years shown" (the kernel's statistics still use the whole record).
  const shownYears = $derived.by<[number, number]>(() => {
    const r = session.options.range
    return [yearOf(r[0]), yearOf(r[1])]
  })
  const rows = $derived(
    a.calendar.years.map((y, i) => ({ y, i })).filter(({ y }) => y >= shownYears[0] && y <= shownYears[1]).reverse(),
  )
  const dom = $derived(activityDomain([...a.calendar.value.flat(), ...a.climatology.median]))
  const maxTotal = $derived(Math.max(1, ...a.annual.total.map((t) => t ?? 0)))
  const switchMode = $derived((a.harmonization?.mode ?? 'switch') === 'switch')
  const switchYear = $derived(Math.floor(session.effectiveSwitchM / 12) + 2000)
  const focusM = $derived(session.focus)

  type Cell = {
    m: number; v: number | null; fill: string; ink: string; label: string; src: MonthSource; vmark: boolean; prov: boolean; partial: boolean
    /** The month in progress: hatched, labelled, never compared with normal or ranked. */
    ip: boolean
    empty: boolean
    lo: number | null; hi: number | null; u: UncClass
  }

  function colorFor(v: number | null, ratio: number | null, pct: number | null, u: UncClass): string | null {
    if (v == null) return null
    if (mode === 'activity') return seqColor(activityT(v, dom), theme)
    if (mode === 'uncertainty') return vsupColor(activityT(v, dom), u, theme)
    if (mode === 'anomaly') return ratio == null ? (v > 0 ? divColor(1, theme) : divColor(0, theme)) : divColor(ratioT(ratio), theme)
    return pct == null ? divColor(0, theme) : divColor(percentileT(pct), theme)
  }
  function labelFor(v: number | null, ratio: number | null, pct: number | null): string {
    if (v == null) return ''
    if (mode === 'activity' || mode === 'uncertainty') return fmtCell(v)
    if (mode === 'anomaly') return ratio == null ? '—' : ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1)
    return pct == null ? '' : String(Math.round(pct))
  }

  const grid = $derived<Cell[][]>(
    rows.map(({ y, i }) =>
      Array.from({ length: 12 }, (_, c) => {
        const m = toM(y, c + 1)
        const inProg = ip?.m === m && a.calendar.value[i][c] != null
        // No ratio or percentile is shown for the month in progress, nor percentiles where fire is too sparse to rank.
        const v = a.calendar.value[i][c]
        const ratio = inProg ? null : a.calendar.ratio[i][c]
        const pct = inProg || sparse ? null : a.calendar.percentile[i][c]
        const si = seriesIndex(a, m)
        const prov = si >= 0 ? a.series.provisional[si] : false
        const partial = inProg || (si >= 0 && v != null ? (a.series.partial?.[si] ?? false) : false)
        const lo = si >= 0 ? (a.series.lo80?.[si] ?? null) : null, hi = si >= 0 ? (a.series.hi80?.[si] ?? null) : null
        const u = uncertaintyClass(lo, hi, prov, partial)
        const fill = inProg && mode !== 'activity' && mode !== 'uncertainty' ? (v == null ? null : divColor(0, theme)) : colorFor(v, ratio, pct, u)
        const src = monthSource(a, si)
        return {
          m, v, fill: fill ?? 'transparent', ink: fill ? inkOn(fill) : 'var(--ink-3)',
          label: inProg && mode !== 'activity' && mode !== 'uncertainty' ? '' : labelFor(v, ratio, pct),
          src, vmark: viirsMark(src), prov, partial, ip: inProg, empty: v == null, lo, hi, u,
        }
      }),
    ),
  )
  const medianRow = $derived(
    a.climatology.median.map((v) => {
      const act = mode === 'activity' || mode === 'uncertainty'
      const fill = act ? seqColor(activityT(v, dom), theme) : divColor(0, theme)
      return { v, fill, ink: inkOn(fill), label: act ? fmtCell(v) : mode === 'anomaly' ? '1.0' : '50' }
    }),
  )

  function ariaFor(cell: Cell): string {
    const name = `${MONTHS_LONG[(cell.m % 12)]} ${Math.floor(cell.m / 12) + 2000}`
    if (cell.empty) return `${name}: outside the record`
    const s = monthStats(a, cell.m)
    if (!s) return name
    if (cell.ip) {
      return `${name}: in progress${ipDays != null ? `, first ${ipDays} days` : ''}, ${fmtNum(s.value)} ${session.unitLabel} so far${onPace(ip) ? ` (${onPace(ip)})` : ''}; not compared with normal or ranked until complete; ${cell.src.label}`
    }
    const parts = [`${name}: ${fmtNum(s.value)} ${session.unitLabel}`]
    if (mode === 'uncertainty') {
      parts.push(cell.lo != null && cell.hi != null ? `likely range ${fmtNum(cell.lo)} to ${fmtNum(cell.hi)}` : 'no modelled range')
      parts.push(`${UNC_WORD[cell.u]} confidence`)
    }
    if (s.ratio != null && !sparse) parts.push(`${fmtRatio(s.ratio)} the normal`)
    if (s.percentile != null && !sparse) parts.push(`${ordinal(Math.round(s.percentile))} percentile`)
    parts.push(cell.src.label)
    if (cell.prov) parts.push('provisional')
    if (cell.partial) parts.push('partial month')
    return parts.join(', ')
  }

  // ---- interaction ----
  function showTip(r: number, c: number, el: HTMLElement) {
    if (!wrapEl) return
    const wr = wrapEl.getBoundingClientRect(), cr = el.getBoundingClientRect()
    const below = cr.top - wr.top < 150
    tip = { r, c, x: cr.left - wr.left + cr.width / 2, y: below ? cr.bottom - wr.top + 6 : cr.top - wr.top - 6, below }
  }
  function select(r: number, c: number) {
    const cell = grid[r]?.[c]
    if (!cell || cell.empty) return
    activeR = r; activeC = c
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode */ }
    session.setFocus(cell.m)
  }
  async function move(r: number, c: number) {
    activeR = Math.max(0, Math.min(rows.length - 1, r))
    activeC = Math.max(0, Math.min(11, c))
    await tick()
    const el = gridEl?.querySelector<HTMLElement>(`[data-r="${activeR}"][data-c="${activeC}"]`)
    el?.focus()
  }
  function onKey(e: KeyboardEvent) {
    const k = e.key
    let r = activeR, c = activeC
    if (k === 'ArrowRight') c++
    else if (k === 'ArrowLeft') c--
    else if (k === 'ArrowDown') r++
    else if (k === 'ArrowUp') r--
    else if (k === 'Home') c = e.ctrlKey ? (r = 0, 0) : 0
    else if (k === 'End') c = e.ctrlKey ? (r = rows.length - 1, 11) : 11
    else if (k === 'PageUp') r = 0
    else if (k === 'PageDown') r = rows.length - 1
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); select(activeR, activeC); return }
    else if (k === 'Escape') { tip = null; return }
    else return
    e.preventDefault()
    move(r, c)
  }

  // Keep the roving tabindex on the focused month when it changes elsewhere.
  $effect(() => {
    const f = focusM
    if (f == null) return
    const r = rows.findIndex((row) => row.y === Math.floor(f / 12) + 2000)
    if (r >= 0) { activeR = r; activeC = f % 12 }
  })

  const markYears = (pred: (c: Cell) => boolean) => {
    const ys = grid.flatMap((row, r) => (row.some((c) => !c.empty && pred(c)) ? [rows[r].y] : []))
    return ys.length ? [Math.min(...ys), Math.max(...ys)] : null
  }
  const terraYears = $derived(markYears((c) => c.src.era === 'terra'))
  const viirsYears = $derived(markYears((c) => c.vmark))
  const fusedYears = $derived(markYears((c) => c.src.era === 'fused'))
  const span = (r: number[] | null) => (r ? (r[0] === r[1] ? String(r[0]) : `${r[0]}–${r[1]}`) : '')

  const tipStats = $derived(tip ? monthStats(a, grid[tip.r]?.[tip.c]?.m ?? -1) : null)
  const tipCell = $derived(tip ? grid[tip.r]?.[tip.c] : null)

  const legendStops = $derived(
    Array.from({ length: 24 }, (_, i) => (mode === 'activity' ? seqColor(i / 23, theme) : divColor((i / 23) * 2 - 1, theme))).join(','),
  )
  const legendTicks = $derived(
    mode === 'activity'
      ? ['0', ...[0.25, 0.5, 0.75, 1].map((t) => fmtNum(activityInverse(t, dom)))]
      : mode === 'anomaly' ? ['⅛×', '¼×', '1×', '4×', '8×'] : ['0', '25', '50', '75', '100'],
  )
  const legendCaption = $derived(
    mode === 'activity' ? `${session.unitLabel} per month (log scale)` : mode === 'anomaly' ? 'Ratio to the baseline median of the same month (log₂)' : 'Percentile among baseline years for the same month',
  )
</script>

<section class="cal-section" id="when" aria-labelledby="cal-h">
  <div class="head">
    <h2 id="cal-h" class="q-title">When does it burn?</h2>
    <div class="opts">
      <label class="mode">Colour by
        <select name="calendar-mode" value={mode} onchange={(e) => session.setCalMode((e.currentTarget as HTMLSelectElement).value as CalMode)}>
          {#each MODES as md (md.v)}<option value={md.v}>{md.label}</option>{/each}
        </select>
      </label>
      {#if tools}{@render tools()}{/if}
      <AnalysisSettings {units} />
    </div>
  </div>
  <p class="lead">{lead}</p>

  {#if !showTable}
    <div class="wrap" bind:this={wrapEl}>
      {#key `${session.aoi?.label}|${a.calendar.years[0]}`}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div
          class="grid"
          class:nums={showNumbers}
          role="grid"
          aria-label={`Burning calendar, coloured by ${modeLabel.toLowerCase()}. Rows are years, latest first; columns are months. Use arrow keys to move and Enter to show a month on the map.`}
          aria-rowcount={rows.length + 2}
          bind:this={gridEl}
          onkeydown={onKey}
          onmouseleave={() => (tip = null)}
        >
          <div class="row header" role="row">
            <span class="yl" role="columnheader"><span class="sr-only">Year</span></span>
            {#each MONTHS_SHORT as mo, c (c)}
              <span class="mh" role="columnheader" aria-label={MONTHS_LONG[c]}><span class="full">{mo}</span><span class="ini" aria-hidden="true">{mo[0]}</span></span>
            {/each}
            <span class="ah" role="columnheader">Year total</span>
          </div>
          {#each rows as row, r (row.y)}
            {@const ai = a.annual.years.indexOf(row.y)}
            {@const total = ai >= 0 ? a.annual.total[ai] : null}
            {@const complete = ai >= 0 ? a.annual.complete[ai] : false}
            {@const rank = ai >= 0 ? a.annual.rank[ai] : null}
            <div class="row" role="row" class:switch={switchMode && row.y === switchYear} style:--d={`${r * 14}ms`}>
              <span class="yl num" role="rowheader">{row.y}</span>
              {#each grid[r] as cell, c (c)}
                <!-- keyboard is handled on the grid (roving tabindex) -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="cal-cell"
                  class:empty={cell.empty}
                  class:prov={cell.prov || cell.partial}
                  class:ip={cell.ip}
                  class:u1={mode === 'uncertainty' && !cell.empty && cell.u === 1}
                  class:u2={mode === 'uncertainty' && !cell.empty && cell.u === 2}
                  class:u3={mode === 'uncertainty' && !cell.empty && cell.u === 3}
                  class:playing={listen.m === cell.m}
                  class:current={cell.m === a.current.m}
                  class:focus={cell.m === focusM}
                  role="gridcell"
                  tabindex={r === activeR && c === activeC ? 0 : -1}
                  data-r={r}
                  data-c={c}
                  aria-label={ariaFor(cell)}
                  aria-selected={cell.m === focusM}
                  style:background={cell.fill}
                  style:color={cell.ink}
                  onclick={() => select(r, c)}
                  onmouseenter={(e) => showTip(r, c, e.currentTarget)}
                  onfocus={(e) => { activeR = r; activeC = c; showTip(r, c, e.currentTarget) }}
                  onblur={() => (tip = null)}
                >
                  {#if cell.src.era === 'terra' && !cell.empty}<span class="mk terra" aria-hidden="true"></span>{/if}
                  {#if cell.vmark && !cell.empty}<span class="mk viirs" aria-hidden="true"></span>{/if}
                  {#if showNumbers && !cell.empty}<span class="n num" aria-hidden="true">{cell.label}</span>{/if}
                </div>
              {/each}
              <span class="ann" role="gridcell" aria-label={total == null ? `${row.y}: no data` : `${row.y} total ${fmtNum(total)} ${session.unitLabel}${complete ? (rank && !sparse ? `, rank ${rank}` : '') : ', incomplete year'}`}>
                {#if total != null}
                  <span class="bar" class:partial={!complete} style:width={`${(72 * total) / maxTotal}%`}></span>
                  {#if complete && !sparse && rank != null && rank <= 3}<span class="rk num" aria-hidden="true">#{rank}</span>{/if}
                  {#if !complete}<span class="rk partial-l" aria-hidden="true">{ip && yearOf(ip.m) === row.y ? 'in progress' : 'partial'}</span>{/if}
                {/if}
              </span>
            </div>
          {/each}
          <div class="row median" role="row">
            <span class="yl" role="rowheader">Normal</span>
            {#each medianRow as cell, c (c)}
              <span class="cal-cell med" role="gridcell" style:background={cell.fill} style:color={cell.ink}
                aria-label={`${MONTHS_LONG[c]} normal (baseline median): ${fmtNum(cell.v)} ${session.unitLabel}`}>
                {#if showNumbers}<span class="n num" aria-hidden="true">{cell.label}</span>{/if}
              </span>
            {/each}
            <span class="ann bl small muted" role="gridcell">{session.effectiveBaseline.join('–')}</span>
          </div>
        </div>
      {/key}

      {#if tip && tipStats && tipCell && !tipCell.empty}
        <div class="tip" class:below={tip.below} style:left={`${tip.x}px`} style:top={`${tip.y}px`} role="tooltip">
          <p class="tt">{MONTHS_LONG[tipStats.month - 1]} {tipStats.year}{tipCell.ip ? ' · in progress' : tipCell.partial ? ' · partial month' : tipStats.provisional ? ' · provisional' : ''}</p>
          {#if tipCell.ip}
          <dl>
            <dt>So far</dt><dd class="num">{fmtNum(tipStats.value)} {session.unitLabel}</dd>
            {#if ipDays != null}<dt>Days observed</dt><dd class="num">{ipDays}</dd>{/if}
            {#if ip?.projected != null}<dt>On pace for</dt><dd class="num">about {fmtNum(ip.projected)}</dd>{/if}
            <dt>Source</dt><dd>{tipCell.src.label}</dd>
          </dl>
          <p class="tnote">Compared with normal and ranked once the month is complete.</p>
          {:else}
          <dl>
            <dt>Activity</dt><dd class="num">{fmtNum(tipStats.value)} {session.unitLabel}</dd>
            {#if tipStats.value === 0 && !tipStats.hi80}<dt>Likely range</dt><dd>no detections</dd>
            {:else if tipStats.lo80 != null && tipStats.hi80 != null}<dt>Likely range</dt><dd class="num">{fmtNum(tipStats.lo80)} – {fmtNum(tipStats.hi80)}</dd>{/if}
            {#if mode === 'uncertainty'}<dt>Confidence</dt><dd>{UNC_WORD[tipCell.u]}{tipCell.lo != null && tipCell.hi != null ? ` (${rangeHalfPct(tipCell.lo, tipCell.hi)})` : ''}</dd>{/if}
            {#if !sparse}
              <dt>Normal</dt><dd class="num">{fmtNum(tipStats.median)}</dd>
              <dt>vs normal</dt><dd class="num">{tipStats.ratio == null ? '—' : fmtRatio(tipStats.ratio)}</dd>
              <dt>Percentile</dt><dd class="num">{tipStats.percentile == null ? '—' : ordinal(Math.round(tipStats.percentile))}</dd>
              {#if tipStats.rank != null}<dt>Rank</dt><dd class="num">{ordinal(tipStats.rank)} of {tipStats.of}</dd>{/if}
            {/if}
            <dt>Source</dt><dd>{tipCell.src.label}</dd>
          </dl>
          {/if}
        </div>
      {/if}
    </div>

    <div class="legend">
      {#if mode === 'uncertainty'}
        <UncertaintyLegend {dom} {theme} />
      {:else}
      <div class="ramp">
        <div class="bar" style:background={`linear-gradient(90deg, ${legendStops})`}></div>
        <div class="ticks num">{#each legendTicks as t, i (i)}<span>{t}</span>{/each}</div>
        <p class="cap">
          {#if mode === 'activity'}<Term id="afcdm" /> per month (log scale)
          {:else if mode === 'anomaly'}Ratio to the <Term id="normal">normal</Term> for the same month (log scale)
          {:else}<Term id="percentile" /> among the years that define normal{/if}
        </p>
      </div>
      {/if}
      <div class="opts2">
        <label class="chk"><input type="checkbox" name="cell-numbers" bind:checked={showNumbers} /> Show numbers</label>
        <button class="btn" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>View as table</button>
      </div>
    </div>
    <details class="more">
      <summary>Reading the calendar</summary>
      <div class="more-body">
        <p>Each row is a year, newest at the top; each cell is one month. Click a month to show it on the map and in the answer above. The bar on the right is the year’s total.</p>
        <ul class="keys">
          <li><span class="sw cur-sw"></span>Latest month</li>
          <li><span class="sw focus-sw"></span>Shown on the map</li>
          <li><span class="sw prov-sw"></span><span><Term id="provisional">Provisional</Term>, partial or in-progress month{ip ? ` (${MONTHS_SHORT[ip.m % 12]} ${yearOf(ip.m)} is in progress)` : ''}</span></li>
          {#if terraYears}<li title="Terra-only estimate scaled to Terra and Aqua together. The early-2000s Terra record cannot be checked against a second sensor."><span class="sw terra-sw"><span class="mk terra"></span></span>Terra only, bridged ({span(terraYears)})</li>{/if}
          {#if viirsYears}<li><span class="sw viirs-sw"><span class="mk viirs"></span></span>{switchMode ? `VIIRS only, calibrated (${span(viirsYears)})` : `VIIRS carries most of the value (${span(viirsYears)})`}</li>{/if}
        </ul>
        {#if !switchMode && fusedYears}
          <p>Unmarked cells from {fusedYears[0]} fuse MODIS and VIIRS, weighted by how reliable each is there; the tooltip gives each month’s MODIS share.</p>
        {/if}
        <p>Source marks never change the colours: every cell is in the same <Term id="modiseq">MODIS-equivalent</Term> unit.</p>
      </div>
    </details>
  {:else if mode === 'uncertainty'}
    <div class="table-wrap">
      <table class="cal-table long">
        <caption class="small muted"><button class="btn back" onclick={() => (showTable = false)}>View as calendar</button> Harmonized activity by month ({session.unitLabel}) with the likely range (80 %) and confidence, newest first; * provisional{ip ? '; † in progress' : ''}</caption>
        <thead>
          <tr><th scope="col">Month</th><th scope="col">Activity</th><th scope="col">Likely range, low</th><th scope="col">Likely range, high</th><th scope="col">Confidence</th><th scope="col">Source</th></tr>
        </thead>
        <tbody>
          {#each grid as rowCells, r (rows[r].y)}
            {#each [...rowCells].reverse() as cell (cell.m)}
              {#if !cell.empty}
                <tr>
                  <th scope="row" class="num">{MONTHS_SHORT[cell.m % 12]} {rows[r].y}{cell.ip ? '†' : cell.prov ? '*' : ''}</th>
                  <td class="num">{fmtNum(cell.v)}</td>
                  <td class="num">{cell.lo == null ? '—' : fmtNum(cell.lo)}</td>
                  <td class="num">{cell.hi == null ? '—' : fmtNum(cell.hi)}</td>
                  <td class="conf">{UNC_WORD[cell.u]}{cell.ip ? ' (in progress)' : cell.partial ? ' (partial month)' : ''}</td>
                  <td class="conf">{cell.src.short}</td>
                </tr>
              {/if}
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="cal-table">
        <caption class="small muted"><button class="btn back" onclick={() => (showTable = false)}>View as calendar</button> Harmonized activity by month ({mode === 'activity' ? session.unitLabel : mode === 'anomaly' ? 'ratio to median' : 'percentile'}); * provisional{ip ? '; † in progress, not compared or ranked' : ''}</caption>
        <thead>
          <tr><th scope="col">Year</th>{#each MONTHS_SHORT as mo (mo)}<th scope="col">{mo}</th>{/each}<th scope="col">Total</th></tr>
        </thead>
        <tbody>
          {#each rows as row, r (row.y)}
            {@const ai = a.annual.years.indexOf(row.y)}
            <tr>
              <th scope="row" class="num">{row.y}</th>
              {#each grid[r] as cell (cell.m)}
                <td class="num">{cell.empty ? '' : mode === 'activity' || cell.ip ? fmtNum(cell.v) : cell.label}{cell.empty ? '' : cell.ip ? '†' : cell.prov ? '*' : ''}</td>
              {/each}
              <td class="num">{ai >= 0 ? fmtNum(a.annual.total[ai]) : ''}{ai >= 0 && !a.annual.complete[ai] ? ' (partial)' : ''}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr><th scope="row">Median</th>{#each a.climatology.median as v, i (i)}<td class="num">{fmtNum(v)}</td>{/each}<td></td></tr>
        </tfoot>
      </table>
    </div>
  {/if}
</section>

<style>
  .cal-section { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 10px 12px; flex-wrap: wrap; }
  .opts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .mode { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--ink-3); }
  .mode select { min-height: 34px; font-size: var(--fs-sm); color: var(--ink); }
  /* Phone: the three controls share one row under the title (Colour by takes the slack, Listen keeps its label, the
     settings button shows its gear and keeps its name for screen readers). The popovers anchor to the row, not to
     their small cells, so they open at full width. */
  @media (max-width: 600px) {
    .head { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .opts { position: relative; display: flex; flex-wrap: nowrap; gap: 8px; width: 100%; }
    .mode { flex: 1; min-width: 0; }
    .mode select { flex: 1; min-width: 0; }
    .opts :global(.settings), .opts :global(.listen) { position: static; flex: none; }
    .opts :global(.settings .lbl) {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap;
    }
    .opts :global(.settings > .btn) { padding-inline: 0.65em; }
    .opts :global(.panel) { left: 0; right: 0; width: auto; }
  }
  .opts2 { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .back { margin-right: 8px; }
  .chk { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
  .wrap { position: relative; container-type: inline-size; }
  .grid { display: grid; gap: 2px; }
  .row {
    display: grid; grid-template-columns: 3.1em repeat(12, minmax(0, 1fr)) minmax(56px, 16%);
    gap: 2px; align-items: stretch; animation: reveal 0.5s var(--ease) both; animation-delay: var(--d, 0ms);
  }
  @keyframes reveal { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  .row.header { animation: none; }
  .row.switch .cal-cell { box-shadow: 0 -2px 0 0 var(--bg), 0 -3px 0 0 var(--ink-3); }
  .yl { font-size: var(--fs-xs); color: var(--ink-3); align-self: center; text-align: right; padding-right: 6px; }
  .mh { font-size: var(--fs-xs); color: var(--ink-3); text-align: center; }
  .mh .ini { display: none; }
  .ah { font-size: var(--fs-xs); color: var(--ink-3); padding-left: 6px; white-space: nowrap; overflow: hidden; }
  .cal-cell {
    position: relative; height: 19px; border-radius: 2px; cursor: pointer; display: grid; place-items: center; overflow: hidden;
    outline-offset: 1px;
  }
  .nums .cal-cell { height: 22px; }
  .cal-cell.empty { cursor: default; box-shadow: inset 0 0 0 1px var(--rule); }
  .cal-cell:hover:not(.empty) { box-shadow: inset 0 0 0 1.5px var(--ink); }
  .cal-cell.prov::after {
    content: ''; position: absolute; inset: 0;
    background: repeating-linear-gradient(135deg, transparent 0 3px, var(--hatch) 3px 4.5px);
  }
  /* Uncertainty mode, second cue: a dot pattern that gets denser as confidence falls (never colour alone). */
  .cal-cell.u1::before, .cal-cell.u2::before, .cal-cell.u3::before {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(circle, currentColor 0.9px, transparent 1.3px);
  }
  .cal-cell.u1::before { background-size: 7px 7px; opacity: 0.45; }
  .cal-cell.u2::before { background-size: 4.5px 4.5px; opacity: 0.55; }
  .cal-cell.u3::before { background-size: 3px 3px; opacity: 0.6; }
  .cal-cell.current { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent); z-index: 1; }
  .cal-cell.focus { box-shadow: inset 0 0 0 2px var(--bg), 0 0 0 2px var(--ink); z-index: 2; }
  .cal-cell.focus.current { box-shadow: inset 0 0 0 2px var(--bg), 0 0 0 2px var(--ink), 0 0 0 4px var(--accent); }
  /* Listening: the month that is sounding (not shown with reduced motion). */
  .cal-cell.playing, .cal-cell.playing.focus, .cal-cell.playing.current { box-shadow: inset 0 0 0 2px var(--bg), 0 0 0 2px var(--focus); z-index: 4; }
  .cal-cell:focus-visible { outline: 2px solid var(--focus); z-index: 3; }
  .n { font-size: var(--fs-2xs); font-weight: 500; letter-spacing: -0.03em; position: relative; z-index: 1; }
  .mk { position: absolute; pointer-events: none; }
  .mk.terra { top: 3px; left: 3px; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.8; }
  .mk.viirs { top: 0; right: 0; width: 7px; height: 7px; background: currentColor; opacity: 0.55; clip-path: polygon(0 0, 100% 0, 100% 100%); }
  .row.median { margin-top: 6px; animation: none; }
  .row.median .yl { color: var(--ink-2); font-size: var(--fs-xs); }
  .med { cursor: default; height: 14px; }
  .nums .med { height: 20px; }
  .ann { position: relative; display: flex; align-items: center; gap: 4px; padding-left: 6px; min-width: 0; overflow: hidden; }
  .ann .bar { display: block; height: 8px; min-width: 1px; background: var(--ink-3); border-radius: 0 2px 2px 0; flex: none; }
  .ann .bar.partial { background: repeating-linear-gradient(135deg, var(--ink-3) 0 2px, transparent 2px 4px); box-shadow: inset 0 0 0 1px var(--ink-3); }
  .rk { font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
  .rk.partial-l { color: var(--ink-3); }
  .ann.bl { font-family: var(--font-num); font-size: var(--fs-xs); }

  @container (max-width: 520px) {
    .mh .full { display: none; }
    .mh .ini { display: inline; }
    .n { display: none; }
    /* Touch: every month cell is at least 24 x 24 CSS px (WCAG 2.5.8): narrower labels, 1 px gaps, taller cells. */
    .grid, .row { gap: 1px; }
    .row { grid-template-columns: 30px repeat(12, minmax(0, 1fr)) 22px; }
    .cal-cell, .nums .cal-cell { height: 24px; }
    .yl { padding-right: 3px; }
    .ann { padding-left: 3px; }
    .rk { display: none; }
    .ah { font-size: 0; }
  }

  .tip {
    position: absolute; z-index: 30; transform: translate(-50%, -100%); pointer-events: none;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 8px 10px; min-width: 210px; font-size: var(--fs-sm);
  }
  .tip.below { transform: translate(-50%, 0); }
  .tt { font-weight: 600; margin: 0 0 4px; font-size: var(--fs-md); }
  .tip dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; margin: 0; }
  .tip dt { color: var(--ink-3); }
  .tip dd { margin: 0; text-align: right; }
  .tnote { margin: 4px 0 0; color: var(--ink-3); max-width: 24ch; }

  .legend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 14px 28px; align-items: flex-start; margin-top: 14px; }
  .ramp { width: min(300px, 100%); }
  .ramp .bar { height: 10px; border-radius: 2px; }
  .ticks { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--ink-3); margin-top: 2px; }
  .cap { font-size: var(--fs-sm); color: var(--ink-2); margin: 4px 0 0; }
  .keys { list-style: none; margin: 8px 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 18px; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 8px; }
  .sw { position: relative; width: 18px; height: 12px; border-radius: 2px; background: var(--surface-3); color: var(--ink); flex: none; }
  .prov-sw { background: repeating-linear-gradient(135deg, var(--surface-3) 0 3px, var(--hatch) 3px 4.5px); }
  .cur-sw { background: transparent; box-shadow: inset 0 0 0 2px var(--accent); }
  .focus-sw { background: transparent; box-shadow: inset 0 0 0 2px var(--ink); }

  .table-wrap { overflow-x: auto; max-height: 560px; overflow-y: auto; border-top: 1px solid var(--rule); }
  .cal-table { width: 100%; font-size: var(--fs-sm); }
  .cal-table caption { text-align: left; padding: 6px 0; caption-side: top; }
  .cal-table th, .cal-table td { padding: 3px 6px; text-align: right; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  .cal-table thead th { position: sticky; top: 0; background: var(--bg); color: var(--ink-3); font-weight: 500; }
  .cal-table th[scope='row'] { color: var(--ink-2); font-weight: 500; }
  .cal-table.long td.conf { text-align: left; font-family: var(--font-ui); color: var(--ink-2); }
</style>
