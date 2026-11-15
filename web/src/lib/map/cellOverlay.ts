// Renders a kernel CellLayer (regular lat/lon grid cells) into a canvas whose rows are resampled to
// Web Mercator, so that a MapLibre image source (which interpolates linearly between its corners in
// Mercator space) registers every cell exactly. Pure module: no MapLibre dependency.
import type { CellLayer, LevelMeta } from '../kernel/types'
import { activityDomain, activityT, divLut, parseColor, ratioT, seqLut, type ActDomain, type Theme } from '../color'

export type OverlayMode = 'harmonized' | 'ratio'

export interface RenderedOverlay {
  canvas: HTMLCanvasElement
  /** MapLibre image-source corners: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]]
  mode: OverlayMode
  /** Activity-mode log domain (values at the ends of the ramp). */
  domain: ActDomain
  nCells: number
  /** Value lookup for hover read-outs. */
  lookup(lon: number, lat: number): { value: number; weight: number } | null
}

const MAX_LAT = 85.0511
const MAX_W = 2048
const MAX_H = 4096

const mercY = (lat: number) => {
  const p = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2
}
const latFromMercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

export function renderCellLayer(layer: CellLayer, level: LevelMeta, mode: OverlayMode, theme: Theme): RenderedOverlay | null {
  const n = layer.cells.length
  if (!n) return null
  const { nx, cell_deg: c } = level
  let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity
  for (let i = 0; i < n; i++) {
    const id = layer.cells[i]
    const ix = id % nx, iy = Math.floor(id / nx)
    if (ix < ix0) ix0 = ix
    if (ix > ix1) ix1 = ix
    if (iy < iy0) iy0 = iy
    if (iy > iy1) iy1 = iy
  }
  const W = ix1 - ix0 + 1, Hc = iy1 - iy0 + 1
  const vals = new Float32Array(W * Hc).fill(NaN)
  const wts = new Float32Array(W * Hc)
  const positives: number[] = []
  for (let i = 0; i < n; i++) {
    const id = layer.cells[i]
    const k = (Math.floor(id / nx) - iy0) * W + ((id % nx) - ix0)
    vals[k] = layer.values[i]
    wts[k] = layer.weights[i]
    if (layer.values[i] > 0) positives.push(layer.values[i])
  }
  const domain = activityDomain(positives, 0.05, 0.98)

  const west = -180 + ix0 * c, east = -180 + (ix1 + 1) * c
  const south = Math.max(-MAX_LAT, -90 + iy0 * c), north = Math.min(MAX_LAT, -90 + (iy1 + 1) * c)
  const pxPerCell = Math.max(1, Math.min(8, Math.floor(MAX_W / W)))
  const width = Math.min(MAX_W, W * pxPerCell)
  const yN = mercY(north), yS = mercY(south)
  const height = Math.max(1, Math.min(MAX_H, Math.round((width * (yS - yN)) / ((east - west) / 360))))

  // Colour lookup (RGB bytes) for the theme.
  const lut = (mode === 'harmonized' ? seqLut(theme) : divLut(theme)).map(parseColor)
  const rowColors = new Uint8ClampedArray(W * 4 * Hc)
  for (let r = 0; r < Hc; r++) {
    for (let x = 0; x < W; x++) {
      const k = r * W + x
      const v = vals[k]
      const o = k * 4
      if (Number.isNaN(v) || (mode === 'harmonized' && !(v > 0)) || (mode === 'ratio' && !(v >= 0))) continue
      const t = mode === 'harmonized' ? activityT(v, domain) : (ratioT(v) + 1) / 2
      const rgb = lut[Math.max(0, Math.min(255, Math.round(t * 255)))]
      rowColors[o] = rgb[0]; rowColors[o + 1] = rgb[1]; rowColors[o + 2] = rgb[2]
      rowColors[o + 3] = Math.round(255 * (0.45 + 0.5 * Math.min(1, wts[k])))
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(width, height)
  const out = img.data
  for (let py = 0; py < height; py++) {
    const lat = latFromMercY(yN + ((py + 0.5) / height) * (yS - yN))
    const r = Math.floor((lat + 90) / c) - iy0
    if (r < 0 || r >= Hc) continue
    const rowBase = r * W * 4
    const outBase = py * width * 4
    for (let px = 0; px < width; px++) {
      const x = Math.min(W - 1, Math.floor((px * W) / width))
      const s = rowBase + x * 4, d = outBase + px * 4
      out[d] = rowColors[s]; out[d + 1] = rowColors[s + 1]; out[d + 2] = rowColors[s + 2]; out[d + 3] = rowColors[s + 3]
    }
  }
  ctx.putImageData(img, 0, 0)

  return {
    canvas,
    coordinates: [[west, north], [east, north], [east, south], [west, south]],
    mode,
    domain,
    nCells: n,
    lookup(lon, lat) {
      const x = Math.floor((lon + 180) / c) - ix0, r = Math.floor((lat + 90) / c) - iy0
      if (x < 0 || x >= W || r < 0 || r >= Hc) return null
      const v = vals[r * W + x]
      return Number.isNaN(v) ? null : { value: v, weight: wts[r * W + x] }
    },
  }
}
