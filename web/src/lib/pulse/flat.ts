// Canvas 2D fallback: the same data and colour mapping on a flat equirectangular map (no globe, no zoom).
// Mirrors the WGSL shader mode by mode (activity, anomaly, fire clock, trend), including the hatching.
import { parseColor, type Theme } from '../color'
import { cellIndex, LAYER, S_ACT, S_CONC, S_PEAK2, S_VX, S_VY, T_FLAG, T_SLOPE, type RegimeBytes, type YearBytes } from './data'
import {
  activityAlpha, activityT, anomalyAlpha, anomalyT, clockAlpha, clockPale, HATCH_PX, isStatic, palette, rampBytes, smooth,
  trendT, type Frame, type PulseRenderer,
} from './shared'

const MAX_DPR = 2

export function createFlatRenderer(
  canvas: HTMLCanvasElement, theme: Theme, clim: YearBytes, land: { w: number; h: number; px: Uint8Array }, regime: RegimeBytes,
): PulseRenderer {
  const ctx = canvas.getContext('2d')!
  const LW = land.w, LH = land.h
  const img = new ImageData(LW, LH)
  const off = new OffscreenCanvas(LW, LH)
  const octx = off.getContext('2d')!
  // Per-pixel 0.5 deg cell index (land grid is finer than the data grid).
  const cellOf = new Uint32Array(LW * LH)
  for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
    cellOf[y * LW + x] = cellIndex(-180 + ((x + 0.5) * 360) / LW, 90 - ((y + 0.5) * 180) / LH)
  }
  let ground: Uint8Array = new Uint8Array(0), ramp: Uint8Array = new Uint8Array(0), pale = [0, 0, 0]
  let staticKey = ''
  function setTheme(th: Theme) {
    const p = palette(th)
    const o = p.ocean.map((v) => v * 255), l = p.land.map((v) => v * 255), g = p.grid.slice(0, 3).map((v) => v * 255)
    ground = new Uint8Array(LW * LH * 3)
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      const i = y * LW + x, k = land.px[i] / 255
      const lon = -180 + ((x + 0.5) * 360) / LW, lat = 90 - ((y + 0.5) * 180) / LH
      const grid = Math.abs(((lon + 360) % 30) - 15) > 14.85 || Math.abs(((lat + 360) % 30) - 15) > 14.85 ? p.grid[3] : 0
      for (let c = 0; c < 3; c++) ground[i * 3 + c] = (o[c] + (l[c] - o[c]) * k) * (1 - grid) + g[c] * grid
    }
    ramp = rampBytes(th)
    pale = p.pale.slice(0, 3).map((v) => v * 255)
    staticKey = ''
    canvas.style.background = `rgb(${p.bg.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})`
  }
  setTheme(theme)

  /** Letterboxed 2:1 map rectangle in CSS px. */
  function rect() {
    const w = canvas.clientWidth, h = canvas.clientHeight * 0.86
    const mw = Math.min(w - 32, h * 2), mh = mw / 2
    return { x: (w - mw) / 2, y: Math.max(12, (h - mh) / 2), w: mw, h: mh }
  }

  /** Stripe mask in map pixels (the map is drawn close to 1:1, so this matches the globe's screen hatch). */
  const hatch = (x: number, y: number, duty: number) => (((x + y) % HATCH_PX) + HATCH_PX) % HATCH_PX < duty * HATCH_PX
  const rampAt = (row: number, i: number) => (row * 256 + Math.max(0, Math.min(255, i))) * 4

  function paintDynamic(f: Frame, out: Uint8ClampedArray) {
    const A = f.la * LAYER, B = f.lb * LAYER, t = f.t
    const anomaly = f.mode === 'anomaly'
    for (let i = 0, j = 0; i < cellOf.length; i++, j += 4) {
      const c = cellOf[i]
      const v = ((f.a[A + c] * (1 - t) + f.b[B + c] * t) / 255)
      let r = ground[i * 3], g = ground[i * 3 + 1], b = ground[i * 3 + 2]
      let k = 0, ri = 0
      if (anomaly) {
        const n = (clim[A + c] * (1 - t) + clim[B + c] * t) / 255
        const at = anomalyT(v, n)
        k = anomalyAlpha(at); ri = rampAt(1, Math.round((0.5 + 0.5 * at) * 255))
      } else if (v > 0) {
        const at = activityT(v)
        k = activityAlpha(at); ri = rampAt(0, Math.round(at * 255))
      }
      if (k > 0) {
        r += (ramp[ri] - r) * k; g += (ramp[ri + 1] - g) * k; b += (ramp[ri + 2] - b) * k
      }
      out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255
    }
  }

  function paintClock(out: Uint8ClampedArray) {
    const s = regime.season
    for (let i = 0, j = 0; i < cellOf.length; i++, j += 4) {
      let r = ground[i * 3], g = ground[i * 3 + 1], b = ground[i * 3 + 2]
      if (s) {
        const c = cellOf[i]
        const vx = s[S_VX * LAYER + c] - 128, vy = s[S_VY * LAYER + c] - 128
        const a = clockAlpha(s[S_ACT * LAYER + c] / 255) * smooth(0.05, 0.25, Math.hypot(vx, vy) / 127) * 0.96
        if (a > 0) {
          const pos = ((Math.atan2(vy, vx) / (2 * Math.PI)) + 1) % 1
          let ci = rampAt(2, Math.floor(pos * 256))
          const p2 = s[S_PEAK2 * LAYER + c]
          if (p2 > 0 && hatch(i % LW, Math.floor(i / LW), 0.4)) ci = rampAt(2, Math.floor(((p2 - 1) / 12) * 256))
          const pl = clockPale(s[S_CONC * LAYER + c] / 255)
          const cr = ramp[ci] + (pale[0] - ramp[ci]) * pl, cg = ramp[ci + 1] + (pale[1] - ramp[ci + 1]) * pl, cb = ramp[ci + 2] + (pale[2] - ramp[ci + 2]) * pl
          r += (cr - r) * a; g += (cg - g) * a; b += (cb - b) * a
        }
      }
      out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255
    }
  }

  function paintTrend(out: Uint8ClampedArray) {
    const s = regime.trend
    for (let i = 0, j = 0; i < cellOf.length; i++, j += 4) {
      let r = ground[i * 3], g = ground[i * 3 + 1], b = ground[i * 3 + 2]
      const c = cellOf[i]
      const flag = s ? s[T_FLAG * LAYER + c] : 0
      if (s && flag > 0) {
        const t = trendT(((s[T_SLOPE * LAYER + c] - 128) / 127) * regime.trendRange)
        const ci = rampAt(1, Math.round((0.5 + 0.5 * t) * 255))
        const k = flag > 1 ? 0.97 : hatch(i % LW, Math.floor(i / LW), 0.45) ? 0.62 : 0.2
        r += (ramp[ci] - r) * k; g += (ramp[ci + 1] - g) * k; b += (ramp[ci + 2] - b) * k
      }
      out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255
    }
  }

  return {
    kind: 'canvas',
    resize() {
      const dpr = Math.min(MAX_DPR, devicePixelRatio || 1)
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
    },
    setTheme,
    pick(x, y) {
      const r = rect()
      const u = (x - r.x) / r.w, v = (y - r.y) / r.h
      return u < 0 || u > 1 || v < 0 || v > 1 ? null : [u * 360 - 180, 90 - v * 180]
    },
    project(lon, lat) {
      const r = rect()
      return [r.x + ((lon + 180) / 360) * r.w, r.y + ((90 - lat) / 180) * r.h, 1]
    },
    render(f: Frame) {
      if (!isStatic(f.mode)) { paintDynamic(f, img.data); staticKey = '' }
      else if (staticKey !== f.mode) {                    // static pictures are painted once per mode/theme
        if (f.mode === 'clock') paintClock(img.data)
        else paintTrend(img.data)
        staticKey = f.mode
      }
      octx.putImageData(img, 0, 0)
      const s = canvas.width / Math.max(1, canvas.clientWidth), m = rect()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(off, m.x * s, m.y * s, m.w * s, m.h * s)
      ctx.strokeStyle = `rgba(${parseColor('#8ca0be').join(',')},0.35)`
      ctx.lineWidth = s
      ctx.strokeRect(m.x * s, m.y * s, m.w * s, m.h * s)
    },
    destroy() { /* nothing held outside the canvas */ },
  }
}
