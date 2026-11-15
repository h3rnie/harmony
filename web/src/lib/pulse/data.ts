// Overview data for the Global pulse: meta.json + 8-bit PNG atlases (schema/data-contract.md, "Overview grids").
// Each year atlas (4 x 3 months of 720 x 360) is decoded once into a contiguous 12-layer Uint8Array, which both
// renderers upload/read and which the hover read-out samples. Small LRU, lazy loading around the playhead.
import { DATA_BASE } from '../config'

export interface OverviewMeta {
  version: number
  data_through: string
  scope: string
  cap: number
  grid: { cell_deg: number; width: number; height: number }
  atlas: { cols: number; rows: number }
  years: [number, number]
  m_first: number
  m_last: number
  m_last_data?: number
  last_month_partial: boolean
  default_switch_m: number
  clim: { file: string; baseline: [number, number] }
  land: { file: string; width: number; height: number }
  /** Fire clock (version 3): 7 layers, see schema/data-contract.md "Overview grids". */
  season?: { file: string; baseline: [number, number]; layers: number; cap: number; share: number; bimodal: { share_of_active_cells: number } }
  /** Trend 2001–2025 (version 3): 5 layers + the regional validation summary. */
  trend?: TrendMeta
  global_monthly: number[]
}

export interface TrendMeta {
  file: string
  layers: number
  range_pct_per_yr: number
  cap: number
  years: number[]
  switch_year: number
  min_baseline_afcd_per_yr: number
  significance: string
  global: { all_years: { pct_per_yr: number; p: number }; without_viirs_years: { pct_per_yr: number; p: number } }
}

/** Static layers of the fire clock and the trend map (null when the build predates them). */
export interface RegimeBytes { season: Uint8Array | null; trend: Uint8Array | null; trendRange: number }

export const W = 720, H = 360, LAYER = W * H

/** 12 month layers (Jan..Dec), row 0 = north, u8 encoded values. */
export type YearBytes = Uint8Array

const base = `${DATA_BASE}/overview`

export async function loadMeta(signal?: AbortSignal): Promise<OverviewMeta> {
  const r = await fetch(`${base}/meta.json`, { signal })
  if (!r.ok) throw new Error(`overview/meta.json: HTTP ${r.status}`)
  const m = (await r.json()) as OverviewMeta
  if (m.version !== 2 && m.version !== 3) throw new Error('overview/meta.json: unsupported version (re-run the overview stage)')
  return m
}

/** Decode an 8-bit grayscale PNG into its raw values (red channel of an un-managed bitmap). */
async function decodePng(url: string, signal?: AbortSignal): Promise<{ w: number; h: number; px: Uint8Array }> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const { width: w, height: h } = bmp
  const cv = new OffscreenCanvas(w, h)
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const rgba = ctx.getImageData(0, 0, w, h).data
  const px = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = rgba[j]
  return { w, h, px }
}

/** Atlas (4 x 3 months, January top-left) -> 12 contiguous layers. */
async function loadAtlas(url: string, signal?: AbortSignal): Promise<YearBytes> {
  const { w, px } = await decodePng(url, signal)
  const out = new Uint8Array(12 * LAYER)
  for (let k = 0; k < 12; k++) {
    const ox = (k % 4) * W, oy = Math.floor(k / 4) * H
    for (let y = 0; y < H; y++) out.set(px.subarray((oy + y) * w + ox, (oy + y) * w + ox + W), k * LAYER + y * W)
  }
  return out
}

export async function loadLand(meta: OverviewMeta, signal?: AbortSignal) {
  return decodePng(`${base}/${meta.land.file}`, signal)
}
/** Vertically stacked layers (each W x H) -> contiguous Uint8Array of n layers. */
async function loadStack(file: string, layers: number, signal?: AbortSignal): Promise<Uint8Array> {
  const { w, h, px } = await decodePng(`${base}/${file}`, signal)
  if (w !== W || h !== H * layers) throw new Error(`${file}: unexpected size ${w} x ${h}`)
  return px
}
export async function loadRegime(meta: OverviewMeta, signal?: AbortSignal): Promise<RegimeBytes> {
  const [season, trend] = await Promise.all([
    meta.season ? loadStack(meta.season.file, SEASON_LAYERS, signal).catch(() => null) : null,
    meta.trend ? loadStack(meta.trend.file, TREND_LAYERS, signal).catch(() => null) : null,
  ])
  return { season, trend, trendRange: meta.trend?.range_pct_per_yr ?? 10 }
}
export const SEASON_LAYERS = 7, TREND_LAYERS = 5
/** Season layers: peak-month unit vector (x, y), concentration, mean annual activity, peak, second peak, length. */
export const S_VX = 0, S_VY = 1, S_CONC = 2, S_ACT = 3, S_PEAK = 4, S_PEAK2 = 5, S_LEN = 6
/** Trend layers: slope, Mann–Kendall p code, flags (0 none, 1 estimated, 2 FDR-significant), baseline activity, MODIS-only slope. */
export const T_SLOPE = 0, T_P = 1, T_FLAG = 2, T_ACT = 3, T_MODIS = 4

/** Signed 8-bit code (128 = 0, 1..255) -> value in [-lim, lim]; null for 0 (no value). */
export const decodeSigned = (u: number, lim: number) => (u === 0 ? null : ((u - 128) / 127) * lim)

export function loadClim(meta: OverviewMeta, signal?: AbortSignal) {
  return loadAtlas(`${base}/${meta.clim.file}`, signal)
}

/** Year atlases with an LRU of decoded bytes; `get` dedupes in-flight requests. */
export class YearCache {
  private done = new Map<number, YearBytes>()
  private pending = new Map<number, Promise<YearBytes>>()
  constructor(private meta: OverviewMeta, private max = 8) {}

  has(year: number) { return this.done.has(year) }
  peek(year: number): YearBytes | undefined {
    const v = this.done.get(year)
    if (v) { this.done.delete(year); this.done.set(year, v) } // refresh LRU position
    return v
  }
  get(year: number): Promise<YearBytes> {
    const hit = this.peek(year)
    if (hit) return Promise.resolve(hit)
    let p = this.pending.get(year)
    if (!p) {
      const [y0, y1] = this.meta.years
      p = year < y0 || year > y1
        ? Promise.resolve(new Uint8Array(12 * LAYER))
        : loadAtlas(`${base}/pulse/${year}.png`)
      p = p.then((v) => {
        this.pending.delete(year)
        this.done.set(year, v)
        while (this.done.size > this.max) this.done.delete(this.done.keys().next().value!)
        return v
      }, (e) => { this.pending.delete(year); throw e })
      this.pending.set(year, p)
    }
    return p
  }
}

/** Encoded byte -> AFCD-M. */
export const decodeValue = (u: number, cap: number) => cap * (u / 255) ** 2

/** Cell index in a month layer for a lon/lat. */
export function cellIndex(lon: number, lat: number): number {
  const x = Math.min(W - 1, Math.max(0, Math.floor(((((lon + 180) % 360) + 360) % 360) / 0.5)))
  const y = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 0.5)))
  return y * W + x
}

export const yearOfM = (m: number) => 2000 + Math.floor(m / 12)
export const moyOfM = (m: number) => ((m % 12) + 12) % 12
