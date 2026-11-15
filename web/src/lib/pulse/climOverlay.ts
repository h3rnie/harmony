// Faint global climatology for the landing map: the overview's clim.png month (median 2003–2022) rendered into a
// canvas whose rows are resampled to Web Mercator (like map/cellOverlay.ts), clipped to +-85 deg, for a MapLibre
// image source. Loaded lazily by MapPanel; shares the pulse's data loader and colour mapping.
import { parseColor, seqLut, type Theme } from '../color'
import { MONTHS_LONG } from '../format'
import { H, LAYER, loadClim, loadMeta, W, type OverviewMeta, type YearBytes } from './data'
import { activityAlpha, activityT } from './shared'

const MAX_LAT = 85.0511
const SIZE = 1024
const mercY = (lat: number) => {
  const p = (lat * Math.PI) / 180
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2
}
const latFromMercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

export interface ClimOverlay {
  canvas: HTMLCanvasElement
  coordinates: [[number, number], [number, number], [number, number], [number, number]]
  label: string
}

let cached: Promise<{ meta: OverviewMeta; clim: YearBytes }> | null = null

/** month 1..12 */
export async function renderClimOverlay(month: number, theme: Theme): Promise<ClimOverlay> {
  cached ??= loadMeta().then(async (meta) => ({ meta, clim: await loadClim(meta) }))
  let data
  try { data = await cached } catch (e) { cached = null; throw e }
  const { meta, clim } = data
  const lut = seqLut(theme).map(parseColor)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(SIZE, SIZE)
  const out = img.data
  const off = (month - 1) * LAYER
  const yN = mercY(MAX_LAT), yS = mercY(-MAX_LAT)
  for (let py = 0; py < SIZE; py++) {
    const lat = latFromMercY(yN + ((py + 0.5) / SIZE) * (yS - yN))
    const row = off + Math.min(H - 1, Math.floor((90 - lat) / 0.5)) * W
    for (let px = 0; px < SIZE; px++) {
      const u = clim[row + Math.floor((px * W) / SIZE)]
      if (!u) continue
      const t = activityT(u / 255)
      const c = lut[Math.round(t * 255)], d = (py * SIZE + px) * 4
      out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = Math.round(255 * (0.25 + 0.75 * activityAlpha(t)))
    }
  }
  ctx.putImageData(img, 0, 0)
  const [b0, b1] = meta.clim.baseline
  return {
    canvas,
    coordinates: [[-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT]],
    label: `Typical fire activity in ${MONTHS_LONG[month - 1]}, ${b0}–${b1}`,
  }
}
