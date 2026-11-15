<script lang="ts">
  // Global fire pulse: 26 years of harmonized monthly fire activity on a WebGPU globe (Canvas 2D fallback).
  // Four ways to colour it: Activity and Anomaly play the months; Fire clock (when fire normally peaks) and
  // Trend (2001–2025, across the MODIS -> VIIRS hand-over) are fixed pictures of the whole record.
  // Drag/zoom the globe; click land to analyse 150 km around it, or a watch ring to analyse that cluster.
  import { onDestroy, onMount } from 'svelte'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { circlePolygon } from '../geo'
  import { fmtNum, monthIso, MONTHS_INITIAL, MONTHS_LONG, parseMonthIso } from '../format'
  import { seqLut, divLut } from '../color'
  import {
    cellIndex, decodeSigned, decodeValue, LAYER, loadClim, loadLand, loadMeta, loadRegime, moyOfM, S_ACT, S_CONC, S_LEN, S_PEAK,
    S_PEAK2, T_ACT, T_FLAG, T_MODIS, T_P, T_SLOPE, W, YearCache, yearOfM, type OverviewMeta, type RegimeBytes, type YearBytes,
  } from './data'
  import { clockPale, globeLayout, isStatic, palette, PULSE_MODES, TREND_SHOW, type Frame, type PulseMode, type PulseRenderer } from './shared'
  import { monthColor } from './cyclic'
  import { loadWatch, rankWords, type WatchCluster, type WatchDoc } from './watch'
  import { clusterAoi } from '../data/watch'
  import Timeline from './Timeline.svelte'
  import BrandMark from '../brand/BrandMark.svelte'
  import Patch from '../brand/Patch.svelte'

  let { onclose }: { onclose: () => void } = $props()

  const AOI_KM = 150
  const SPEEDS = [{ label: '½×', mps: 3 }, { label: '1×', mps: 6 }, { label: '2×', mps: 12 }, { label: '4×', mps: 24 }]
  const MODE_LABEL: Record<PulseMode, string> = { activity: 'Activity', anomaly: 'Anomaly', clock: 'Fire clock', trend: 'Trend' }
  const MODE_TITLE: Record<PulseMode, string> = {
    activity: 'Fire activity month by month',
    anomaly: 'This month compared with the 2003–2022 median of the same month',
    clock: 'When fire normally peaks (static)',
    trend: 'Change 2001–2025 across the MODIS → VIIRS hand-over (static)',
  }

  type Readout = { main: string; details: string[]; swatch?: string; hint: string }

  let host: HTMLDivElement
  let closeBtn: HTMLButtonElement
  let ringSvg: SVGSVGElement | null = $state(null)
  let meta = $state.raw<OverviewMeta | null>(null)
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let error = $state('')
  let kind = $state<'webgpu' | 'canvas' | null>(null)
  let fallbackWhy = $state('')
  let playhead = $state(0)
  let playing = $state(false)
  let speed = $state(1)
  let mode = $state<PulseMode>(hashMode())
  let has = $state({ clock: false, trend: false })
  let watch = $state.raw<WatchDoc | null>(null)
  let hover = $state<{ x: number; y: number; lon: number; lat: number; land: boolean; r: Readout } | null>(null)
  let ringHover = $state<{ x: number; y: number; c: WatchCluster } | null>(null)
  let notice = $state('')

  let renderer: PulseRenderer | null = null
  let canvas: HTMLCanvasElement | null = null
  let cache: YearCache
  let clim: YearBytes
  let land: { w: number; h: number; px: Uint8Array }
  let regime: RegimeBytes = { season: null, trend: null, trendRange: 10 }
  // camera (plain fields: changed every frame, no reactivity needed)
  const cam = { lon0: -18, lat0: -8, zoom: 1, vlon: 0, vlat: 0 }
  let autoRotate = !themeState.reducedMotion
  let raf = 0, last = 0, dirty = true, gpuRetries = 0
  let lastHashM = -1, lastHashAt = 0

  const mFirst = $derived(meta?.m_first ?? 0)
  const mEnd = $derived(meta ? Math.min(meta.m_last, meta.m_last_data ?? meta.m_last) : 0)
  const cur = $derived(Math.floor(playhead))
  const total = $derived(meta ? meta.global_monthly[cur - meta.m_first] ?? 0 : 0)
  const regional = $derived(meta?.scope?.startsWith('regional') ? meta.scope.replace(/^regional:\s*/, '') : '')
  const still = $derived(isStatic(mode))
  const baseline = $derived(meta ? `${meta.clim.baseline[0]}–${meta.clim.baseline[1]}` : '')
  const trendYears = $derived(meta?.trend ? `${meta.trend.years[0]}–${meta.trend.years[meta.trend.years.length - 1]}` : '')
  const watchM = $derived(watch ? parseMonthIso(watch.month) : null)
  const watchClusters = $derived(watch ? watch.windows.month.clusters : [])
  const ringsOn = $derived(status === 'ready' && !still && watchM != null && cur === watchM && watchClusters.length > 0)
  // geodesic circles around each watch cluster, projected every rendered frame
  const ringPts = $derived(watchClusters.map((c) => circlePolygon(c.circle.lon, c.circle.lat, c.circle.km, 72)[0]))

  function hashMode(): PulseMode {
    const m = new URLSearchParams(location.hash.slice(1)).get('mode') as PulseMode | null
    return m && PULSE_MODES.includes(m) ? m : 'activity'
  }
  const available = (m: PulseMode) => (m === 'clock' ? has.clock : m === 'trend' ? has.trend : true)

  // ---------------------------------------------------------------- setup

  async function makeRenderer(theme = themeState.theme) {
    renderer?.destroy()
    canvas?.remove()
    canvas = document.createElement('canvas')
    canvas.className = 'stage'
    canvas.setAttribute('aria-hidden', 'true')
    host.prepend(canvas)
    const noGpu = new URLSearchParams(location.search).has('nogpu')
    if (!noGpu && gpuRetries < 2) {
      try {
        const { createGpuRenderer } = await import('./gpu')
        renderer = await createGpuRenderer(canvas, theme, clim, land, regime, (why) => {
          console.warn('WebGPU device lost:', why)
          gpuRetries++
          void makeRenderer()
        })
        kind = 'webgpu'
      } catch (e) {
        fallbackWhy = e instanceof Error ? e.message : String(e)
        canvas.remove()
        canvas = document.createElement('canvas')
        canvas.className = 'stage'
        canvas.setAttribute('aria-hidden', 'true')
        host.prepend(canvas)
      }
    } else fallbackWhy = noGpu ? 'disabled by ?nogpu' : 'WebGPU device lost repeatedly'
    if (!renderer || renderer.kind !== 'webgpu') {
      const { createFlatRenderer } = await import('./flat')
      renderer = createFlatRenderer(canvas, theme, clim, land, regime)
      kind = 'canvas'
      autoRotate = false
    }
    renderer.resize()
    dirty = true
  }

  onMount(() => {
    const ctrl = new AbortController()
    document.body.style.overflow = 'hidden'
    closeBtn?.focus()
    ;(async () => {
      try {
        const m = await loadMeta(ctrl.signal)
        cache = new YearCache(m)
        const end = Math.min(m.m_last, m.m_last_data ?? m.m_last)
        const fromHash = parseMonthIso(new URLSearchParams(location.hash.slice(1)).get('t') ?? '')
        playhead = fromHash != null ? Math.max(m.m_first, Math.min(end, fromHash)) : m.m_first
        let rg: RegimeBytes
        ;[clim, land, rg] = await Promise.all([loadClim(m, ctrl.signal), loadLand(m, ctrl.signal), loadRegime(m, ctrl.signal), cache.get(yearOfM(playhead))])
        regime = rg
        has = { clock: !!rg.season, trend: !!rg.trend }
        if (!available(mode)) mode = 'activity'
        meta = m
        await makeRenderer()
        status = 'ready'
        playing = fromHash == null && !isStatic(mode) && !themeState.reducedMotion
        prefetch()
        raf = requestAnimationFrame(tick)
        watch = await loadWatch(ctrl.signal)
      } catch (e) {
        if (ctrl.signal.aborted) return
        console.error(e)
        error = e instanceof Error ? e.message : String(e)
        status = 'error'
      }
    })()
    const ro = new ResizeObserver(() => { renderer?.resize(); dirty = true })
    ro.observe(host)
    const onVis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden && status === 'ready') { last = 0; raf = requestAnimationFrame(tick) }
    }
    document.addEventListener('visibilitychange', onVis)
    // the app (or the user) may change `t` / `mode` while the pulse is open: follow them
    const onHash = () => {
      if (status !== 'ready' || !meta) return
      const q = new URLSearchParams(location.hash.slice(1))
      if (q.get('view') !== 'pulse') return
      const t = parseMonthIso(q.get('t') ?? '')
      if (t != null && t !== Math.floor(playhead)) { playing = false; seek(t, false) }
      const m = hashMode()
      if (m !== mode && available(m)) { mode = m; if (isStatic(m)) playing = false; dirty = true }
    }
    addEventListener('hashchange', onHash)
    return () => {
      ctrl.abort()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      removeEventListener('hashchange', onHash)
    }
  })

  onDestroy(() => {
    cancelAnimationFrame(raf)
    renderer?.destroy()
    document.body.style.overflow = ''
    // `mode` belongs to the pulse: drop it once the pulse is closed (the app clears `view` and `t`)
    const q = new URLSearchParams(location.hash.slice(1))
    if (q.get('view') !== 'pulse' && q.has('mode')) {
      q.delete('mode')
      const h = q.toString().replace(/%2C/g, ',')
      history.replaceState(null, '', `${location.pathname}${location.search}${h ? `#${h}` : ''}`)
    }
  })

  // theme -> palette and ramps
  $effect(() => {
    const th = themeState.theme
    renderer?.setTheme(th)
    dirty = true
  })
  // rings appear / disappear with the month
  $effect(() => { void ringsOn; dirty = true })

  // ---------------------------------------------------------------- playback

  function prefetch() {
    const y = yearOfM(Math.floor(playhead))
    for (const yy of [y, y + 1, playing ? y + 2 : y - 1]) void cache.get(yy).catch((e) => console.warn('pulse year', yy, e))
  }

  function frame(): Frame | null {
    const a = Math.floor(playhead), b = Math.min(a + 1, mEnd)
    const A = cache.peek(yearOfM(a))
    if (!A) return null
    const B = cache.peek(yearOfM(b))
    return { lon0: cam.lon0, lat0: cam.lat0, zoom: cam.zoom, la: moyOfM(a), lb: B ? moyOfM(b) : moyOfM(a), a: A, b: B ?? A, t: B ? playhead - a : 0, mode }
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    if (playing && meta && !still) {
      const prevYear = yearOfM(Math.floor(playhead))
      let next = playhead + SPEEDS[speed].mps * dt
      if (next >= mEnd) next = mFirst                       // loop the record
      const need = [yearOfM(Math.floor(next)), yearOfM(Math.min(Math.floor(next) + 1, mEnd))]
      if (need.every((y) => cache.has(y))) playhead = next   // otherwise hold until the atlas arrives
      if (yearOfM(Math.floor(playhead)) !== prevYear) prefetch()
      dirty = true
      syncHash(false)
    }
    if (!dragging && kind === 'webgpu') {
      if (Math.abs(cam.vlon) + Math.abs(cam.vlat) > 0.05) {
        cam.lon0 += cam.vlon * dt; cam.lat0 = clampLat(cam.lat0 + cam.vlat * dt)
        const k = Math.exp(-dt * 2.6)
        cam.vlon *= k; cam.vlat *= k
        dirty = true
      } else if (autoRotate) { cam.lon0 -= 3.5 * dt; dirty = true }
    }
    if (dirty && renderer) {
      const f = frame()
      if (f) { renderer.render(f); drawRings(f); dirty = false }
    }
  }

  const clampLat = (v: number) => Math.max(-75, Math.min(75, v))

  function seek(m: number, settle = true) {
    playhead = Math.max(mFirst, Math.min(mEnd, m))
    prefetch()
    dirty = true
    if (settle) syncHash(true)
  }
  function step(months: number) { playing = false; seek(Math.floor(playhead) + months) }
  function togglePlay() {
    if (still) return
    if (!playing && Math.floor(playhead) >= mEnd) playhead = mFirst
    playing = !playing
    if (!playing) syncHash(true)
  }
  function setMode(m: PulseMode) {
    if (!available(m) || m === mode) return
    mode = m
    if (isStatic(m)) playing = false
    hover = null; ringHover = null
    dirty = true
    syncHash(true)
  }
  function showUnusual() {
    if (watchM == null) return
    playing = false
    if (mode !== 'anomaly') mode = 'anomaly'
    seek(watchM)
    stopAuto()
    const c = watchClusters[0]
    if (c && kind === 'webgpu') { cam.lon0 = c.centroid[0]; cam.lat0 = clampLat(c.centroid[1] * 0.6); dirty = true }
  }

  function syncHash(force: boolean) {
    const m = Math.floor(playhead)
    const now = performance.now()
    if (!force && (m === lastHashM || now - lastHashAt < 400)) return
    lastHashM = m; lastHashAt = now
    const q = new URLSearchParams(location.hash.slice(1))
    q.set('view', 'pulse'); q.set('t', monthIso(m))
    if (mode === 'activity') q.delete('mode'); else q.set('mode', mode)
    history.replaceState(null, '', `${location.pathname}${location.search}#${q.toString().replace(/%2C/g, ',')}`)
  }

  // ---------------------------------------------------------------- watch rings

  function drawRings(f: Frame) {
    if (!ringSvg || !renderer) return
    const paths = ringSvg.querySelectorAll<SVGPathElement>('path[data-i]')
    for (const el of paths) {
      const i = +el.dataset.i!
      const pts = ringPts[i]
      if (!ringsOn || !pts) { el.setAttribute('d', ''); continue }
      let d = '', pen = false
      for (const [lo, la] of pts) {
        const [x, y, z] = renderer.project(lo, la, f)
        if (z > 0.02) { d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; pen = true } else pen = false
      }
      el.setAttribute('d', d)
    }
  }
  function ringEnter(e: PointerEvent, c: WatchCluster) {
    const r = host.getBoundingClientRect()
    ringHover = { x: e.clientX - r.left, y: e.clientY - r.top, c }
    hover = null
  }
  function analyseCluster(c: WatchCluster) {
    onclose()
    session.setAoi(clusterAoi(c, watchM!), { focusM: watchM })
  }

  // ---------------------------------------------------------------- pointer

  const pointers = new Map<number, { x: number; y: number }>()
  let dragging = false, moved = 0, pinch = 0, lastMove = 0

  function radiusPx() {
    const w = host.clientWidth, h = host.clientHeight
    return globeLayout(w, h, cam.zoom).r
  }
  function stopAuto() { autoRotate = false }

  function onDown(e: PointerEvent) {
    if (status !== 'ready') return
    try { host.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragging = true; moved = 0; cam.vlon = 0; cam.vlat = 0
    stopAuto()
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }
  function onMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId)
    if (p && dragging) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      p.x = e.clientX; p.y = e.clientY
      moved += Math.abs(dx) + Math.abs(dy)
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinch > 0) zoomBy(d / pinch)
        pinch = d
      } else if (kind === 'webgpu') {
        const k = 180 / Math.PI / radiusPx()
        cam.lon0 -= dx * k; cam.lat0 = clampLat(cam.lat0 + dy * k)
        const now = performance.now(), dts = Math.max(0.008, (now - lastMove) / 1000)
        lastMove = now
        if (!themeState.reducedMotion) { cam.vlon = (-dx * k) / dts; cam.vlat = (dy * k) / dts }
        dirty = true
      }
      hover = null
      return
    }
    updateHover(e)
  }
  function onUp(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (pointers.size > 0) return
    dragging = false
    if (performance.now() - lastMove > 80) { cam.vlon = 0; cam.vlat = 0 }
    if (moved < 5) analyseAt(e)
  }
  function onWheel(e: WheelEvent) {
    if (kind !== 'webgpu') return
    e.preventDefault()
    stopAuto()
    zoomBy(Math.exp(-e.deltaY * 0.0015))
  }
  function zoomBy(f: number) {
    if (kind !== 'webgpu') return
    cam.zoom = Math.max(0.7, Math.min(8, cam.zoom * f))
    dirty = true
  }

  function isLand(lon: number, lat: number) {
    const lx = Math.min(land.w - 1, Math.floor(((lon + 180) / 360) * land.w)), ly = Math.min(land.h - 1, Math.floor(((90 - lat) / 180) * land.h))
    return land.px[ly * land.w + lx] > 100
  }
  function sample(lon: number, lat: number) {
    const m = Math.floor(playhead)
    const A = cache.peek(yearOfM(m))
    const c = cellIndex(lon, lat), k = moyOfM(m) * LAYER
    return {
      value: A ? decodeValue(A[k + c], meta!.cap) : 0,
      normal: decodeValue(clim[k + c], meta!.cap),
      land: isLand(lon, lat),
      /** any activity within ~1 deg (the 150 km circle) this month */
      active: !!A && [-2, -1, 0, 1, 2].some((dy) => [-2, -1, 0, 1, 2].some((dx) => {
        const y = Math.floor(c / W) + dy, x = (((c % W) + dx) % W + W) % W
        return y >= 0 && y < 360 && A[k + y * W + x] > 0
      })),
    }
  }

  const concWords = (r: number) =>
    r >= 0.8 ? 'one short, sharp season' : r >= 0.55 ? 'a clear fire season' : r >= 0.3 ? 'a broad fire season' : 'fire spread through the year'
  const pct = (v: number, lim: number) => `${v <= -lim + 1e-6 ? '≤ ' : v >= lim - 1e-6 ? '≥ ' : ''}${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} %`
  const fmtRatio = (r: number) => `${r >= 10 ? Math.round(r) : r.toFixed(1)}×`
  const fmtP = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`)

  function readout(lon: number, lat: number): Readout {
    const s = sample(lon, lat)
    const hint = s.land ? 'Click to analyse this area' : 'Open water'
    const c = cellIndex(lon, lat)
    if (mode === 'clock' && regime.season && meta?.season) {
      const g = regime.season
      const act = decodeValue(g[S_ACT * LAYER + c], meta.season.cap)
      if (act < 0.5) return { main: 'Little or no fire', details: [`≈ ${fmtNum(act)} active-fire cell-days a year (${baseline} mean)`], hint }
      const p1 = g[S_PEAK * LAYER + c] - 1, p2 = g[S_PEAK2 * LAYER + c] - 1, r = g[S_CONC * LAYER + c] / 255, len = g[S_LEN * LAYER + c]
      return {
        main: p2 >= 0 ? `Two seasons: ${MONTHS_LONG[p1]} and ${MONTHS_LONG[p2]}` : `Peaks in ${MONTHS_LONG[p1]}`,
        swatch: monthColor(p1, themeState.theme),
        details: [
          `${concWords(r)} (concentration ${r.toFixed(2)})`,
          `${Math.round((meta.season.share ?? 0.8) * 100)} % of fire within ${len} month${len === 1 ? '' : 's'}`,
          `≈ ${fmtNum(act)} AFCD-M a year (${baseline} mean)`,
        ],
        hint,
      }
    }
    if (mode === 'trend' && regime.trend && meta?.trend) {
      const g = regime.trend, lim = regime.trendRange
      const flag = g[T_FLAG * LAYER + c]
      const base = decodeValue(g[T_ACT * LAYER + c], meta.trend.cap)
      if (!flag) return { main: 'No trend estimated', details: [`Too little fire nearby (under ${meta.trend.min_baseline_afcd_per_yr} AFCD-M a year in the 1.5° window)`], hint }
      const v = decodeSigned(g[T_SLOPE * LAYER + c], lim) ?? 0
      const p = 1 - (g[T_P * LAYER + c] - 1) / 254
      const mo = decodeSigned(g[T_MODIS * LAYER + c], lim)
      return {
        main: `${pct(v, lim)} a year, ${trendYears}`,
        details: [
          flag === 2 ? `Significant after FDR correction (${fmtP(p)})` : `Not significant after FDR correction (${fmtP(p)})`,
          mo == null ? 'MODIS-only record: no estimate' : `MODIS-only record: ${pct(mo, lim)} a year`,
          `Normal ≈ ${fmtNum(base)} AFCD-M a year in this cell (${baseline})`,
        ],
        hint,
      }
    }
    return {
      main: `${s.value > 0 ? `≈ ${fmtNum(s.value)}` : '0'} AFCD-M`,
      details: [`normal ${s.normal > 0 ? `≈ ${fmtNum(s.normal)}` : '0'} (${baseline} median)`],
      hint,
    }
  }
  function updateHover(e: PointerEvent) {
    if (!renderer || status !== 'ready' || e.pointerType === 'touch') return
    const r = host.getBoundingClientRect()
    const f = frame()
    const ll = f && renderer.pick(e.clientX - r.left, e.clientY - r.top, f)
    if (!ll) { hover = null; return }
    ringHover = null
    hover = { x: e.clientX - r.left, y: e.clientY - r.top, lon: ll[0], lat: ll[1], land: isLand(ll[0], ll[1]), r: readout(ll[0], ll[1]) }
  }

  function analyseAt(e: PointerEvent) {
    if (!renderer) return
    const r = host.getBoundingClientRect()
    const f = frame()
    const ll = f && renderer.pick(e.clientX - r.left, e.clientY - r.top, f)
    if (!ll) return
    const [lon, lat] = [+ll[0].toFixed(3), +ll[1].toFixed(3)]
    const s = sample(lon, lat)
    if (!s.land) { notice = 'That is open water — click on land to analyse an area.'; setTimeout(() => (notice = ''), 2600); return }
    const m = Math.floor(playhead)
    onclose()
    session.setAoi(
      { rings: circlePolygon(lon, lat, AOI_KM), shape: { kind: 'circle', lon, lat, km: AOI_KM }, label: `${AOI_KM} km around ${lat.toFixed(2)}°, ${lon.toFixed(2)}°` },
      s.active && !still ? { focusM: m } : {},
    )
  }

  // ---------------------------------------------------------------- keyboard

  function onKey(e: KeyboardEvent) {
    if (status !== 'ready') { if (e.key === 'Escape') onclose(); return }
    const t = e.target instanceof HTMLElement ? e.target : null
    const control = t?.closest('button, select, input')
    if (still && e.key !== 'Escape') return
    switch (e.key) {
      case ' ':
        if (control) return
        e.preventDefault(); togglePlay(); break
      case 'ArrowLeft': case 'ArrowRight':
        if (t?.tagName === 'SELECT') return
        e.preventDefault(); step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 12 : 1)); break
      case 'Home': e.preventDefault(); playing = false; seek(mFirst); break
      case 'End': e.preventDefault(); playing = false; seek(mEnd); break
      case 'Escape': onclose(); break
      default: return
    }
    stopAuto()
  }

  // ---------------------------------------------------------------- legend

  const gradient = (lut: string[], from = 0, to = 255) =>
    `linear-gradient(90deg, ${Array.from({ length: 17 }, (_, i) => lut[Math.round(from + (i / 16) * (to - from))]).join(', ')})`
  const seqBar = $derived(gradient(seqLut(themeState.theme)))
  const divBar = $derived(gradient(divLut(themeState.theme)))
  const ticks = $derived(meta ? [1, 10, 100].filter((v) => v < meta!.cap * 0.6).map((v) => ({ v, t: (v / meta!.cap) ** 0.25 })).concat([{ v: meta.cap, t: 1 }]) : [])
  const trendTicks = [-TREND_SHOW, -TREND_SHOW / 2, 0, TREND_SHOW / 2, TREND_SHOW]
  // clock key: 12 ring segments, January at the top, clockwise; inner ring = the same months when spread out
  const arc = (k: number, r0: number, r1: number) => {
    const a0 = ((k - 0.5) / 12) * 2 * Math.PI + 0.012, a1 = ((k + 0.5) / 12) * 2 * Math.PI - 0.012
    const p = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`
    return `M${p(r1, a0)}A${r1},${r1} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 0 0 ${p(r0, a0)}Z`
  }
  const clockKeys = $derived(Array.from({ length: 12 }, (_, k) => ({
    k, d: arc(k, 31, 45), di: arc(k, 23, 29), fill: monthColor(k, themeState.theme), pale: paleOf(monthColor(k, themeState.theme)),
    lx: 53 * Math.sin((k / 12) * 2 * Math.PI), ly: -53 * Math.cos((k / 12) * 2 * Math.PI),
  })))
  const g = $derived(meta?.trend?.global)
  /** the "spread through the year" version of a month colour (same mix as the renderers at concentration ~0.3) */
  function paleOf(css: string) {
    const c = css.match(/[\d.]+/g)!.map(Number), pl = palette(themeState.theme).pale, k = clockPale(0.3)
    return `rgb(${[0, 1, 2].map((i) => Math.round(c[i] + (pl[i] * 255 - c[i]) * k)).join(', ')})`
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="pulse" role="dialog" aria-modal="true" aria-labelledby="pulse-h">
  <div
    class="host" bind:this={host}
    onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp}
    onpointerleave={() => (hover = null)} onwheel={onWheel}
    role="application" aria-label="Globe of monthly fire activity. Drag to rotate, scroll to zoom, click land to analyse that area."
    class:flat={kind === 'canvas'}
  ></div>

  {#if status === 'ready'}
    <svg class="rings" bind:this={ringSvg} aria-hidden={!ringsOn} class:on={ringsOn}>
      {#each watchClusters as c, i (c.id)}
        <g class="ring" role="button" tabindex={ringsOn ? 0 : -1} aria-label={`${c.label}: unusual fire, about ${fmtRatio(c.ratio)} normal. Analyse the area around it.`}
          onpointerenter={(e) => ringEnter(e, c)} onpointermove={(e) => ringEnter(e, c)} onpointerleave={() => (ringHover = null)}
          onclick={() => analyseCluster(c)} onkeydown={(e) => { if (e.key === 'Enter') analyseCluster(c) }}>
          <path class="hit" data-i={i} d="" />
          <path class="line" data-i={i} d="" />
        </g>
      {/each}
    </svg>
  {/if}

  <header class="top">
    <div class="title">
      <p class="lockup"><BrandMark size={18} /><span class="wm">Harmony</span></p>
      <p class="eyebrow" id="pulse-h">Global fire pulse · harmonized AFCD-M · 0.5° cells</p>
      {#if meta}
        {#if mode === 'clock'}
          <p class="when"><span class="mo">Fire clock</span></p>
          <p class="sub">When fire normally peaks · mean year {baseline}</p>
        {:else if mode === 'trend'}
          <p class="when num"><span class="mo">Trend</span> <span class="yr">{trendYears}</span></p>
          <p class="sub">Change in harmonized fire activity across the MODIS → VIIRS hand-over</p>
        {:else}
          <p class="when num" aria-live="off"><span class="mo">{MONTHS_LONG[moyOfM(cur)]}</span> <span class="yr">{yearOfM(cur)}</span></p>
          <p class="sub"><span class="num">{fmtNum(total)}</span> active-fire cell-days{regional ? ' in the regional build' : ' worldwide'}{meta.last_month_partial && cur === meta.m_last ? ' · month in progress' : ''}</p>
        {/if}
        {#if regional}<p class="scope small">Regional data build: {regional}. The full global record replaces it when the pipeline finishes.</p>{/if}
      {/if}
    </div>
    <div class="actions">
      {#if kind === 'webgpu'}
        <span class="chip" title="Rendered with WebGPU">WebGPU</span>
      {:else if kind === 'canvas'}
        <span class="chip warn" title={fallbackWhy}>Canvas fallback</span>
      {/if}
      <button class="btn" bind:this={closeBtn} onclick={onclose} aria-label="Close the global pulse (Escape)">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        Close
      </button>
    </div>
  </header>

  {#if status === 'loading'}
    <p class="center muted" role="status">Loading 26 years of fire seasons…</p>
  {:else if status === 'error'}
    <div class="center" role="alert">
      <p>The global overview is not available: {error}</p>
      <p class="small muted">Run <code>uv run python -m harmony_pipeline.cli overview</code> to build it.</p>
    </div>
  {/if}

  {#if status === 'ready' && meta}
    <div class="patch" aria-hidden="true"><Patch size="100%" /></div>
    <aside class="legend" class:wide={still} aria-label="Legend">
      {#if mode === 'activity'}
        <p class="eyebrow">Activity · AFCD-M per cell-month</p>
        <div class="bar" style:background={seqBar}></div>
        <div class="ticks num">
          {#each ticks as t (t.v)}<span style:left={`${t.t * 100}%`}>{t.v >= meta.cap ? `${fmtNum(t.v)}+` : t.v}</span>{/each}
        </div>
      {:else if mode === 'anomaly'}
        <p class="eyebrow">Anomaly · vs {baseline} median of the month</p>
        <div class="bar" style:background={divBar}></div>
        <div class="ends small"><span>below normal</span><span>above normal</span></div>
      {:else if mode === 'clock'}
        <p class="eyebrow">Fire clock · peak month</p>
        <div class="clock">
          <svg viewBox="-62 -62 124 124" width="118" height="118" role="img" aria-label="Colour key: one colour per month, January at the top, clockwise">
            {#each clockKeys as m (m.k)}
              <path d={m.d} fill={m.fill} />
              <path d={m.di} fill={m.pale} />
              <text x={m.lx} y={m.ly} class="mi">{MONTHS_INITIAL[m.k]}</text>
            {/each}
          </svg>
          <div class="keys small">
            <p>Colour = the month fire normally peaks; paler = fire spread through the year.</p>
            <p class="row"><span class="sw striped" style:--a={monthColor(1, themeState.theme)} style:--b={monthColor(7, themeState.theme)}></span>two seasons (stripes = the second)</p>
            <p class="muted">Mean of {baseline}. Faded where fire is rare.</p>
          </div>
        </div>
      {:else}
        <p class="eyebrow">Trend {trendYears} · % of the {baseline} mean per year</p>
        <div class="bar" style:background={divBar}></div>
        <div class="ticks num">
          {#each trendTicks as v, i (v)}<span style:left={`${(i / (trendTicks.length - 1)) * 100}%`}>{v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`}</span>{/each}
        </div>
        <div class="ends small"><span>falling</span><span>rising</span></div>
        <p class="row small"><span class="sw solid"></span>significant (Mann–Kendall, FDR 5 %): solid</p>
        <p class="row small tight"><span class="sw hatched"></span>not significant: muted, hatched</p>
        {#if g}
          <p class="small muted note">Theil–Sen slope of annual totals, 1.5° window. Worldwide <span class="num">{pct(g.all_years.pct_per_yr, 99)}</span>/yr;
            <span class="num">{pct(g.without_viirs_years.pct_per_yr, 99)}</span>/yr without the VIIRS years ({meta.trend!.switch_year}–).</p>
        {/if}
      {/if}
      {#if ringsOn}
        <p class="small watchnote"><span class="ringkey" aria-hidden="true"></span>Rings: where fire is most unusual this month — hover for details, click to analyse.</p>
      {:else if watch && watchM != null && !still}
        <button class="linkbtn small" onclick={showUnusual}>Where is fire unusual in {MONTHS_LONG[moyOfM(watchM)]} {yearOfM(watchM)}? →</button>
      {/if}
      <p class="small muted note">{kind === 'webgpu' ? 'Drag to rotate · scroll to zoom · ' : ''}click land to analyse {AOI_KM} km around it</p>
    </aside>

    {#if hover}
      <div class="tip small" style:left={`${hover.x + 14}px`} style:top={`${hover.y + 14}px`} aria-hidden="true">
        <span class="num">{Math.abs(hover.lat).toFixed(1)}°{hover.lat >= 0 ? 'N' : 'S'} {Math.abs(hover.lon).toFixed(1)}°{hover.lon >= 0 ? 'E' : 'W'}</span>
        <strong class="main">{#if hover.r.swatch}<span class="dot" style:background={hover.r.swatch}></span>{/if}{hover.r.main}</strong>
        {#each hover.r.details as d (d)}<span>{d}</span>{/each}
        <span class="muted">{hover.r.hint}</span>
      </div>
    {/if}
    {#if ringHover && watchM != null}
      {@const c = ringHover.c}
      <div class="tip small" style:left={`${ringHover.x + 14}px`} style:top={`${ringHover.y + 14}px`} aria-hidden="true">
        <span class="eyebrow">Unusual fire · #{c.rank}</span>
        <strong class="main">{c.label}</strong>
        <span><span class="num">≈ {fmtNum(c.afcd)}</span> AFCD-M · {c.normal_near_zero ? 'normally almost none' : `about ${fmtRatio(c.ratio)} normal`}</span>
        <span>{rankWords(c.record_rank, c.record_years, MONTHS_LONG[moyOfM(watchM)])}{c.record_rank > 1 ? ` (most: ${c.record_max_year})` : ''}</span>
        <span class="muted"><span class="num">{Math.round(c.area_km2).toLocaleString('en-US')}</span> km²{c.biome ? ` · ${c.biome}` : ''}</span>
        <span class="muted">Click to analyse the area around it</span>
      </div>
    {/if}

    {#if notice}<p class="notice small" role="status">{notice}</p>{/if}

    <footer class="controls">
      {#if still}
        <p class="static small">
          {mode === 'clock' ? `A typical year (${baseline} mean), not a month: there is no timeline.` : `One number per place for ${trendYears}: there is no timeline.`}
          <span class="muted">Activity and Anomaly play the record month by month.</span>
        </p>
      {:else}
        <button class="btn play" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} aria-keyshortcuts="Space">
          {#if playing}
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 2v10M10.5 2v10" stroke="currentColor" stroke-width="2.2" /></svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.8v10.4L12 7z" fill="currentColor" /></svg>
          {/if}
        </button>
        <div class="seg" role="group" aria-label="Playback speed">
          {#each SPEEDS as s, i (s.label)}
            <button aria-pressed={speed === i} onclick={() => (speed = i)} title={`${s.mps} months per second`}>{s.label}</button>
          {/each}
        </div>
        <Timeline m0={mFirst} m1={mEnd} totals={meta.global_monthly} switchM={meta.default_switch_m} value={playhead}
          onseek={(m, done) => { playing = false; seek(m, done); stopAuto() }} />
      {/if}
      <div class="seg modes" role="group" aria-label="Colour by">
        {#each PULSE_MODES as m (m)}
          <button aria-pressed={mode === m} disabled={!available(m)} onclick={() => setMode(m)}
            title={available(m) ? MODE_TITLE[m] : 'Not in this data build (re-run the overview stage)'}>{MODE_LABEL[m]}</button>
        {/each}
      </div>
    </footer>
  {/if}
</div>

<style>
  .pulse { position: fixed; inset: 0; z-index: 60; background: var(--bg); color: var(--ink); overflow: hidden; }
  .host { position: absolute; inset: 0; cursor: grab; touch-action: none; }
  .host:active { cursor: grabbing; }
  .host.flat { cursor: crosshair; }
  .host :global(canvas.stage) { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

  .rings { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1; }
  .ring { pointer-events: none; cursor: pointer; outline: none; }
  .rings.on .ring { pointer-events: auto; }
  .ring .hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
  .ring .line { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 5 3; opacity: 0.9; pointer-events: none; }
  .ring:hover .line, .ring:focus-visible .line { stroke-width: 2.4; stroke-dasharray: none; opacity: 1; }

  .top { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: flex-start; padding: 22px 28px; pointer-events: none; z-index: 2; }
  .title, .actions { pointer-events: auto; }
  .lockup { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--ink); }
  .wm { font-family: var(--font-display); font-weight: 500; font-size: var(--fs-sm); letter-spacing: var(--track-wordmark); text-transform: uppercase; }
  .patch { position: absolute; left: 28px; bottom: 104px; width: 96px; aspect-ratio: 1; opacity: 0.9; pointer-events: none; }
  .when { margin: 6px 0 2px; font-size: clamp(2.2rem, 4.6vw, 3.6rem); line-height: 1; letter-spacing: -0.04em; }
  .when .mo { font-family: var(--font-ui); font-weight: 600; letter-spacing: -0.035em; }
  .when .yr { color: var(--accent-ink); }
  .sub { color: var(--ink-2); margin: 8px 0 0; max-width: 44ch; }
  .scope { color: var(--ink-3); max-width: 46ch; margin-top: 4px; }
  .actions { display: flex; gap: 10px; align-items: center; }
    .actions .btn { background: color-mix(in srgb, var(--surface) 70%, transparent); }

  .center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 4px; }

  .legend { position: absolute; right: 28px; bottom: 104px; width: 260px; z-index: 2; }
  .legend.wide { width: 340px; }
  .bar { height: 8px; border-radius: 2px; margin-top: 6px; }
  .ticks { position: relative; height: 16px; font-size: var(--fs-xs); color: var(--ink-3); }
  .ticks span { position: absolute; transform: translateX(-50%); top: 2px; }
  .ticks span:first-child { transform: none; }
  .ticks span:last-child { transform: translateX(-100%); }
  .ends { display: flex; justify-content: space-between; color: var(--ink-3); margin-top: 3px; }
  .note { margin-top: 10px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; color: var(--ink-2); }
  .sw { display: inline-block; width: 16px; height: 10px; border-radius: 2px; flex: none; }
  .sw.solid { background: var(--accent); }
  .sw.hatched { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 62%, transparent) 0 2.7px, color-mix(in srgb, var(--accent) 20%, transparent) 2.7px 6px); }
  .sw.striped { background: repeating-linear-gradient(135deg, var(--b) 0 2.4px, var(--a) 2.4px 6px); }

  .clock { display: flex; gap: 12px; align-items: center; margin-top: 8px; }
  .clock svg { flex: none; overflow: visible; }
  .clock .mi { font: 500 9px var(--font-display); letter-spacing: 0.04em; fill: var(--ink-2); text-anchor: middle; dominant-baseline: central; }
  .keys { display: grid; gap: 6px; color: var(--ink-2); }
  .keys p { margin: 0; }
  .keys .row { margin: 0; flex-wrap: nowrap; }
  .row.tight { margin-top: 4px; }

  .watchnote { display: flex; gap: 8px; align-items: center; color: var(--ink-2); margin-top: 10px; }
  .ringkey { width: 14px; height: 14px; border-radius: 50%; border: 1.4px dashed var(--accent); flex: none; }
  .linkbtn { margin-top: 10px; padding: 0; border: 0; background: none; color: var(--accent-ink); cursor: pointer; text-align: left; font: inherit; }
  .linkbtn:hover { text-decoration: underline; }
  .linkbtn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  .tip {
    position: absolute; z-index: 3; display: grid; gap: 1px; pointer-events: none; padding: 7px 10px; max-width: 300px;
    background: color-mix(in srgb, var(--surface) 92%, transparent); border: 1px solid var(--rule-strong); border-radius: var(--radius);
    box-shadow: var(--shadow); backdrop-filter: blur(6px);
  }
  .tip .main { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-top: 1px; }
  .tip .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 1px var(--rule-strong); }
  .notice { position: absolute; left: 50%; bottom: 104px; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--warning); border-radius: var(--radius); padding: 7px 12px; z-index: 2; }

  .controls {
    position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 16px; padding: 16px 28px 20px; z-index: 2;
    background: linear-gradient(to top, color-mix(in srgb, var(--bg) 92%, transparent) 40%, transparent);
  }
  .play { width: 40px; height: 40px; justify-content: center; padding: 0; border-color: var(--accent); color: var(--accent-ink); border-radius: 50%; }
  .play:hover { background: var(--accent-soft); }
  .controls .seg { flex: none; background: color-mix(in srgb, var(--surface) 70%, transparent); }
  .controls .modes { margin-left: auto; }
  .static { flex: 1; min-width: 0; margin: 0; color: var(--ink-2); min-height: 54px; display: flex; flex-direction: column; justify-content: center; gap: 2px; }

  @media (max-width: 760px), (max-height: 640px) { .patch { display: none; } }
  @media (max-width: 760px) {
    .top { padding: 14px 16px; }
    .legend, .legend.wide { left: 16px; right: 16px; width: auto; bottom: 150px; }
    .controls { flex-wrap: wrap; padding: 12px 16px 16px; gap: 10px; }
    .controls :global(.tl) { order: 5; flex-basis: 100%; }
    .controls .modes { margin-left: 0; }
  }
</style>
