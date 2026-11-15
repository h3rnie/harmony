<script lang="ts">
  import { tick } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { activityDomain, activityInverse, activityT, divColor, inkOn, percentileT, ratioT, seqColor } from '../color'
  import { MONTHS_LONG, MONTHS_SHORT, fmtCell, fmtNum, fmtRatio, ordinal, toM } from '../format'
  import { monthStats, seriesIndex, SOURCE_LABEL } from '../analysisUtil'
  import type { SourceCode } from '../kernel/types'

  let { a }: { a: Analysis } = $props()

  let showNumbers = $state(false)
  let showTable = $state(false)
  let activeR = $state(0)
  let activeC = $state(0)
  let tip = $state<{ r: number; c: number; x: number; y: number; below: boolean } | null>(null)
  let gridEl: HTMLDivElement | undefined = $state()
  let wrapEl: HTMLDivElement | undefined = $state()

  const mode = $derived(session.calMode)
  const theme = $derived(themeState.theme)
  // Rows: latest year on top.
  const rows = $derived(a.calendar.years.map((y, i) => ({ y, i })).reverse())
  const dom = $derived(activityDomain([...a.calendar.value.flat(), ...a.climatology.median]))
  const maxTotal = $derived(Math.max(1, ...a.annual.total.map((t) => t ?? 0)))
  const switchYear = $derived(Math.floor(session.effectiveSwitchM / 12) + 2000)
  const focusM = $derived(session.focus)

  type Cell = { m: number; v: number | null; fill: string; ink: string; label: string; src: SourceCode; prov: boolean; empty: boolean }

  function colorFor(v: number | null, ratio: number | null, pct: number | null): string | null {
    if (v == null) return null
    if (mode === 'activity') return seqColor(activityT(v, dom), theme)
    if (mode === 'anomaly') return ratio == null ? (v > 0 ? divColor(1, theme) : divColor(0, theme)) : divColor(ratioT(ratio), theme)
    return pct == null ? divColor(0, theme) : divColor(percentileT(pct), theme)
  }
  function labelFor(v: number | null, ratio: number | null, pct: number | null): string {
    if (v == null) return ''
    if (mode === 'activity') return fmtCell(v)
    if (mode === 'anomaly') return ratio == null ? 'new' : ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1)
    return pct == null ? '' : String(Math.round(pct))
  }

  const grid = $derived<Cell[][]>(
    rows.map(({ y, i }) =>
      Array.from({ length: 12 }, (_, c) => {
        const v = a.calendar.value[i][c], ratio = a.calendar.ratio[i][c], pct = a.calendar.percentile[i][c]
        const m = toM(y, c + 1)
        const si = seriesIndex(a, m)
        const fill = colorFor(v, ratio, pct)
        return {
          m, v, fill: fill ?? 'transparent', ink: fill ? inkOn(fill) : 'var(--ink-3)', label: labelFor(v, ratio, pct),
          src: (si >= 0 ? a.series.source[si] : 0) as SourceCode, prov: si >= 0 ? a.series.provisional[si] : false, empty: v == null,
        }
      }),
    ),
  )
  const medianRow = $derived(
    a.climatology.median.map((v) => {
      const fill = mode === 'activity' ? seqColor(activityT(v, dom), theme) : divColor(0, theme)
      return { v, fill, ink: inkOn(fill), label: mode === 'activity' ? fmtCell(v) : mode === 'anomaly' ? '1.0' : '50' }
    }),
  )

  function ariaFor(cell: Cell): string {
    const name = `${MONTHS_LONG[(cell.m % 12)]} ${Math.floor(cell.m / 12) + 2000}`
    if (cell.empty) return `${name}: outside the record`
    const s = monthStats(a, cell.m)
    if (!s) return name
    const parts = [`${name}: ${fmtNum(s.value)} AFCD-M`]
    if (s.ratio != null) parts.push(`${fmtRatio(s.ratio)} the median`)
    if (s.percentile != null) parts.push(`${ordinal(Math.round(s.percentile))} percentile`)
    parts.push(SOURCE_LABEL[cell.src])
    if (cell.prov) parts.push('provisional')
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
    mode === 'activity' ? 'AFCD-M per month (log scale)' : mode === 'anomaly' ? 'Ratio to the baseline median of the same month (log₂)' : 'Percentile among baseline years for the same month',
  )
</script>

<section class="cal-section" aria-labelledby="cal-h">
  <div class="head">
    <div>
      <p class="eyebrow">02 · Burning calendar</p>
      <h2 id="cal-h">Every month since {a.calendar.years[0]}</h2>
    </div>
    <div class="opts">
      <label class="chk"><input type="checkbox" name="cell-numbers" bind:checked={showNumbers} /> Numbers</label>
      <button class="btn" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'View as calendar' : 'View as table'}</button>
    </div>
  </div>

  {#if !showTable}
    <div class="wrap" bind:this={wrapEl}>
      {#key `${session.aoi?.label}|${a.calendar.years[0]}`}
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div
          class="grid"
          class:nums={showNumbers}
          role="grid"
          aria-label={`Burning calendar, ${mode} mode. Rows are years, latest first; columns are months. Use arrow keys to move and Enter to show a month on the map.`}
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
            <div class="row" role="row" class:switch={row.y === switchYear} style:--d={`${r * 14}ms`}>
              <span class="yl num" role="rowheader">{row.y}</span>
              {#each grid[r] as cell, c (c)}
                <!-- keyboard is handled on the grid (roving tabindex) -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  class="cal-cell"
                  class:empty={cell.empty}
                  class:prov={cell.prov}
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
                  {#if cell.src === 1 && !cell.empty}<span class="mk terra" aria-hidden="true"></span>{/if}
                  {#if cell.src === 3 && !cell.empty}<span class="mk viirs" aria-hidden="true"></span>{/if}
                  {#if showNumbers && !cell.empty}<span class="n num" aria-hidden="true">{cell.label}</span>{/if}
                </div>
              {/each}
              <span class="ann" role="gridcell" aria-label={total == null ? `${row.y}: no data` : `${row.y} total ${fmtNum(total)} AFCD-M${complete ? (rank ? `, rank ${rank}` : '') : ', incomplete year'}`}>
                {#if total != null}
                  <span class="bar" class:partial={!complete} style:width={`${(72 * total) / maxTotal}%`}></span>
                  {#if complete && rank != null && rank <= 3}<span class="rk num" aria-hidden="true">#{rank}</span>{/if}
                  {#if !complete}<span class="rk partial-l" aria-hidden="true">partial</span>{/if}
                {/if}
              </span>
            </div>
          {/each}
          <div class="row median" role="row">
            <span class="yl" role="rowheader">Median</span>
            {#each medianRow as cell, c (c)}
              <span class="cal-cell med" role="gridcell" style:background={cell.fill} style:color={cell.ink}
                aria-label={`${MONTHS_LONG[c]} baseline median: ${fmtNum(cell.v)} AFCD-M`}>
                {#if showNumbers}<span class="n num" aria-hidden="true">{cell.label}</span>{/if}
              </span>
            {/each}
            <span class="ann bl small muted" role="gridcell">{session.effectiveBaseline.join('–')}</span>
          </div>
        </div>
      {/key}

      {#if tip && tipStats && tipCell && !tipCell.empty}
        <div class="tip" class:below={tip.below} style:left={`${tip.x}px`} style:top={`${tip.y}px`} role="tooltip">
          <p class="tt">{MONTHS_LONG[tipStats.month - 1]} {tipStats.year}{tipStats.provisional ? ' · provisional' : ''}</p>
          <dl>
            <dt>Harmonized</dt><dd class="num">{fmtNum(tipStats.value)} AFCD-M</dd>
            {#if tipStats.lo80 != null && tipStats.hi80 != null}<dt>80 % interval</dt><dd class="num">{fmtNum(tipStats.lo80)} – {fmtNum(tipStats.hi80)}</dd>{/if}
            <dt>Median</dt><dd class="num">{fmtNum(tipStats.median)}</dd>
            <dt>Ratio</dt><dd class="num">{fmtRatio(tipStats.ratio)}</dd>
            <dt>Percentile</dt><dd class="num">{tipStats.percentile == null ? '—' : ordinal(Math.round(tipStats.percentile))}</dd>
            {#if tipStats.rank != null}<dt>Rank</dt><dd class="num">{ordinal(tipStats.rank)} of {tipStats.of}</dd>{/if}
            <dt>Source</dt><dd>{SOURCE_LABEL[tipCell.src]}</dd>
          </dl>
        </div>
      {/if}
    </div>

    <div class="legend">
      <div class="ramp">
        <div class="bar" style:background={`linear-gradient(90deg, ${legendStops})`}></div>
        <div class="ticks num">{#each legendTicks as t, i (i)}<span>{t}</span>{/each}</div>
        <p class="cap">{legendCaption}</p>
      </div>
      <ul class="keys">
        <li><span class="sw terra-sw"><span class="mk terra"></span></span>Terra-only, bridged (2000–02)</li>
        <li><span class="sw viirs-sw"><span class="mk viirs"></span></span>Calibrated VIIRS (from {switchYear})</li>
        <li><span class="sw prov-sw"></span>Provisional (near real-time)</li>
        <li><span class="sw cur-sw"></span>Latest month</li>
        <li><span class="sw focus-sw"></span>Shown on map</li>
      </ul>
    </div>
    <p class="note small muted">Era marks never change the colour scale: every cell is in the same MODIS-equivalent unit. Click a month to map it.</p>
  {:else}
    <div class="table-wrap">
      <table class="cal-table">
        <caption class="small muted">Harmonized activity by month ({mode === 'activity' ? 'AFCD-M' : mode === 'anomaly' ? 'ratio to median' : 'percentile'}); * provisional</caption>
        <thead>
          <tr><th scope="col">Year</th>{#each MONTHS_SHORT as mo (mo)}<th scope="col">{mo}</th>{/each}<th scope="col">Total</th></tr>
        </thead>
        <tbody>
          {#each rows as row, r (row.y)}
            {@const ai = a.annual.years.indexOf(row.y)}
            <tr>
              <th scope="row" class="num">{row.y}</th>
              {#each grid[r] as cell (cell.m)}
                <td class="num">{cell.empty ? '' : mode === 'activity' ? fmtNum(cell.v) : cell.label}{cell.prov && !cell.empty ? '*' : ''}</td>
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
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .opts { display: flex; gap: 12px; align-items: center; }
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
  .mh { font-size: var(--fs-xs); color: var(--ink-3); text-align: center; text-transform: uppercase; letter-spacing: 0.06em; }
  .mh .ini { display: none; }
  .ah { font-size: var(--fs-xs); color: var(--ink-3); padding-left: 6px; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; overflow: hidden; }
  .cal-cell {
    position: relative; height: 18px; border-radius: 2px; cursor: pointer; display: grid; place-items: center; overflow: hidden;
    outline-offset: 1px;
  }
  .nums .cal-cell { height: 22px; }
  .cal-cell.empty { cursor: default; box-shadow: inset 0 0 0 1px var(--rule); }
  .cal-cell:hover:not(.empty) { box-shadow: inset 0 0 0 1.5px var(--ink); }
  .cal-cell.prov::after {
    content: ''; position: absolute; inset: 0;
    background: repeating-linear-gradient(135deg, transparent 0 3px, var(--hatch) 3px 4.5px);
  }
  .cal-cell.current { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent); z-index: 1; }
  .cal-cell.focus { box-shadow: inset 0 0 0 2px var(--bg), 0 0 0 2px var(--ink); z-index: 2; }
  .cal-cell.focus.current { box-shadow: inset 0 0 0 2px var(--bg), 0 0 0 2px var(--ink), 0 0 0 4px var(--accent); }
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
    .row { grid-template-columns: 2.6em repeat(12, minmax(0, 1fr)) 34px; }
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

  .legend { display: flex; flex-wrap: wrap; gap: 14px 28px; align-items: flex-start; margin-top: 14px; }
  .ramp { width: min(300px, 100%); }
  .ramp .bar { height: 10px; border-radius: 2px; }
  .ticks { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--ink-3); margin-top: 2px; }
  .cap { font-size: var(--fs-xs); color: var(--ink-3); margin: 2px 0 0; }
  .keys { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 4px 18px; flex: 1; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 8px; }
  .sw { position: relative; width: 18px; height: 12px; border-radius: 2px; background: var(--surface-3); color: var(--ink); flex: none; }
  .prov-sw { background: repeating-linear-gradient(135deg, var(--surface-3) 0 3px, var(--hatch) 3px 4.5px); }
  .cur-sw { background: transparent; box-shadow: inset 0 0 0 2px var(--accent); }
  .focus-sw { background: transparent; box-shadow: inset 0 0 0 2px var(--ink); }
  .note { margin: 10px 0 0; }

  .table-wrap { overflow-x: auto; max-height: 560px; overflow-y: auto; border-top: 1px solid var(--rule); }
  .cal-table { width: 100%; font-size: var(--fs-sm); }
  .cal-table caption { text-align: left; padding: 6px 0; caption-side: top; }
  .cal-table th, .cal-table td { padding: 3px 6px; text-align: right; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  .cal-table thead th { position: sticky; top: 0; background: var(--bg); color: var(--ink-3); font-weight: 500; }
  .cal-table th[scope='row'] { color: var(--ink-2); font-weight: 500; }
</style>
