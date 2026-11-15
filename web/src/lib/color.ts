// Colour scales for the burning calendar and the map overlay.
// Sequential: inferno (perceptually uniform, CVD-safe, lightness carries value). The anchor flips by theme:
//   dark ground -> low = dark, high = bright;  light ground -> low = pale, high = dark.
// Diverging: blue <-> orange through a neutral grey that matches each theme's ground (CVD-safe pair).
import { interpolateInferno } from 'd3-scale-chromatic'

export type Theme = 'dark' | 'light'

type Lab = [number, number, number]

function srgbToLinear(c: number) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function linearToSrgb(c: number) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}
export function parseColor(css: string): [number, number, number] {
  if (css.startsWith('rgb')) {
    const n = css.match(/[\d.]+/g)!.map(Number)
    return [n[0], n[1], n[2]]
  }
  const h = css.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')

function toOklab(hex: string): Lab {
  const [r8, g8, b8] = parseColor(hex)
  const r = srgbToLinear(r8), g = srgbToLinear(g8), b = srgbToLinear(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function fromOklab([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return toHex(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  )
}
/** Piecewise OKLab interpolation through evenly spaced stops; t in [0,1]. */
function oklabRamp(stops: string[]): (t: number) => string {
  const labs = stops.map(toOklab)
  const n = labs.length - 1
  return (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * n
    const i = Math.min(n - 1, Math.floor(x)), f = x - i
    const a = labs[i], b = labs[i + 1]
    return fromOklab([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
  }
}
const cssToHex = (s: string) => toHex(...parseColor(s))

// Precomputed 256-step lookup tables (fast for canvas overlays and hundreds of cells).
function lut(fn: (t: number) => string, n = 256): string[] {
  return Array.from({ length: n }, (_, i) => fn(i / (n - 1)))
}
const SEQ: Record<Theme, string[]> = {
  dark: lut((t) => cssToHex(interpolateInferno(0.1 + 0.87 * t))),
  light: lut((t) => cssToHex(interpolateInferno(0.97 - 0.85 * t))),
}
// Diverging. Lightness grows away from the midpoint on dark, falls away from it on light.
const DIV: Record<Theme, string[]> = {
  dark: lut(oklabRamp(['#a9d6ff', '#4a8fd8', '#2a2f37', '#d4762a', '#ffc685'])),
  light: lut(oklabRamp(['#0f3f78', '#4b8fd3', '#ebe9e4', '#de8a3e', '#7a3507'])),
}

export function seqColor(t: number, theme: Theme): string {
  return SEQ[theme][Math.max(0, Math.min(255, Math.round(t * 255)))]
}
/** t in [-1, 1]; 0 = neutral. */
export function divColor(t: number, theme: Theme): string {
  return DIV[theme][Math.max(0, Math.min(255, Math.round((t + 1) * 127.5)))]
}
export const seqLut = (theme: Theme) => SEQ[theme]
export const divLut = (theme: Theme) => DIV[theme]

/** WCAG relative luminance. */
export function luminance(css: string): number {
  const [r, g, b] = parseColor(css).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** Pick dark or light ink for text drawn on top of a fill. */
export function inkOn(css: string): string {
  return luminance(css) > 0.2 ? '#101114' : '#f6f4ef'
}

// ---- value -> t mappings shared by calendar, legend and overlay ----

/** Log-scale domain [lo, hi] for activity: lo = 2nd percentile of positive values (bounded to hi/1e4). */
export type ActDomain = [number, number]
export function activityDomain(values: Iterable<number | null | undefined>, loQ = 0.02, hiQ = 1): ActDomain {
  const pos: number[] = []
  for (const v of values) if (v != null && v > 0) pos.push(v)
  if (!pos.length) return [0.1, 1]
  pos.sort((a, b) => a - b)
  const hi = pos[Math.min(pos.length - 1, Math.floor((pos.length - 1) * hiQ))]
  let lo = Math.max(pos[Math.floor((pos.length - 1) * loQ)], hi / 1e4, 1e-3)
  if (!(lo < hi)) lo = hi / 10
  return [lo, hi]
}
/** Perceptual log scale: 0 -> 0 (its own colour), positive values -> [0.06, 1] by log(v) over the domain. */
export function activityT(v: number, d: ActDomain): number {
  if (!(v > 0)) return 0
  const t = Math.log(v / d[0]) / Math.log(d[1] / d[0])
  return 0.06 + 0.94 * Math.max(0, Math.min(1, t))
}
/** Value at ramp position t (t >= 0.06). */
export function activityInverse(t: number, d: ActDomain): number {
  const u = Math.max(0, (t - 0.06) / 0.94)
  return d[0] * (d[1] / d[0]) ** u
}
/** log2 ratio clamped to +-3 (1/8x ... 8x) -> [-1, 1]. */
export const RATIO_LIMIT = 3
export function ratioT(r: number): number {
  if (!(r > 0)) return -1
  return Math.max(-1, Math.min(1, Math.log2(r) / RATIO_LIMIT))
}
export function percentileT(p: number): number {
  return Math.max(-1, Math.min(1, (p - 50) / 50))
}

// ---- value-suppressing uncertainty palette (Correll, Moritz & Heer, CHI 2018) ----
// A tree quantisation over the activity ramp: the most certain months get 8 value bins, then 4, 2 and finally a
// single bin for the least certain. Each coarser level is the parent bin's colour (the ramp at the bin's midpoint)
// pulled in OKLab towards a neutral grey at the ramp's middle lightness: less chroma and less lightness contrast,
// so uncertain months cannot be read as precisely, and the most uncertain all look the same.
// Built on the same inferno ramp as Activity (no new hue). Uncertainty is never colour-only: the calendar adds a
// dot pattern whose density grows with the class.

export type UncClass = 0 | 1 | 2 | 3
export const UNC_BINS = [8, 4, 2, 1] as const
/** Suppression per class: 0 = full colour, 1 = the theme's neutral grey. */
const UNC_K = [0, 0.42, 0.66, 0.86]
/** Class edges on the half-width of the 80 % range in log units: about ±15 %, ±35 % and ×/÷1.8. */
export const UNC_EDGES = [Math.log(1.15), Math.log(1.35), Math.log(1.8)] as const
export const UNC_WORD = ['high', 'medium', 'low', 'very low'] as const
export const UNC_RANGE = ['within about ±15 %', 'within about ±35 %', 'within about ±80 %', 'wider, provisional or partial'] as const

/**
 * Confidence class of one month from its 80 % bounds. Width = half the log ratio of (hi + 1) / (lo + 1): the
 * one-fire-day offset keeps months near zero finite. No bounds (observed directly) -> most certain; provisional
 * and partial months -> least certain regardless of their bounds.
 */
export function uncertaintyClass(lo: number | null | undefined, hi: number | null | undefined, provisional = false, partial = false): UncClass {
  if (provisional || partial) return 3
  if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) return 0
  const h = Math.log((Math.max(hi, lo) + 1) / (Math.max(0, Math.min(hi, lo)) + 1)) / 2
  return h <= UNC_EDGES[0] ? 0 : h <= UNC_EDGES[1] ? 1 : h <= UNC_EDGES[2] ? 2 : 3
}
/** Half-width of the 80 % range as "±x %" text (for tooltips). */
export function rangeHalfPct(lo: number, hi: number): string {
  const f = Math.sqrt((Math.max(hi, lo) + 1) / (Math.max(0, Math.min(hi, lo)) + 1))
  return f >= 1.995 ? `×/÷ ${f.toFixed(1)}` : `±${Math.round((f - 1) * 100)} %`
}

/** Bin of activity position t (0..1, from activityT) at class u; returns the bin index and its midpoint. */
export function vsupBin(t: number, u: UncClass): { bin: number; mid: number } {
  const n = UNC_BINS[u]
  const bin = Math.max(0, Math.min(n - 1, Math.floor(Math.max(0, Math.min(1, t)) * n)))
  return { bin, mid: (bin + 0.5) / n }
}

const VSUP_CACHE: Record<Theme, Map<string, string>> = { dark: new Map(), light: new Map() }
/** Colour of bin `bin` at class u. */
export function vsupBinColor(bin: number, u: UncClass, theme: Theme): string {
  const key = `${u}:${bin}`
  const hit = VSUP_CACHE[theme].get(key)
  if (hit) return hit
  const base = toOklab(seqColor((bin + 0.5) / UNC_BINS[u], theme))
  const midL = toOklab(seqColor(0.5, theme))[0]
  const k = UNC_K[u]
  const out = fromOklab([base[0] + (midL - base[0]) * k, base[1] * (1 - k), base[2] * (1 - k)])
  VSUP_CACHE[theme].set(key, out)
  return out
}
/** Value-suppressing colour for activity position t at confidence class u. */
export function vsupColor(t: number, u: UncClass, theme: Theme): string {
  return vsupBinColor(vsupBin(t, u).bin, u, theme)
}
