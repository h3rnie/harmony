// Canvas 2D fallback: the same data and colour mapping on a flat equirectangular map (no globe, no zoom).
import { parseColor, type Theme } from '../color'
import { cellIndex, LAYER, type YearBytes } from './data'
import { activityAlpha, activityT, anomalyAlpha, anomalyT, palette, rampBytes, type Frame, type PulseRenderer } from './shared'

const MAX_DPR = 2

export function createFlatRenderer(canvas: HTMLCanvasElement, theme: Theme, clim: YearBytes, land: { w: number; h: number; px: Uint8Array }): PulseRenderer {
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
  let ground: Uint8Array = new Uint8Array(0), ramp: Uint8Array = new Uint8Array(0)
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
    canvas.style.background = `rgb(${p.bg.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})`
  }
  setTheme(theme)

  /** Letterboxed 2:1 map rectangle in CSS px. */
  function rect() {
    const w = canvas.clientWidth, h = canvas.clientHeight * 0.86
    const mw = Math.min(w - 32, h * 2), mh = mw / 2
    return { x: (w - mw) / 2, y: Math.max(12, (h - mh) / 2), w: mw, h: mh }
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
    render(f: Frame) {
      const out = img.data
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
          k = anomalyAlpha(at); ri = 256 + Math.round((0.5 + 0.5 * at) * 255)
        } else if (v > 0) {
          const at = activityT(v)
          k = activityAlpha(at); ri = Math.round(at * 255)
        }
        if (k > 0) {
          r += (ramp[ri * 4] - r) * k; g += (ramp[ri * 4 + 1] - g) * k; b += (ramp[ri * 4 + 2] - b) * k
        }
        out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255
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
