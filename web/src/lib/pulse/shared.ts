// Shared by the WebGPU globe and the Canvas fallback: frame description, camera maths, palette and the
// value -> colour mapping (kept identical in WGSL and JS so both renderers read the same).
import { divLut, parseColor, seqLut, type Theme } from '../color'
import type { YearBytes } from './data'

export type PulseMode = 'activity' | 'anomaly'

export interface Frame {
  /** Globe centre (deg) and zoom (1 = globe fits the view). */
  lon0: number
  lat0: number
  zoom: number
  /** Month layers (0..11) and data for the two months being interpolated; t in [0, 1). */
  la: number
  lb: number
  a: YearBytes
  b: YearBytes
  t: number
  mode: PulseMode
}

export interface PulseRenderer {
  readonly kind: 'webgpu' | 'canvas'
  render(f: Frame): void
  /** CSS-pixel position -> [lon, lat], or null off the globe / map. */
  pick(x: number, y: number, f: Frame): [number, number] | null
  resize(): void
  setTheme(theme: Theme): void
  destroy(): void
}

// ---- camera (orthographic globe) ----

/** World-from-view rotation (column-major 3 x 3): view +z (towards the viewer) maps to (lon0, lat0). */
export function rotation(lon0: number, lat0: number): number[] {
  const f = (lon0 * Math.PI) / 180, l = (lat0 * Math.PI) / 180
  const cf = Math.cos(f), sf = Math.sin(f), c = Math.cos(l), s = Math.sin(l)
  return [cf, 0, -sf, -s * sf, c, -s * cf, c * sf, s, c * cf]
}

/** Globe radius and centre in CSS px for a viewport. */
export function globeLayout(w: number, h: number, zoom: number) {
  return { r: zoom * 0.37 * Math.min(w, h * 1.1), cx: w / 2, cy: h * 0.465 }
}

export function pickGlobe(x: number, y: number, w: number, h: number, f: Frame): [number, number] | null {
  const { r, cx, cy } = globeLayout(w, h, f.zoom)
  const px = (x - cx) / r, py = -(y - cy) / r
  const r2 = px * px + py * py
  if (r2 > 1) return null
  const pz = Math.sqrt(1 - r2)
  const m = rotation(f.lon0, f.lat0)
  const wx = m[0] * px + m[3] * py + m[6] * pz
  const wy = m[1] * px + m[4] * py + m[7] * pz
  const wz = m[2] * px + m[5] * py + m[8] * pz
  return [(Math.atan2(wx, wz) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, wy))) * 180) / Math.PI]
}

// ---- palette ----

type RGBA = [number, number, number, number]
export interface Palette { bg: RGBA; ocean: RGBA; land: RGBA; grid: RGBA; rim: RGBA; light: boolean; glow: number }

const rgba = (hex: string, a = 1): RGBA => { const [r, g, b] = parseColor(hex); return [r / 255, g / 255, b / 255, a] }

export function palette(theme: Theme): Palette {
  return theme === 'dark'
    ? { bg: rgba('#0a0d12'), ocean: rgba('#0b1017'), land: rgba('#1c2430'), grid: rgba('#8ca0be', 0.08), rim: rgba('#6aa8ec', 0.5), light: false, glow: 1.15 }
    : { bg: rgba('#f6f7f9'), ocean: rgba('#dde2e8'), land: rgba('#c3c8cf'), grid: rgba('#3c4658', 0.09), rim: rgba('#7fa6d4', 0.3), light: true, glow: 0.55 }
}

/** 256 x 2 RGBA ramp: row 0 sequential (inferno, app's ramp), row 1 diverging (blue <-> orange). */
export function rampBytes(theme: Theme): Uint8Array {
  const out = new Uint8Array(256 * 2 * 4)
  const rows = [seqLut(theme), divLut(theme)]
  rows.forEach((lut, row) => lut.forEach((c, i) => {
    const [r, g, b] = parseColor(c)
    out.set([r, g, b, 255], (row * 256 + i) * 4)
  }))
  return out
}

// ---- value mapping (mirrored in the WGSL shader) ----

/** Encoded value u in [0,1] (= sqrt(x / cap)) -> ramp position; overall x^(1/4), close to log over 4 decades. */
export const activityT = (u: number) => Math.sqrt(u)
/** Opacity of the fire colour over the land tone. */
export const activityAlpha = (t: number) => smooth(0.0, 0.22, t)
/** Anomaly in variance-stabilised (sqrt) units: month minus median, mapped to [-1, 1]. */
export const anomalyT = (u: number, c: number) => { const d = u - c; return Math.sign(d) * Math.min(1, Math.sqrt(Math.abs(d) / 0.35)) }
export const anomalyAlpha = (t: number) => smooth(0.12, 0.4, Math.abs(t))

export function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
