<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { aoiGeoJson, calendarCsv, calendarSvg, download, seriesCsv, slug, svgToPng, type ExportContext } from '../export/exporters'
  import {
    DEFAULT_MAX_ROWS, fmtBytes, isAbort, loadPointsIndex, planHotspots, runHotspots,
    type HotspotPlan, type HotspotProgress,
  } from '../export/hotspots'
  import { onDestroy } from 'svelte'
  import { monthShort, yearOf } from '../format'
  import { live as liveFeed } from '../live/store.svelte'
  import { liveCsv } from '../live/csv'

  let { a }: { a: Analysis } = $props()
  let status = $state<string | null>(null)
  let busy = $state(false)

  const ctx = $derived<ExportContext | null>(
    session.aoi
      ? {
          analysis: a, aoi: session.aoi, baseline: session.effectiveBaseline, switchM: session.effectiveSwitchM,
          dn: session.dn, kernel: session.isMock ? 'mock' : 'wasm', dataThrough: session.meta?.data_through ?? '',
        }
      : null,
  )
  const base = $derived(`harmony-${slug(session.aoi?.label ?? 'area')}`)

  function run(label: string, fn: () => void | Promise<void>) {
    return async () => {
      if (!ctx) return
      busy = true
      status = null
      try {
        await fn()
        status = `${label} downloaded.`
      } catch (e) {
        status = (e as Error).message
      } finally {
        busy = false
      }
    }
  }
  const csvCal = run('Calendar CSV', () => download(`${base}-calendar.csv`, calendarCsv(ctx!), 'text/csv'))
  const csvSeries = run('Series CSV', () => download(`${base}-series.csv`, seriesCsv(ctx!), 'text/csv'))
  const svgCal = run('Calendar SVG', () => download(`${base}-calendar.svg`, calendarSvg(ctx!, session.calMode, themeState.theme).svg, 'image/svg+xml'))
  const pngCal = run('Calendar PNG', async () => {
    const { svg, width, height } = calendarSvg(ctx!, session.calMode, themeState.theme)
    download(`${base}-calendar.png`, await svgToPng(svg, width, height), 'image/png')
  })
  const liveHot = run('Live hotspots CSV', () => {
    const d = liveFeed.data
    if (!d || !liveFeed.inside) throw new Error('Live detections are not loaded.')
    const stamp = new Date(d.fetched_at * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '')
    download(`${slug(session.aoi?.label ?? 'area')}-live-hotspots-${stamp}.csv`, liveCsv(d, liveFeed.inside, session.aoi?.label ?? 'area'), 'text/csv')
  })
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.href); status = 'Link to this view copied.' } catch { status = 'Copy the address bar to share this view.' }
  }
  const geo = run('Area GeoJSON', () => download(`${base}.geojson`, aoiGeoJson(ctx!), 'application/geo+json'))

  // ---- Hotspots CSV: estimate -> confirm -> progress -> summary ----
  type Hot =
    | { phase: 'idle' }
    | { phase: 'planning'; p: HotspotProgress | null }
    | { phase: 'estimate'; plan: HotspotPlan; tooLarge: boolean }
    | { phase: 'running'; plan: HotspotPlan; p: HotspotProgress | null; limited: boolean }
    | { phase: 'done'; summary: string; note: string | null; blob: Blob; name: string }
    | { phase: 'error'; message: string }
  let hot = $state<Hot>({ phase: 'idle' })
  let hotAvail = $state<'checking' | 'yes' | 'no'>('checking')
  let hotAvailMsg = $state('')
  let live = $state('')
  let hotCtl: AbortController | null = null
  let lastPct = -1
  let exportBtn = $state<HTMLButtonElement | null>(null)
  const nf = new Intl.NumberFormat('en-US')

  // Which months the hotspot export covers. Default: the selected month's year, clipped to the displayed range.
  type HotRange = 'month' | 'year' | 'range'
  let hotRange = $state<HotRange>('year')
  const selM = $derived(session.focus ?? a.current.m)
  const hotSpan = $derived.by<[number, number]>(() => {
    const [r0, r1] = session.options.range
    if (hotRange === 'month') return [selM, selM]
    if (hotRange === 'year') {
      const y0 = (yearOf(selM) - 2000) * 12
      return [Math.max(r0, y0), Math.min(r1, y0 + 11)]
    }
    return [r0, r1]
  })
  const hotRangeText = $derived(
    hotRange === 'month' ? monthShort(selM) : hotRange === 'year' ? String(yearOf(selM)) : `${yearOf(hotSpan[0])}–${yearOf(hotSpan[1])}`,
  )
  const HOT_RANGES: [HotRange, string][] = [['month', 'Selected month'], ['year', 'Selected year'], ['range', 'Full displayed range']]

  $effect(() => {
    const ctl = new AbortController()
    loadPointsIndex(ctl.signal).then(
      () => { hotAvail = 'yes' },
      (e) => { if (!ctl.signal.aborted) { hotAvail = 'no'; hotAvailMsg = (e as Error).message } },
    )
    return () => ctl.abort()
  })

  function hotReset() {
    hotCtl?.abort()
    hotCtl = null
    hot = { phase: 'idle' }
    live = ''
    lastPct = -1
  }
  // A different area or date range invalidates any estimate or running export.
  $effect(() => {
    session.aoi
    hotSpan[0]
    hotSpan[1]
    return () => { if (hot.phase !== 'idle' && hot.phase !== 'done') hotReset() }
  })
  onDestroy(() => hotCtl?.abort())

  async function hotEstimate() {
    if (!session.aoi || hotAvail !== 'yes') return
    hotCtl?.abort()
    const ctl = (hotCtl = new AbortController())
    hot = { phase: 'planning', p: null }
    live = 'Checking which hotspot files cover this area.'
    try {
      const [mFrom, mTo] = hotSpan
      const plan = await planHotspots({
        rings: session.aoi.rings, mFrom, mTo, label: session.aoi.label, signal: ctl.signal,
        onProgress: (p) => { if (hot.phase === 'planning') hot = { phase: 'planning', p } },
      })
      const tooLarge = plan.estRows > DEFAULT_MAX_ROWS
      hot = { phase: 'estimate', plan, tooLarge }
      live = plan.files.length === 0
        ? 'No hotspots were archived for this area and date range.'
        : tooLarge
          ? `The scan covers up to ${nf.format(plan.estRows)} rows, over the ${nf.format(DEFAULT_MAX_ROWS)} row limit. Narrow the area or dates, or export the first ${nf.format(DEFAULT_MAX_ROWS)} rows.`
          : `Estimate ready: roughly ${nf.format(plan.likelyRows)} hotspots in ${plan.files.length} files. Export or cancel.`
      queueMicrotask(() => exportBtn?.focus())
    } catch (e) {
      if (ctl.signal.aborted || isAbort(e)) return
      hot = { phase: 'error', message: (e as Error).message }
      live = `Hotspot export failed. ${(e as Error).message}`
    }
  }

  async function hotRun(plan: HotspotPlan, limited: boolean) {
    hotCtl?.abort()
    const ctl = (hotCtl = new AbortController())
    hot = { phase: 'running', plan, p: null, limited }
    live = 'Exporting hotspots.'
    lastPct = -1
    try {
      const res = await runHotspots(plan, {
        signal: ctl.signal,
        rowLimit: limited ? DEFAULT_MAX_ROWS : undefined,
        onProgress: (p) => {
          if (hot.phase !== 'running') return
          hot = { ...hot, p }
          const pct = Math.floor((10 * Math.min(1, p.bytesFetched / Math.max(1, plan.estDownloadBytes)))) * 10
          if (pct !== lastPct) { lastPct = pct; live = `Exporting hotspots, ${pct} percent. ${nf.format(p.rows)} rows written.` }
        },
      })
      const name = `${base}-hotspots-${hotRange === 'month' ? monthShort(hotSpan[0]).replace(' ', '-').toLowerCase() : hotRange === 'year' ? yearOf(hotSpan[0]) : `${yearOf(hotSpan[0])}-${yearOf(hotSpan[1])}`}.csv`
      download(name, res.blob, 'text/csv')
      const summary = `${nf.format(res.rows)} hotspots · ${fmtBytes(res.csvBytes)} · ${res.files} ${res.files === 1 ? 'file' : 'files'}`
      hot = {
        phase: 'done', summary, blob: res.blob, name,
        note: res.truncated ? `Truncated at ${nf.format(DEFAULT_MAX_ROWS)} rows. Narrow the area or dates for the rest.` : null,
      }
      live = `Hotspot export finished. ${summary}.`
    } catch (e) {
      if (ctl.signal.aborted || isAbort(e)) { hot = { phase: 'idle' }; live = 'Hotspot export cancelled.'; return }
      hot = { phase: 'error', message: (e as Error).message }
      live = `Hotspot export failed. ${(e as Error).message}`
    }
  }
  function hotCancel() { hotReset(); live = 'Hotspot export cancelled.' }
  const hotProgress = $derived.by(() => {
    if (hot.phase === 'planning') return hot.p && hot.p.filesTotal ? hot.p.filesDone / hot.p.filesTotal : 0
    if (hot.phase === 'running') return hot.p ? Math.min(1, hot.p.bytesFetched / Math.max(1, hot.plan.estDownloadBytes)) : 0
    return 0
  })
</script>

<section class="exports" id="export" aria-labelledby="exp-h">
  <h2 id="exp-h" class="q-title">Take it with you</h2>
  <p class="lead">Share this exact view, or download the numbers and figures behind it.</p>
  <div class="primary">
    <button class="btn primary" onclick={copyLink}>Copy link to this view</button>
    <button class="btn" disabled={busy} onclick={pngCal}>Calendar image (PNG)</button>
  </div>
  <h3 class="sub-h">Data and figures</h3>
  <div class="grid">
    <div>
      <h4>Tables</h4>
      <button class="btn" disabled={busy} onclick={csvCal}>Calendar CSV</button>
      <button class="btn" disabled={busy} onclick={csvSeries}>Full series CSV</button>
      <button
        class="btn" disabled={busy || hot.phase === 'planning' || hot.phase === 'running'}
        aria-disabled={hotAvail !== 'yes' || !ctx}
        aria-describedby={hotAvail === 'no' ? 'hot-why' : undefined}
        title={hotAvail === 'no' ? hotAvailMsg : hotAvail === 'checking' ? 'Checking for the hotspot archive…' : 'Every MODIS and VIIRS detection inside the area and date range'}
        onclick={() => { if (hotAvail === 'yes' && ctx) hotEstimate() }}
      >Hotspots CSV</button>
      {#if hotAvail === 'no'}<span id="hot-why" class="sr-only">{hotAvailMsg}</span>{/if}
      {#if liveFeed.available}
        <button class="btn" disabled={busy || !liveFeed.data?.n} onclick={liveHot} title="Near-real-time detections from the last 7 days (provisional)">Live hotspots CSV, last 7 days</button>
      {/if}
    </div>
    <div>
      <h4>Figures</h4>
      <button class="btn" disabled={busy} onclick={svgCal}>Calendar SVG</button>
    </div>
    <div>
      <h4>Area</h4>
      <button class="btn" disabled={busy} onclick={geo}>Area outline (GeoJSON)</button>
    </div>
  </div>
  <div class="hot-range">
    <span class="hr-l" id="hot-range-l">Hotspots CSV covers</span>
    <div class="seg" role="radiogroup" aria-labelledby="hot-range-l">
      {#each HOT_RANGES as [v, l] (v)}
        <button role="radio" aria-checked={hotRange === v} onclick={() => (hotRange = v)}>{l}</button>
      {/each}
    </div>
    <span class="small muted num">{hotRangeText}</span>
  </div>
  {#if hot.phase !== 'idle'}
    <div class="hot" role="group" aria-labelledby="hot-h">
      <h3 id="hot-h">Hotspots CSV · <span class="num">{hotRangeText}</span></h3>
      {#if hot.phase === 'planning'}
        <p class="small">Checking which files cover this area{hot.p ? ` (${hot.p.filesDone} of ${hot.p.filesTotal})` : ''}…</p>
        <progress class="bar" max="1" value={hotProgress} aria-label="Reading file indexes"></progress>
        <div class="row"><button class="btn" onclick={hotCancel}>Cancel</button></div>
      {:else if hot.phase === 'estimate'}
        {@const pl = hot.plan}
        {#if pl.files.length === 0}
          <p class="small">No hotspots are archived for this area and date range.</p>
          <div class="row"><button class="btn" onclick={hotReset} bind:this={exportBtn}>Close</button></div>
        {:else}
          <p class="est">
            <strong>Roughly {nf.format(pl.likelyRows)} hotspots</strong>
            <span class="dot">·</span> {pl.files.length} {pl.files.length === 1 ? 'file' : 'files'}
            <span class="dot">·</span> ~{fmtBytes(pl.estDownloadBytes)} to download
            <span class="dot">·</span> ~{fmtBytes(pl.estCsvBytes)} CSV
          </p>
          <p class="small muted">
            Scans {pl.keptGroups} of {pl.totalGroups} row groups, up to {nf.format(pl.estRows)} rows. Rows outside the outline or the months are dropped while writing, so the count is usually far lower.
            {#if pl.groupsWithoutStats}{pl.groupsWithoutStats} groups carry no range statistics and are read in full.{/if}
          </p>
          {#if hot.tooLarge}
            <p class="small warn" role="alert">
              The scan could return more than {nf.format(DEFAULT_MAX_ROWS)} rows. Narrow the area or the date range, or export only the first {nf.format(DEFAULT_MAX_ROWS)} rows.
            </p>
            <div class="row">
              <button class="btn primary" bind:this={exportBtn} onclick={() => hotRun(pl, true)}>Export first {nf.format(DEFAULT_MAX_ROWS)} rows anyway</button>
              <button class="btn" onclick={hotCancel}>Cancel</button>
            </div>
          {:else}
            <div class="row">
              <button class="btn primary" bind:this={exportBtn} onclick={() => hotRun(pl, false)}>Export</button>
              <button class="btn" onclick={hotCancel}>Cancel</button>
            </div>
          {/if}
        {/if}
      {:else if hot.phase === 'running'}
        <p class="small" aria-hidden="true">
          {nf.format(hot.p?.rows ?? 0)} rows written <span class="dot">·</span> {fmtBytes(hot.p?.bytesFetched ?? hot.plan.metaBytes)} fetched
          <span class="dot">·</span> file {Math.min(hot.plan.files.length, (hot.p?.filesDone ?? 0) + 1)} of {hot.plan.files.length}
        </p>
        <progress class="bar" max="1" value={hotProgress} aria-label="Exporting hotspots"></progress>
        <div class="row"><button class="btn" onclick={hotCancel}>Cancel</button></div>
      {:else if hot.phase === 'done'}
        <p class="est"><strong>{hot.summary}</strong></p>
        {#if hot.note}<p class="small warn">{hot.note}</p>{/if}
        <div class="row">
          <button class="btn" onclick={() => { if (hot.phase === 'done') download(hot.name, hot.blob, 'text/csv') }}>Save again</button>
          <button class="btn" onclick={hotReset}>Close</button>
        </div>
      {:else if hot.phase === 'error'}
        <p class="small warn" role="alert">{hot.message}</p>
        <div class="row">
          <button class="btn" onclick={hotEstimate}>Try again</button>
          <button class="btn" onclick={hotReset}>Close</button>
        </div>
      {/if}
    </div>
  {/if}
  <p class="sr-only" aria-live="polite" aria-atomic="true">{live}</p>
  <p class="status small" role="status">{status ?? ''}</p>
  {#if session.isMock}<p class="small warn">Demo mode: exports contain synthetic numbers and say so in their header.</p>{/if}
  <p class="note">Every file carries the FIRMS data acknowledgement shown at the foot of the page.</p>
</section>

<style>
  .exports { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .primary { display: flex; flex-wrap: wrap; gap: 8px; }
  .sub-h { font-size: var(--fs-base); margin: 20px 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px 24px; margin-top: 10px; }
  .grid > div { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
  h4 { width: 100%; font-size: var(--fs-sm); font-weight: 500; color: var(--ink-3); margin: 0 0 2px; }
  .hr-l { font-size: var(--fs-sm); color: var(--ink-2); }
  .hot-range { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--rule); }
  .hot-range .seg button { min-height: 30px; font-size: var(--fs-sm); }
  .status { min-height: 1.4em; margin: 10px 0 0; color: var(--ink-2); }
  .warn { color: var(--warning); }
  .hot { margin-top: 14px; padding: 12px 14px; max-width: 64ch; background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); }
  .hot h3 { margin-bottom: 6px; }
  .hot p { margin: 0 0 8px; }
  .hot .est { color: var(--ink); }
  .hot .dot { color: var(--ink-faint); margin: 0 0.2em; }
  .hot .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .bar { display: block; width: 100%; height: 6px; appearance: none; -webkit-appearance: none; border: 0; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
  .bar::-webkit-progress-bar { background: var(--surface-3); }
  .bar::-webkit-progress-value { background: var(--accent); transition: width 0.2s; }
  .bar::-moz-progress-bar { background: var(--accent); }
  .btn[aria-disabled='true'] { opacity: 0.45; cursor: not-allowed; }
</style>
