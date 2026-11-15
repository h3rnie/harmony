<script lang="ts">
  // Global fire pulse: 26 years of harmonized monthly fire activity on a WebGPU globe (Canvas 2D fallback).
  // Drag/zoom the globe, play or scrub the record, switch to anomaly; click land to analyse 150 km around it.
  import { onDestroy, onMount } from 'svelte'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { circlePolygon } from '../geo'
  import { fmtNum, monthIso, MONTHS_LONG, parseMonthIso } from '../format'
  import { seqLut, divLut } from '../color'
  import { cellIndex, decodeValue, LAYER, loadClim, loadLand, loadMeta, moyOfM, W, YearCache, yearOfM, type OverviewMeta, type YearBytes } from './data'
  import { globeLayout, type Frame, type PulseMode, type PulseRenderer } from './shared'
  import Timeline from './Timeline.svelte'
  import BrandMark from '../brand/BrandMark.svelte'
  import Patch from '../brand/Patch.svelte'

  let { onclose }: { onclose: () => void } = $props()

  const AOI_KM = 150
  const SPEEDS = [{ label: '½×', mps: 3 }, { label: '1×', mps: 6 }, { label: '2×', mps: 12 }, { label: '4×', mps: 24 }]

  let host: HTMLDivElement
  let closeBtn: HTMLButtonElement
  let meta = $state.raw<OverviewMeta | null>(null)
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let error = $state('')
  let kind = $state<'webgpu' | 'canvas' | null>(null)
  let fallbackWhy = $state('')
  let playhead = $state(0)
  let playing = $state(false)
  let speed = $state(1)
  let mode = $state<PulseMode>('activity')
  let hover = $state<{ x: number; y: number; lon: number; lat: number; value: number; normal: number; land: boolean } | null>(null)
  let notice = $state('')

  let renderer: PulseRenderer | null = null
  let canvas: HTMLCanvasElement | null = null
  let cache: YearCache
  let clim: YearBytes
  let land: { w: number; h: number; px: Uint8Array }
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
        renderer = await createGpuRenderer(canvas, theme, clim, land, (why) => {
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
      renderer = createFlatRenderer(canvas, theme, clim, land)
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
        ;[clim, land] = await Promise.all([loadClim(m, ctrl.signal), loadLand(m, ctrl.signal), cache.get(yearOfM(playhead))])
        meta = m
        await makeRenderer()
        status = 'ready'
        playing = fromHash == null && !themeState.reducedMotion
        prefetch()
        raf = requestAnimationFrame(tick)
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
    return () => {
      ctrl.abort()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  })

  onDestroy(() => {
    cancelAnimationFrame(raf)
    renderer?.destroy()
    document.body.style.overflow = ''
  })

  // theme -> palette and ramps
  $effect(() => {
    const th = themeState.theme
    renderer?.setTheme(th)
    dirty = true
  })

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
    if (playing && meta) {
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
      if (f) { renderer.render(f); dirty = false }
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
    if (!playing && Math.floor(playhead) >= mEnd) playhead = mFirst
    playing = !playing
    if (!playing) syncHash(true)
  }

  function syncHash(force: boolean) {
    const m = Math.floor(playhead)
    const now = performance.now()
    if (!force && (m === lastHashM || now - lastHashAt < 400)) return
    lastHashM = m; lastHashAt = now
    const q = new URLSearchParams(location.hash.slice(1))
    q.set('view', 'pulse'); q.set('t', monthIso(m))
    history.replaceState(null, '', `${location.pathname}${location.search}#${q.toString().replace(/%2C/g, ',')}`)
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

  function sample(lon: number, lat: number) {
    const m = Math.floor(playhead)
    const A = cache.peek(yearOfM(m))
    const c = cellIndex(lon, lat), k = moyOfM(m) * LAYER
    const lx = Math.min(land.w - 1, Math.floor(((lon + 180) / 360) * land.w)), ly = Math.min(land.h - 1, Math.floor(((90 - lat) / 180) * land.h))
    return {
      value: A ? decodeValue(A[k + c], meta!.cap) : 0,
      normal: decodeValue(clim[k + c], meta!.cap),
      land: land.px[ly * land.w + lx] > 100,
      /** any activity within ~1 deg (the 150 km circle) this month */
      active: !!A && [-2, -1, 0, 1, 2].some((dy) => [-2, -1, 0, 1, 2].some((dx) => {
        const y = Math.floor(c / W) + dy, x = (((c % W) + dx) % W + W) % W
        return y >= 0 && y < 360 && A[k + y * W + x] > 0
      })),
    }
  }
  function updateHover(e: PointerEvent) {
    if (!renderer || status !== 'ready' || e.pointerType === 'touch') return
    const r = host.getBoundingClientRect()
    const f = frame()
    const ll = f && renderer.pick(e.clientX - r.left, e.clientY - r.top, f)
    if (!ll) { hover = null; return }
    const s = sample(ll[0], ll[1])
    hover = { x: e.clientX - r.left, y: e.clientY - r.top, lon: ll[0], lat: ll[1], value: s.value, normal: s.normal, land: s.land }
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
      s.active ? { focusM: m } : {},
    )
  }

  // ---------------------------------------------------------------- keyboard

  function onKey(e: KeyboardEvent) {
    if (status !== 'ready') { if (e.key === 'Escape') onclose(); return }
    const t = e.target instanceof HTMLElement ? e.target : null
    const control = t?.closest('button, select, input')
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

  const gradient = (lut: string[]) => `linear-gradient(90deg, ${Array.from({ length: 17 }, (_, i) => lut[Math.round((i / 16) * 255)]).join(', ')})`
  const seqBar = $derived(gradient(seqLut(themeState.theme)))
  const divBar = $derived(gradient(divLut(themeState.theme)))
  const ticks = $derived(meta ? [1, 10, 100].filter((v) => v < meta!.cap * 0.6).map((v) => ({ v, t: (v / meta!.cap) ** 0.25 })).concat([{ v: meta.cap, t: 1 }]) : [])
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

  <header class="top">
    <div class="title">
      <p class="lockup"><BrandMark size={18} /><span class="wm">Harmony</span></p>
      <p class="eyebrow" id="pulse-h">Global fire pulse · harmonized AFCD-M · 0.5° cells</p>
      {#if meta}
        <p class="when num" aria-live="off"><span class="mo">{MONTHS_LONG[moyOfM(cur)]}</span> <span class="yr">{yearOfM(cur)}</span></p>
        <p class="sub"><span class="num">{fmtNum(total)}</span> active-fire cell-days{regional ? ' in the regional build' : ' worldwide'}{meta.last_month_partial && cur === meta.m_last ? ' · month in progress' : ''}</p>
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
    <aside class="legend" aria-label="Legend">
      {#if mode === 'activity'}
        <p class="eyebrow">Activity · AFCD-M per cell-month</p>
        <div class="bar" style:background={seqBar}></div>
        <div class="ticks num">
          {#each ticks as t (t.v)}<span style:left={`${t.t * 100}%`}>{t.v >= meta.cap ? `${fmtNum(t.v)}+` : t.v}</span>{/each}
        </div>
      {:else}
        <p class="eyebrow">Anomaly · vs {meta.clim.baseline[0]}–{meta.clim.baseline[1]} median of the month</p>
        <div class="bar" style:background={divBar}></div>
        <div class="ends small"><span>below normal</span><span>above normal</span></div>
      {/if}
      <p class="small muted note">{kind === 'webgpu' ? 'Drag to rotate · scroll to zoom · ' : ''}click land to analyse {AOI_KM} km around it</p>
    </aside>

    {#if hover}
      <div class="tip small" style:left={`${hover.x + 14}px`} style:top={`${hover.y + 14}px`} aria-hidden="true">
        <span class="num">{Math.abs(hover.lat).toFixed(1)}°{hover.lat >= 0 ? 'N' : 'S'} {Math.abs(hover.lon).toFixed(1)}°{hover.lon >= 0 ? 'E' : 'W'}</span>
        <span><strong class="num">{hover.value > 0 ? `≈ ${fmtNum(hover.value)}` : '0'}</strong> AFCD-M · normal <span class="num">{hover.normal > 0 ? `≈ ${fmtNum(hover.normal)}` : '0'}</span></span>
        <span class="muted">{hover.land ? 'Click to analyse this area' : 'Open water'}</span>
      </div>
    {/if}

    {#if notice}<p class="notice small" role="status">{notice}</p>{/if}

    <footer class="controls">
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
      <div class="seg" role="group" aria-label="Colour by">
        <button aria-pressed={mode === 'activity'} onclick={() => { mode = 'activity'; dirty = true }}>Activity</button>
        <button aria-pressed={mode === 'anomaly'} onclick={() => { mode = 'anomaly'; dirty = true }}>Anomaly</button>
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

  .top { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: flex-start; padding: 22px 28px; pointer-events: none; }
  .title, .actions { pointer-events: auto; }
  .lockup { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--ink); }
  .wm { font-family: var(--font-display); font-weight: 500; font-size: var(--fs-sm); letter-spacing: var(--track-wordmark); text-transform: uppercase; }
  .patch { position: absolute; left: 28px; bottom: 104px; width: 96px; aspect-ratio: 1; opacity: 0.9; pointer-events: none; }
  .when { margin: 6px 0 2px; font-size: clamp(2.2rem, 4.6vw, 3.6rem); line-height: 1; letter-spacing: -0.04em; }
  .when .mo { font-family: var(--font-ui); font-weight: 600; letter-spacing: -0.035em; }
  .when .yr { color: var(--accent-ink); }
  .sub { color: var(--ink-2); margin: 8px 0 0; }
  .scope { color: var(--ink-3); max-width: 46ch; margin-top: 4px; }
  .actions { display: flex; gap: 10px; align-items: center; }
    .actions .btn { background: color-mix(in srgb, var(--surface) 70%, transparent); }

  .center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 4px; }

  .legend { position: absolute; right: 28px; bottom: 104px; width: 260px; }
  .bar { height: 8px; border-radius: 2px; margin-top: 6px; }
  .ticks { position: relative; height: 16px; font-size: var(--fs-xs); color: var(--ink-3); }
  .ticks span { position: absolute; transform: translateX(-50%); top: 2px; }
  .ticks span:last-child { transform: translateX(-100%); }
  .ends { display: flex; justify-content: space-between; color: var(--ink-3); margin-top: 3px; }
  .note { margin-top: 10px; }

  .tip {
    position: absolute; z-index: 3; display: grid; gap: 1px; pointer-events: none; padding: 7px 10px; max-width: 280px;
    background: color-mix(in srgb, var(--surface) 92%, transparent); border: 1px solid var(--rule-strong); border-radius: var(--radius);
    box-shadow: var(--shadow); backdrop-filter: blur(6px);
  }
  .notice { position: absolute; left: 50%; bottom: 104px; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--warning); border-radius: var(--radius); padding: 7px 12px; }

  .controls {
    position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 16px; padding: 16px 28px 20px;
    background: linear-gradient(to top, color-mix(in srgb, var(--bg) 92%, transparent) 40%, transparent);
  }
  .play { width: 40px; height: 40px; justify-content: center; padding: 0; border-color: var(--accent); color: var(--accent-ink); border-radius: 50%; }
  .play:hover { background: var(--accent-soft); }
  .controls .seg { flex: none; background: color-mix(in srgb, var(--surface) 70%, transparent); }

  @media (max-width: 760px), (max-height: 640px) { .patch { display: none; } }
  @media (max-width: 760px) {
    .top { padding: 14px 16px; }
    .legend { left: 16px; right: 16px; width: auto; bottom: 150px; }
    .controls { flex-wrap: wrap; padding: 12px 16px 16px; gap: 10px; }
    .controls :global(.tl) { order: 5; flex-basis: 100%; }
  }
</style>
