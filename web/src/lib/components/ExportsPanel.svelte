<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { FIRMS_ACK } from '../config'
  import { aoiGeoJson, calendarCsv, calendarSvg, download, seriesCsv, slug, svgToPng, type ExportContext } from '../export/exporters'
  import { exportHotspotsCsv } from '../export/hotspots'
  import { ringsBbox } from '../geo'

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
  const geo = run('Area GeoJSON', () => download(`${base}.geojson`, aoiGeoJson(ctx!), 'application/geo+json'))
  const hot = run('Hotspots CSV', async () => {
    const o = session.options
    const blob = await exportHotspotsCsv({ rings: session.aoi!.rings, bbox: ringsBbox(session.aoi!.rings), range: o.range })
    download(`${base}-hotspots.csv`, blob, 'text/csv')
  })
</script>

<section class="exports" aria-labelledby="exp-h">
  <p class="eyebrow">08 · Exports</p>
  <h2 id="exp-h">Take it with you</h2>
  <div class="grid">
    <div>
      <h3>Tables</h3>
      <button class="btn" disabled={busy} onclick={csvCal}>Calendar CSV</button>
      <button class="btn" disabled={busy} onclick={csvSeries}>Full series CSV</button>
      <button class="btn" disabled={busy} onclick={hot}>Hotspots CSV</button>
    </div>
    <div>
      <h3>Figures</h3>
      <button class="btn" disabled={busy} onclick={pngCal}>Calendar PNG</button>
      <button class="btn" disabled={busy} onclick={svgCal}>Calendar SVG</button>
    </div>
    <div>
      <h3>Area</h3>
      <button class="btn" disabled={busy} onclick={geo}>AOI GeoJSON</button>
      <button class="btn" onclick={async () => { try { await navigator.clipboard.writeText(location.href); status = 'Link to this view copied.' } catch { status = 'Copy the address bar to share this view.' } }}>Copy share link</button>
    </div>
  </div>
  <p class="status small" role="status">{status ?? ''}</p>
  {#if session.isMock}<p class="small warn">Demo mode: exports contain synthetic numbers and say so in their header.</p>{/if}
  <p class="small muted ack">Exports include this acknowledgement: “{FIRMS_ACK}”</p>
</section>

<style>
  .exports { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px 24px; margin-top: 12px; }
  .grid > div { display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
  h3 { width: 100%; font-size: 0.78rem; font-weight: 500; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2px; }
  .status { min-height: 1.4em; margin: 10px 0 0; color: var(--ink-2); }
  .warn { color: var(--warning); }
  .ack { max-width: 72ch; }
</style>
