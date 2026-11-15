<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { Map as MlMap, NavigationControl, Popup, ScaleControl, setWorkerUrl, type ImageSource, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl'
  import 'maplibre-gl/dist/maplibre-gl.css'
  // MapLibre resolves its worker relative to its own module URL, which breaks once bundled; point at it explicitly.
  import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
  setWorkerUrl(maplibreWorkerUrl)
  import {
    TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawCircleMode, TerraDrawSelectMode, type GeoJSONStoreFeatures,
  } from 'terra-draw'
  import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { renderCellLayer, type RenderedOverlay } from './cellOverlay'
  import { normalizeRings, polygonFromGeoJSON, ringsBbox, type Aoi } from '../geo'
  import { PRESETS, type Preset } from '../presets'
  import { fmtArea, fmtNum, fmtRatio, monthShort } from '../format'
  import CoordinatesPopover from './CoordinatesPopover.svelte'
  import MapLegend from './MapLegend.svelte'
  import type { ClimOverlay } from '../pulse/climOverlay'
  import { live, fmtAge, WINDOW_HOURS } from '../live/store.svelte'
  import { liveGeoJson, livePaint, popupNode } from '../live/liveLayer'
  import LiveControl from '../live/LiveControl.svelte'

  const STYLE_URL = { dark: 'https://tiles.openfreemap.org/styles/dark', light: 'https://tiles.openfreemap.org/styles/positron' }
  const OWN_PREFIXES = ['td', 'h-']

  let container: HTMLDivElement
  let map: MlMap | undefined
  let draw: TerraDraw | undefined
  let basemapFailed = $state(false)
  let mapReady = $state(false)
  type DrawMode = 'none' | 'polygon' | 'rectangle' | 'circle' | 'select'
  let drawMode = $state<DrawMode>('none')
  let presetsOpen = $state(false)
  let coordsOpen = $state(false)
  let dropActive = $state(false)
  let notice = $state<string | null>(null)
  let overlay = $state.raw<RenderedOverlay | null>(null)
  let readout = $state<string | null>(null)
  let clim = $state.raw<ClimOverlay | null>(null)
  let fileInput: HTMLInputElement
  let fitNext = true
  let liveShown = $state(0)
  let livePopup: Popup | undefined
  let lastFittedKey = ''

  const HINTS: Record<DrawMode, string> = {
    none: '',
    polygon: 'Click to add vertices · click the first vertex or press Enter to finish · Esc cancels',
    rectangle: 'Click one corner, then the opposite corner · Esc cancels',
    circle: 'Click the centre, then click again to set the radius · Esc cancels',
    select: 'Drag vertices or the shape to edit · press Done when finished',
  }

  function cssVar(name: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  function graticule() {
    const features: GeoJSON.Feature[] = []
    for (let lon = -180; lon <= 180; lon += 15) {
      features.push({ type: 'Feature', properties: { major: lon % 45 === 0 }, geometry: { type: 'LineString', coordinates: Array.from({ length: 33 }, (_, i) => [lon, -80 + i * 5]) } })
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      features.push({ type: 'Feature', properties: { major: lat === 0 }, geometry: { type: 'LineString', coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) } })
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection
  }

  function fallbackStyle(): StyleSpecification {
    return {
      version: 8,
      sources: { graticule: { type: 'geojson', data: graticule() } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': cssVar('--bg-2') || '#0e1218' } },
        { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': cssVar('--rule-strong') || '#364152', 'line-width': ['case', ['get', 'major'], 0.9, 0.4] } },
      ],
    }
  }

  /** Keep our own sources/layers (and terra-draw's) across basemap swaps. */
  function carryOver(prev: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
    if (!prev) return next
    const own = (id: string) => OWN_PREFIXES.some((p) => id.startsWith(p))
    const sources = { ...next.sources }
    for (const [id, s] of Object.entries(prev.sources)) if (own(id)) sources[id] = s
    return { ...next, sources, layers: [...next.layers.filter((l) => !own(l.id)), ...prev.layers.filter((l) => own(l.id))] }
  }

  function installOwnLayers() {
    if (!map) return
    const accent = cssVar('--accent') || '#ff8a4c'
    if (!map.getSource('h-cells')) map.addSource('h-cells', { type: 'image', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] })
    if (!map.getLayer('h-cells')) {
      map.addLayer({ id: 'h-cells', type: 'raster', source: 'h-cells', paint: { 'raster-opacity': 0, 'raster-resampling': 'nearest', 'raster-opacity-transition': { duration: themeState.reducedMotion ? 0 : 450, delay: 0 } } })
    }
    // Landing climatology (lazy, from the global overview) sits under the analysis cells.
    if (!map.getSource('h-clim')) map.addSource('h-clim', { type: 'image', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] })
    if (!map.getLayer('h-clim')) map.addLayer({ id: 'h-clim', type: 'raster', source: 'h-clim', paint: { 'raster-opacity': 0, 'raster-resampling': 'linear', 'raster-opacity-transition': { duration: themeState.reducedMotion ? 0 : 450, delay: 0 } } }, 'h-cells')
    if (!map.getSource('h-aoi')) map.addSource('h-aoi', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getLayer('h-aoi-fill')) map.addLayer({ id: 'h-aoi-fill', type: 'fill', source: 'h-aoi', paint: { 'fill-color': accent, 'fill-opacity': 0.05 } })
    if (!map.getLayer('h-aoi-casing')) map.addLayer({ id: 'h-aoi-casing', type: 'line', source: 'h-aoi', paint: { 'line-color': cssVar('--bg') || '#000', 'line-width': 4, 'line-opacity': 0.6 } })
    if (!map.getLayer('h-aoi-line')) map.addLayer({ id: 'h-aoi-line', type: 'line', source: 'h-aoi', paint: { 'line-color': accent, 'line-width': 1.8 } })
    // Live FIRMS detections sit above the historical overlay and the AOI outline.
    if (!map.getSource('h-live')) map.addSource('h-live', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getLayer('h-live-pts')) map.addLayer({ id: 'h-live-pts', type: 'circle', source: 'h-live', paint: livePaint(themeState.theme) })
    // terra-draw layers must stay above ours
    for (const l of map.getStyle().layers) if (l.id.startsWith('td')) map.moveLayer(l.id)
    pushAoi()
    pushOverlay()
    pushClim()
    pushLive()
  }

  function pushLive() {
    if (!map || !map.getLayer('h-live-pts')) return
    const src = map.getSource('h-live') as GeoJSONSource | undefined
    const d = live.data, inside = live.inside, w = live.window
    const fc = d && inside && w !== 'off' && session.aoi ? liveGeoJson(d, inside, live.now / 1000, WINDOW_HOURS[w]) : { type: 'FeatureCollection' as const, features: [] }
    src?.setData(fc)
    liveShown = fc.features.length
    for (const [k, v] of Object.entries(livePaint(themeState.theme) ?? {})) map.setPaintProperty('h-live-pts', k as 'circle-color', v as never)
    if (!fc.features.length) livePopup?.remove()
  }

  function pushClim() {
    if (!map || !map.getLayer('h-clim')) return
    const src = map.getSource('h-clim') as ImageSource | undefined
    if (clim && src) src.updateImage({ image: clim.canvas, coordinates: clim.coordinates })
    map.setPaintProperty('h-clim', 'raster-opacity', clim && !session.aoi ? 0.85 : 0)
  }

  function pushAoi() {
    const src = map?.getSource('h-aoi') as GeoJSONSource | undefined
    if (!src) return
    const aoi = session.aoi
    src.setData({ type: 'FeatureCollection', features: aoi && drawMode !== 'select' ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: aoi.rings } }] : [] })
  }

  function pushOverlay() {
    if (!map || !map.getLayer('h-cells')) return
    const src = map.getSource('h-cells') as ImageSource | undefined
    if (!src) return
    if (!overlay) {
      map.setPaintProperty('h-cells', 'raster-opacity', 0)
      return
    }
    src.updateImage({ image: overlay.canvas, coordinates: overlay.coordinates })
    map.setPaintProperty('h-cells', 'raster-opacity', 0)
    requestAnimationFrame(() => map?.setPaintProperty('h-cells', 'raster-opacity', 0.88))
  }

  function fitAoi(aoi: Aoi) {
    if (!map) return
    const [w, s, e, n] = ringsBbox(aoi.rings)
    const narrow = container.clientWidth < 500
    map.fitBounds([[w, s], [e, n]], { padding: narrow ? 24 : 56, duration: themeState.reducedMotion ? 0 : 900, maxZoom: 9 })
  }

  function setupDraw() {
    if (!map) return
    const accent = (cssVar('--accent') || '#ff8a4c') as `#${string}`
    const style = { fillColor: accent, fillOpacity: 0.12, outlineColor: accent, outlineWidth: 2 }
    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [
        new TerraDrawPolygonMode({ styles: { ...style, closingPointColor: accent, closingPointOutlineColor: '#ffffff' } }),
        new TerraDrawRectangleMode({ styles: style }),
        new TerraDrawCircleMode({ styles: style }),
        new TerraDrawSelectMode({
          flags: {
            polygon: { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } },
          },
          styles: { selectedPolygonColor: accent, selectedPolygonOutlineColor: accent, selectedPolygonFillOpacity: 0.12, selectionPointColor: accent, midPointColor: accent },
        }),
      ],
    })
    draw.start()
    draw.on('finish', (id) => {
      const f = draw?.getSnapshotFeature(id)
      if (!f || f.geometry.type !== 'Polygon') return
      const rings = normalizeRings(f.geometry.coordinates as number[][][])
      if (drawMode === 'select') {
        fitNext = false
        session.setAoi({ rings, shape: { kind: 'polygon' }, label: session.aoi?.label ?? 'Drawn area' }, { keepFocus: true })
        return
      }
      const label = drawMode === 'circle' ? 'Drawn circle' : drawMode === 'rectangle' ? 'Drawn rectangle' : 'Drawn polygon'
      fitNext = false
      session.setAoi({ rings, shape: { kind: 'polygon' }, label })
      endDraw()
    })
  }

  function startDraw(mode: Exclude<DrawMode, 'none' | 'select'>) {
    if (!draw) return
    if (drawMode === mode) return endDraw()
    draw.clear()
    draw.setMode(mode)
    drawMode = mode
    presetsOpen = false
    coordsOpen = false
    pushAoi()
  }
  function startEdit() {
    if (!draw || !session.aoi) return
    if (drawMode === 'select') return endDraw()
    draw.clear()
    const id = crypto.randomUUID()
    const feature = { id, type: 'Feature', properties: { mode: 'polygon' }, geometry: { type: 'Polygon', coordinates: session.aoi.rings } } as unknown as GeoJSONStoreFeatures
    draw.setMode('select')
    drawMode = 'select'
    const res = draw.addFeatures([feature])
    if (res[0] && !res[0].valid) {
      notice = `This shape cannot be edited: ${res[0].reason ?? 'invalid geometry'}`
      return endDraw()
    }
    draw.selectFeature(id)
    pushAoi()
  }
  function endDraw() {
    if (!draw) return
    draw.clear()
    draw.setMode('static')
    drawMode = 'none'
    pushAoi()
  }
  function clearAoi() {
    endDraw()
    session.setAoi(null)
  }

  function choosePreset(p: Preset) {
    presetsOpen = false
    endDraw()
    fitNext = true
    session.setAoi({ rings: p.rings, shape: { kind: 'polygon' }, label: p.title, presetId: p.id })
  }

  async function loadFile(file: File) {
    try {
      const { rings, note } = polygonFromGeoJSON(await file.text())
      fitNext = true
      endDraw()
      session.setAoi({ rings, shape: { kind: 'polygon' }, label: file.name.replace(/\.(geo)?json$/i, '') })
      notice = note ?? null
    } catch (e) {
      notice = `Could not read ${file.name}: ${(e as Error).message}`
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    dropActive = false
    const f = e.dataTransfer?.files?.[0]
    if (f) loadFile(f)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (drawMode !== 'none') endDraw()
      presetsOpen = false
      coordsOpen = false
    }
  }

  onMount(() => {
    let loaded = false
    map = new MlMap({
      container,
      style: STYLE_URL[themeState.theme],
      center: [-30, 8],
      zoom: 1.4,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new ScaleControl({ maxWidth: 110 }), 'bottom-left')
    const useFallback = () => {
      if (basemapFailed || !map) return
      basemapFailed = true
      map.setStyle(fallbackStyle(), { transformStyle: carryOver })
    }
    const timer = setTimeout(() => { if (!loaded) useFallback() }, 9000)
    map.on('error', (e) => {
      if (!loaded) { console.warn('basemap failed, using fallback', e.error); useFallback() }
    })
    map.on('style.load', () => {
      installOwnLayers()
      if (!loaded) {
        loaded = true
        clearTimeout(timer)
        setupDraw()
        mapReady = true
        if (session.aoi) fitAoi(session.aoi)
      }
    })
    map.on('mousemove', (e) => {
      if (!overlay) { readout = null; return }
      const hit = overlay.lookup(e.lngLat.lng, e.lngLat.lat)
      readout = hit ? (overlay.mode === 'ratio' ? `${fmtRatio(hit.value)} the normal` : `${fmtNum(hit.value)} AFCD-M`) : null
    })
    map.on('mouseout', () => (readout = null))
    map.on('click', 'h-live-pts', (e) => {
      const f = e.features?.[0]
      const d = live.data
      if (!f || !d || !map) return
      const i = Number(f.properties?.i)
      if (!Number.isInteger(i) || i < 0 || i >= d.n) return
      livePopup?.remove()
      livePopup = new Popup({ closeButton: true, maxWidth: '300px', className: 'h-live-popup' })
        .setLngLat([d.lon[i], d.lat[i]])
        .setDOMContent(popupNode(d, i, live.now / 1000, f.properties?.in === 1, fmtAge))
        .addTo(map)
    })
    map.on('mouseenter', 'h-live-pts', () => { if (map && drawMode === 'none') map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'h-live-pts', () => { if (map) map.getCanvas().style.cursor = '' })
    addEventListener('keydown', onKey)
  })

  onDestroy(() => {
    removeEventListener('keydown', onKey)
    draw?.stop()
    map?.remove()
  })

  // AOI changes -> outline + camera
  $effect(() => {
    const aoi = session.aoi
    if (!mapReady) return
    untrack(() => {
      pushAoi()
      pushClim()
      if (!aoi) { overlay = null; pushOverlay(); return }
      const key = JSON.stringify(aoi.rings[0].slice(0, 4))
      if (fitNext && key !== lastFittedKey) fitAoi(aoi)
      lastFittedKey = key
      fitNext = true
    })
  })

  // Cell layer / theme / overlay mode -> canvas overlay
  $effect(() => {
    const layer = session.layer
    const theme = themeState.theme
    const meta = session.meta
    const mode = session.overlay
    const hasAoi = session.aoi != null
    if (!mapReady) return
    untrack(() => {
      if (!layer || !meta || !hasAoi) { overlay = null; pushOverlay(); return }
      const level = meta.levels.find((l) => l.level === layer.level)
      if (!level) return
      overlay = renderCellLayer(layer, level, mode, theme)
      pushOverlay()
    })
  })

  // Live data / window / clock / theme -> live detections layer
  $effect(() => {
    void live.data; void live.inside; void live.window; void live.now; void themeState.theme; void session.aoi
    if (!mapReady) return
    untrack(() => pushLive())
  })

  // Theme -> landing climatology for the current calendar month (shown only while no area is selected)
  $effect(() => {
    const theme = themeState.theme
    if (!mapReady) return
    import('../pulse/climOverlay')
      .then((m) => m.renderClimOverlay(new Date().getMonth() + 1, theme))
      .then((o) => { clim = o; pushClim() })
      .catch((e) => console.warn('climatology overlay unavailable', e))
  })

  // Theme -> basemap
  let currentTheme = themeState.theme
  $effect(() => {
    const theme = themeState.theme
    if (!mapReady || !map || theme === currentTheme) return
    currentTheme = theme
    untrack(() => {
      if (basemapFailed) map!.setStyle(fallbackStyle(), { transformStyle: carryOver })
      else map!.setStyle(STYLE_URL[theme], { transformStyle: carryOver })
    })
  })

  const focusLabel = $derived(session.layerM != null ? monthShort(session.layerM) : '')
</script>

<div
  class="map-panel"
  role="region"
  aria-label="Area of interest map"
  ondragover={(e) => { e.preventDefault(); dropActive = true }}
  ondragleave={() => (dropActive = false)}
  ondrop={onDrop}
>
  <div class="map" bind:this={container} aria-label="Interactive map. Use the toolbar to choose an area." role="application"></div>

  <div class="toolbar" role="toolbar" aria-label="Area tools">
    <div class="group">
      <button class="tool" class:on={presetsOpen} aria-expanded={presetsOpen} aria-controls="preset-menu" onclick={() => { presetsOpen = !presetsOpen; coordsOpen = false }}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10M3 8h10M3 13.5h6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>
        <span>Stories</span>
      </button>
    </div>
    <div class="group" aria-label="Draw">
      <button class="tool" aria-pressed={drawMode === 'polygon'} title="Draw a polygon" onclick={() => startDraw('polygon')} disabled={!mapReady}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5 2.5 5 8 2.5l5.5 3.5-1.5 6.5z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>
        <span class="lbl">Polygon</span>
      </button>
      <button class="tool" aria-pressed={drawMode === 'rectangle'} title="Draw a rectangle" onclick={() => startDraw('rectangle')} disabled={!mapReady}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="4" width="11" height="8" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
        <span class="lbl">Rectangle</span>
      </button>
      <button class="tool" aria-pressed={drawMode === 'circle'} title="Draw a circle" onclick={() => startDraw('circle')} disabled={!mapReady}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
        <span class="lbl">Circle</span>
      </button>
      <button class="tool" aria-pressed={drawMode === 'select'} title="Edit the current area" onclick={startEdit} disabled={!mapReady || !session.aoi}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3-8 8H2.5v-3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>
        <span class="lbl">{drawMode === 'select' ? 'Done' : 'Edit'}</span>
      </button>
      <button class="tool" title="Clear the area" onclick={clearAoi} disabled={!session.aoi && drawMode === 'none'}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <span class="lbl">Clear</span>
      </button>
    </div>
    <div class="group">
      <button class="tool" class:on={coordsOpen} aria-expanded={coordsOpen} aria-controls="coords-pop" onclick={() => { coordsOpen = !coordsOpen; presetsOpen = false }}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <span class="lbl">Coordinates</span>
      </button>
      <button class="tool" title="Load a GeoJSON polygon (or drop a file on the map)" onclick={() => fileInput.click()}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 11v2.5h11V11" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="lbl">GeoJSON</span>
      </button>
      <input bind:this={fileInput} name="geojson" type="file" accept=".geojson,.json,application/geo+json,application/json" class="sr-only" tabindex="-1" aria-label="GeoJSON file" onchange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) loadFile(f); (e.currentTarget as HTMLInputElement).value = '' }} />
    </div>
  </div>

  {#if presetsOpen}
    <div class="popover presets" id="preset-menu" role="dialog" aria-label="Story presets">
      <p class="eyebrow">Story presets</p>
      <ul>
        {#each PRESETS as p (p.id)}
          <li>
            <button class="preset" onclick={() => choosePreset(p)} aria-current={session.aoi?.presetId === p.id}>
              <span class="pt">{p.title}</span>
              <span class="ps">{p.subtitle}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if coordsOpen}
    <CoordinatesPopover onclose={() => (coordsOpen = false)} onsubmit={(aoi) => { coordsOpen = false; endDraw(); fitNext = true; session.setAoi(aoi) }} />
  {/if}

  {#if drawMode !== 'none'}
    <div class="hint" role="status">{HINTS[drawMode]}</div>
  {/if}

  {#if notice}
    <div class="notice" role="alert">
      <span>{notice}</span>
      <button class="x" aria-label="Dismiss" onclick={() => (notice = null)}>×</button>
    </div>
  {/if}

  {#if session.aoiInfo && session.aoi}
    <div class="aoi-chip">
      <span class="eyebrow">Area</span>
      <strong>{session.aoi.label}</strong>
      <span class="num muted">{fmtArea(session.aoiInfo.areaKm2)}{session.analysis ? ` · ${session.analysis.aoi.nCells.toLocaleString('en-US')} cells @ L${session.analysis.aoi.level}` : ''}</span>
    </div>
  {/if}

  {#if overlay && session.aoi}
    <MapLegend
      mode={session.overlay}
      domain={overlay.domain}
      month={focusLabel}
      {readout}
      onmode={(m) => session.setOverlay(m)}
    />
  {/if}

  <LiveControl shown={liveShown} />

  {#if clim && !session.aoi}
    <p class="clim-legend small"><span class="swatch" aria-hidden="true"></span>{clim.label}</p>
  {/if}

  {#if basemapFailed}
    <p class="basemap-note small muted">Basemap unavailable — showing graticule only.</p>
  {/if}

  {#if dropActive}
    <div class="drop" aria-hidden="true"><span>Drop a GeoJSON polygon to analyse it</span></div>
  {/if}
</div>

<style>
  .map-panel { position: relative; width: 100%; height: 100%; background: var(--bg-2); container: map / inline-size; }
  .map { position: absolute; inset: 0; }
  .toolbar {
    position: absolute; top: 12px; left: 12px; right: 12px; z-index: 3;
    display: flex; flex-wrap: wrap; gap: 8px; pointer-events: none;
  }
  .group {
    display: inline-flex; pointer-events: auto; background: var(--overlay-bg);
    border: 1px solid var(--rule-strong); border-radius: var(--radius); backdrop-filter: blur(6px); box-shadow: var(--shadow-sm);
  }
  .tool {
    display: inline-flex; align-items: center; gap: 6px; min-height: 34px; min-width: 34px; padding: 0 10px;
    background: transparent; border: 0; border-right: 1px solid var(--rule); color: var(--ink-2); cursor: pointer; font-size: var(--fs-md);
    transition: background 0.15s, color 0.15s;
  }
  .tool:last-of-type { border-right: 0; }
  .tool:hover:not(:disabled) { color: var(--ink); background: var(--surface-2); }
  .tool[aria-pressed='true'], .tool.on { color: var(--ink); background: var(--surface-3); box-shadow: inset 0 -2px 0 var(--ink-2); }
  .tool:focus-visible { outline-offset: -2px; }
  .tool:disabled { opacity: 0.4; cursor: not-allowed; }
  @container map (max-width: 900px) { .lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; } }

  .popover {
    position: absolute; top: 58px; left: 12px; z-index: 4; width: min(360px, calc(100% - 24px));
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 12px;
  }
  .presets ul { list-style: none; margin: 6px 0 0; padding: 0; }
  .preset {
    display: grid; width: 100%; text-align: left; gap: 2px; padding: 8px 10px; background: transparent; border: 0;
    border-top: 1px solid var(--rule); cursor: pointer; color: var(--ink);
  }
  .preset:hover { background: var(--surface-2); }
  .preset[aria-current='true'] { box-shadow: inset 2px 0 0 var(--accent); }
  .pt { font-weight: 600; font-size: var(--fs-base); }
  .ps { color: var(--ink-3); font-size: var(--fs-sm); }

  .hint, .notice {
    position: absolute; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 3; max-width: calc(100% - 24px);
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); padding: 8px 12px;
    font-size: var(--fs-md); color: var(--ink-2); box-shadow: var(--shadow-sm);
  }
  .notice { bottom: auto; top: 60px; display: flex; gap: 10px; align-items: center; color: var(--ink); border-color: var(--warning); }
  .x { background: none; border: 0; color: var(--ink-2); font-size: 1.2rem; cursor: pointer; line-height: 1; }

  .aoi-chip {
    position: absolute; left: 12px; top: 60px; z-index: 2; display: grid; gap: 1px; max-width: 60%;
    background: var(--overlay-bg); border-left: 2px solid var(--accent);
    padding: 6px 10px; border-radius: 0 var(--radius) var(--radius) 0; font-size: var(--fs-sm); backdrop-filter: blur(6px);
  }
  .aoi-chip strong { font-size: var(--fs-base); font-weight: 600; }
  .aoi-chip .eyebrow { line-height: 1.1; }
  .clim-legend {
    position: absolute; left: 12px; bottom: 40px; z-index: 2; margin: 0; display: flex; align-items: center; gap: 8px;
    color: var(--ink-2); background: var(--overlay-bg); padding: 4px 10px; font-size: var(--fs-sm);
    border-radius: var(--radius); backdrop-filter: blur(6px);
  }
  .swatch { width: 44px; height: 6px; border-radius: 2px; background: linear-gradient(90deg, #420a68, #932667, #dd513a, #fca50a, #fcffa4); }
  :global([data-theme='light']) .swatch { background: linear-gradient(90deg, #fcffa4, #fca50a, #dd513a, #932667, #420a68); }
  .basemap-note { position: absolute; top: 60px; right: 12px; z-index: 2; margin: 0; }
  .drop {
    position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; background: color-mix(in srgb, var(--bg) 70%, transparent);
    border: 2px dashed var(--ink-2); font-size: var(--fs-base); color: var(--ink);
  }
  :global(.maplibregl-ctrl-group) { background: var(--surface) !important; border: 1px solid var(--rule-strong); box-shadow: none !important; }
  :global(.maplibregl-ctrl-group button) { filter: var(--ctrl-filter, none); }
  :global([data-theme='dark'] .maplibregl-ctrl-group button .maplibregl-ctrl-icon) { filter: invert(0.9); }
  :global(.maplibregl-ctrl-scale) { background: color-mix(in srgb, var(--surface) 80%, transparent); color: var(--ink-2); border-color: var(--ink-3); }
  :global(.maplibregl-ctrl-attrib) { background: color-mix(in srgb, var(--surface) 80%, transparent) !important; color: var(--ink-3); font-size: var(--fs-xs); }
  :global(.maplibregl-ctrl-attrib a) { color: var(--ink-2); }
  :global(.h-live-popup) { z-index: 3; }
  :global(.h-live-popup .maplibregl-popup-content) {
    background: var(--surface); color: var(--ink); border: 1px solid var(--rule-strong); border-radius: var(--radius);
    box-shadow: var(--shadow-sm); padding: 10px 12px; font-size: var(--fs-sm);
  }
  :global(.h-live-popup.maplibregl-popup-anchor-bottom .maplibregl-popup-tip) { border-top-color: var(--rule-strong); }
  :global(.h-live-popup.maplibregl-popup-anchor-top .maplibregl-popup-tip) { border-bottom-color: var(--rule-strong); }
  :global(.h-live-popup .maplibregl-popup-close-button) { color: var(--ink-2); font-size: var(--fs-base); padding: 0 6px; }
  :global(.live-pop .lp-h) { margin: 0 0 6px; font-weight: 600; }
  :global(.live-pop dl) { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
  :global(.live-pop dt) { color: var(--ink-3); }
  :global(.live-pop dd) { margin: 0; font-family: var(--font-num); font-variant-numeric: tabular-nums; white-space: nowrap; }
  :global(.live-pop .lp-note) { margin: 6px 0 0; color: var(--ink-3); font-size: var(--fs-xs); }
</style>
