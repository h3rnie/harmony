<script lang="ts">
  import { untrack } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { live, fmtAge } from '../live/store.svelte'
  import type { PaceDay } from '../live/pace'
  import Term from './Term.svelte'
  import { livePace } from './livePace'
  import { LIVE_SOURCES, SAT_AQUA, SAT_N20, SAT_N21, SAT_TERRA, type LiveSource } from '../live/types'
  import { LEVEL_TONE } from '../analysisUtil'
  import { LEVEL_LABEL, MONTHS_LONG, MONTHS_SHORT, fmtNum, fmtRatio } from '../format'

  let { a }: { a: Analysis } = $props()

  // Live data is fetched only once this section is (nearly) in view, for each area shown while it is: loading an
  // area without scrolling here makes no /api/live request (the header badge reads /api/live/status only).
  let sectionEl = $state<HTMLElement>()
  let inView = $state(false)
  $effect(() => {
    const el = sectionEl
    if (!el) return
    const io = new IntersectionObserver((es) => { inView = es.some((e) => e.isIntersecting) }, { rootMargin: '200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  })
  $effect(() => {
    void session.aoi
    if (inView) untrack(() => live.request())
  })

  const SOURCE_NAME: Record<LiveSource, string> = { VIIRS_NOAA20_NRT: 'NOAA-20', VIIRS_NOAA21_NRT: 'NOAA-21', MODIS_NRT: 'MODIS' }
  const nf = new Intl.NumberFormat('en-US')
  const ago = (sec: number) => { const t = fmtAge(sec); return t === 'just now' ? t : `${t} ago` }

  const d = $derived(live.data)
  const pace = $derived(livePace(a))
  const stamp = $derived.by(() => {
    const t = new Date(d ? d.fetched_at * 1000 : live.now)
    return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  })

  const nowDate = $derived(new Date(live.now))
  const monthName = $derived(MONTHS_LONG[nowDate.getUTCMonth()])
  const unit = $derived(pace?.calibration === 'none' ? 'VIIRS cell-days' : session.unitLabel)
  const tone = $derived(pace?.level ? LEVEL_TONE[pace.level] ?? 'neutral' : 'neutral')
  const failed = $derived(d ? LIVE_SOURCES.filter((s) => d.sources[s].error) : [])
  const dnNote = $derived(session.dn === 'both' ? '' : ` (${session.dn} overpasses only)`)
  const latest = $derived.by(() => {
    if (!d?.latest_t) return null
    const t = new Date(d.latest_t * 1000)
    return { utc: `${MONTHS_SHORT[t.getUTCMonth()]} ${t.getUTCDate()}, ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC`, age: ago(live.now / 1000 - d.latest_t) }
  })
  const kText = $derived.by(() => {
    if (!pace) return ''
    const k = pace.days.find((x) => x.complete && x.k != null)?.k
    if (pace.calibration === 'none') return 'No calibrated VIIRS months in this area’s record: shown in uncalibrated VIIRS cell-days, no comparison with the normal.'
    const where = pace.calibration === 'month' ? `${monthName} months` : 'all months (too little VIIRS in this calendar month)'
    return `VIIRS cell-days × ${k != null ? k.toFixed(2) : '—'}, this area’s calibration factor from ${where}.`
  })

  // ---------------------------------------------------------------- chart (Observable Plot, lazy)
  let chartEl = $state<HTMLDivElement>()
  let width = $state(560)
  type Row = PaceDay & { label: string; q25: number; q75: number; median: number; v: number | null }
  const rows = $derived<Row[]>(
    (pace?.days ?? []).map((x) => ({
      ...x,
      label: `${MONTHS_SHORT[x.month - 1]} ${Number(x.date.slice(8))}`,
      q25: x.normal.q25, q75: x.normal.q75, median: x.normal.median,
      v: x.value,
    })),
  )
  const showNormal = $derived(pace != null && pace.calibration !== 'none' && (pace.normalPace ?? 0) > 0)

  $effect(() => {
    const el = chartEl, data = rows, w = width, normal = showNormal
    void themeState.theme
    if (!el || !data.length) return
    let cancelled = false
    import('@observablehq/plot').then((Plot) => {
      if (cancelled) return
      const complete = data.filter((r) => r.v != null && r.complete)
      const partial = data.filter((r) => r.v != null && !r.complete)
      const yMax = Math.max(1e-6, ...data.map((r) => Math.max(r.v ?? 0, normal ? r.q75 : 0)))
      const bandW = (w - 50) / data.length
      const inset = Math.max(2, (bandW - 24) / 2) // bars never wider than 24 px
      const fig = Plot.plot({
        width: w, height: 200, marginLeft: 46, marginRight: 8, marginTop: 24, marginBottom: 26,
        style: { fontFamily: 'var(--font-num)', fontSize: 'var(--fs-xs)', color: 'var(--ink-3)', background: 'transparent', overflow: 'visible' },
        x: { type: 'band', domain: data.map((r) => r.label), label: null, padding: 0, tickSize: 0 },
        y: { domain: [0, yMax * 1.08], nice: true, grid: true, label: `${unit} / day`, labelAnchor: 'top', ticks: 4, tickSize: 0 },
        marks: [
          normal ? Plot.barY(data, { x: 'label', y1: 'q25', y2: 'q75', fill: 'var(--env-inner)', inset: 1 }) : null,
          normal ? Plot.tickY(data, { x: 'label', y: 'median', stroke: 'var(--ink-3)', strokeWidth: 1.5, inset: 1 }) : null,
          Plot.ruleY([0], { stroke: 'var(--rule-strong)' }),
          Plot.barY(complete, { x: 'label', y: 'v', fill: 'var(--accent)', insetLeft: inset, insetRight: inset, ry2: 4 }),
          Plot.barY(partial, { x: 'label', y: 'v', fill: 'none', stroke: 'var(--accent)', strokeWidth: 1.5, insetLeft: inset + 1, insetRight: inset + 1, ry2: 4 }),
          Plot.tip(data, Plot.pointerX({
            x: 'label', y: (r: Row) => r.v ?? 0,
            title: (r: Row) => [
              `${r.date} (local solar)${r.complete ? '' : ' · partial day'}`,
              r.v == null ? 'No VIIRS data' : `${fmtNum(r.v)} ${unit}`,
              normal ? `Normal ${fmtNum(r.median)} (middle half ${fmtNum(r.q25)}–${fmtNum(r.q75)})` : null,
              `${nf.format(r.detections)} detections`,
            ].filter(Boolean).join('\n'),
          })),
        ],
      })
      el.replaceChildren(fig)
    }).catch((e) => console.warn('live chart unavailable', e))
    return () => { cancelled = true }
  })

</script>

{#if live.available && session.aoi}
  <section class="now" id="now" aria-labelledby="now-h" aria-busy={live.phase === 'loading'} bind:this={sectionEl}>
    <div class="top">
      <h2 id="now-h" class="q-title">What is burning right now?</h2>
      {#if d}
        <button class="btn" onclick={() => live.retry()} disabled={live.phase === 'loading'} title="Live data refreshes every 10 minutes">{live.phase === 'loading' ? 'Refreshing…' : 'Refresh'}</button>
      {/if}
    </div>
    <p class="stamp"><span class="now-dot" aria-hidden="true"></span>Last 7 days to <span class="num">{stamp}</span> · a different time frame from the sections above · <Term id="provisional">provisional</Term></p>

    {#if live.phase === 'too-large'}
      <p class="msg" role="status">
        This area is too large for the live feed: its bounding box covers <span class="num">{live.tooLarge?.area}</span> square degrees,
        the limit is <span class="num">{live.tooLarge?.limit}</span> (about 30° × 30°). Draw a smaller area or pick a story preset to see what is burning now.
      </p>
    {:else if !d && live.phase === 'error'}
      <p class="msg warn" role="status">{live.error} <button class="btn" onclick={() => live.retry()}>Retry</button></p>
    {:else if !d || !pace}
      <div class="skel" role="status" aria-label="Loading live detections"></div>
    {:else}
      <p class="lead">
        {#if pace.ratio != null}
          Burning at <strong class="num">{fmtRatio(pace.ratio)}</strong> the normal daily pace for {monthName}.
        {:else if pace.pace != null}
          About <strong class="num">{fmtNum(pace.pace)}</strong> {unit} a day; there is no normal to compare with for {monthName} here.
        {:else}
          No complete day with VIIRS data yet in this window.
        {/if}
        <span class="num">{nf.format(pace.detTotal)}</span> satellite detections{dnNote} in the last 7 days.
      </p>

      <div class="facts">
        {#if pace.level}
          <span class="level {tone}">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              {#if tone === 'critical'}<path d="M6 1 11 6 6 11 1 6z" fill="currentColor" />
              {:else if tone === 'serious' || tone === 'warning'}<path d="M6 1.5 11 10.5H1z" fill="currentColor" />
              {:else if tone === 'info'}<path d="M6 10.5 1 1.5h10z" fill="currentColor" />
              {:else}<circle cx="6" cy="6" r="4" fill="currentColor" />{/if}
            </svg>
            {LEVEL_LABEL[pace.level]} pace
          </span>
        {/if}
        <p class="detail small muted">
          {#if latest}Latest detection <span class="num">{latest.utc}</span> ({latest.age}){:else}No detections in the queried box in the last 7 days{/if}
          · fetched <span class="num">{ago(live.now / 1000 - d.fetched_at)}</span>{#if d.stale} · <span class="warn">cached copy, FIRMS busy</span>{/if}
        </p>
      </div>

      {#if failed.length}
        <p class="msg warn small" role="status">
          {failed.map((s) => SOURCE_NAME[s]).join(' and ')} unavailable right now ({failed.map((s) => d.sources[s].error).join('; ')}).
          {#if failed.includes('VIIRS_NOAA20_NRT') || failed.includes('VIIRS_NOAA21_NRT')}The pace uses the VIIRS satellite that answered.{:else}Counts exclude it.{/if}
        </p>
      {/if}

      {#if pace.detTotal === 0}
        <p class="msg small" role="status">No detections in this area in the last 7 days{dnNote}.</p>
      {/if}

      <figure class="chart">
        <div bind:this={chartEl} bind:clientWidth={width} role="img"
          aria-label={`Daily ${unit} over the last 7 local-solar days${showNormal ? ' against the normal band' : ''}. Values are in the table below.`}></div>
        <ul class="keys">
          <li><span class="sw bar"></span>Live, complete day</li>
          <li><span class="sw hollow"></span>Partial day (not in the pace)</li>
          {#if showNormal}<li><span class="sw band"></span><span>Normal range (<Term id="iqr">middle half</Term>)</span></li><li><span class="sw med"></span>Normal, per day of {monthName}</li>{/if}
        </ul>
      </figure>

      <details class="tbl more">
        <summary class="small">Daily values (table)</summary>
        <div class="scroll">
          <table class="small">
            <caption class="sr-only">Daily live values by local-solar date</caption>
            <thead><tr><th scope="col">Local-solar date</th><th scope="col">NOAA-20 cell-days</th><th scope="col">NOAA-21 cell-days</th><th scope="col">VIIRS mean</th><th scope="col">{unit}</th>{#if showNormal}<th scope="col">Normal (middle half)</th>{/if}<th scope="col">Detections</th></tr></thead>
            <tbody>
              {#each pace.days as r (r.day)}
                <tr class:partial={!r.complete}>
                  <th scope="row">{r.date}{r.complete ? '' : ' (partial)'}</th>
                  <td class="num">{r.perSat[0] ?? 'n/a'}</td>
                  <td class="num">{r.perSat[1] ?? 'n/a'}</td>
                  <td class="num">{r.viirsCd == null ? '—' : fmtNum(r.viirsCd)}</td>
                  <td class="num">{r.value == null ? '—' : fmtNum(r.value)}</td>
                  {#if showNormal}<td class="num">{fmtNum(r.normal.median)} ({fmtNum(r.normal.q25)}–{fmtNum(r.normal.q75)})</td>{/if}
                  <td class="num">{nf.format(r.detections)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>

      <details class="more">
        <summary>How the pace is worked out</summary>
        <div class="more-body">
          <p>
            In {unit} a day: <span class="num">{pace.pace == null ? '—' : fmtNum(pace.pace)}</span> over the last <span class="num">{pace.nComplete}</span> complete days{#if (pace.normalPace ?? 0) > 0}, against a normal of <span class="num">{fmtNum(pace.normalPace)}</span>{#if pace.normalBand} (middle half <span class="num">{fmtNum(pace.normalBand[0])}–{fmtNum(pace.normalBand[1])}</span>){/if}{/if}.
            Detections by satellite: NOAA-20 <span class="num">{nf.format(pace.detBySat[SAT_N20])}</span>, NOAA-21 <span class="num">{nf.format(pace.detBySat[SAT_N21])}</span>, MODIS (Terra + Aqua) <span class="num">{nf.format(pace.detBySat[SAT_TERRA] + pace.detBySat[SAT_AQUA])}</span>.
          </p>
      <p class="fine muted">
        Near-real-time, provisional: not yet screened for static heat sources (gas flares, industry) — the calendar updates when science-quality data arrives.
        Pace = distinct (0.0125° sub-cell, local-solar date, day|night) from NOAA-20 and NOAA-21 nominal/high-confidence detections inside the area,
        averaged over the satellites that reported each day (never summed). {kText}
        Normal = climatological median for {monthName} ÷ days in the month. MODIS is counted, not used for the pace.
      </p>
        </div>
      </details>
    {/if}
  </section>
{/if}

<style>
  .now { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .stamp { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin: 6px 0 0; font-size: var(--fs-base); color: var(--ink-3); max-width: none; }
  .now-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); margin-right: 2px; }
  .lead strong { font-size: var(--fs-xl); font-weight: 600; }
  .facts { display: flex; gap: 8px 16px; align-items: center; flex-wrap: wrap; }
  .detail { margin: 0; color: var(--ink-2); }
  .detail.muted { color: var(--ink-3); }
  .msg { margin: 10px 0 0; color: var(--ink-2); max-width: 72ch; }
  .warn { color: var(--warning); }
  .msg.warn { border-left: 2px solid var(--warning); padding-left: 10px; color: var(--ink-2); }
  .skel { height: 120px; margin-top: 12px; border-radius: var(--radius); background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .chart { margin: 16px 0 0; }
  .chart > div { --plot-background: var(--surface); min-height: 200px; }
  .chart :global(svg) { display: block; }
  .chart :global([aria-label='tip'] text) { fill: var(--ink); }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 1px; }
  .sw.bar { background: var(--accent); }
  .sw.hollow { box-shadow: inset 0 0 0 1.5px var(--accent); }
  .sw.band { width: 14px; background: var(--env-inner); }
  .sw.med { width: 14px; height: 2px; background: var(--ink-3); border-radius: 0; }
  .tbl { margin-top: 12px; }
  .tbl summary { cursor: pointer; color: var(--ink-2); }
  .tbl summary:hover { color: var(--ink); }
  .scroll { overflow-x: auto; }
  table { margin-top: 6px; width: 100%; }
  th, td { text-align: right; padding: 3px 8px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
  th:first-child { text-align: left; }
  thead th { font-weight: 500; color: var(--ink-3); }
  tbody th { font-weight: 400; font-family: var(--font-num); }
  tr.partial { color: var(--ink-3); }
  .fine { margin: 12px 0 0; max-width: 80ch; line-height: 1.5; font-size: var(--fs-sm); }
</style>
