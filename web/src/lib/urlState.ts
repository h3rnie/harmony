// Shareable view state in the URL hash:
//   #p=amazon-2019 | c=lon,lat,km | b=w,s,e,n | g=<polyline>   (AOI)
//   &m=2019-08 &cal=anomaly &ov=ratio &sw=2023 &bl=2003-2022 &dn=night &r=2000-2026
import type { Aoi } from './geo'
import { bboxPolygon, circlePolygon, normalizeRings } from './geo'
import { monthIso, parseMonthIso } from './format'
import { presetById } from './presets'

export type CalMode = 'activity' | 'anomaly' | 'percentile'
export type OverlayMode = 'harmonized' | 'ratio'
export type Dn = 'both' | 'day' | 'night'

export interface ViewState {
  aoi: Aoi | null
  focusM: number | null
  calMode: CalMode
  overlay: OverlayMode
  switchYear: number | null
  baseline: [number, number] | null
  dn: Dn
  rangeYears: [number, number] | null
}

export const DEFAULT_VIEW: ViewState = {
  aoi: null, focusM: null, calMode: 'activity', overlay: 'harmonized',
  switchYear: null, baseline: null, dn: 'both', rangeYears: null,
}

// ---- Google polyline (precision 1e4 ~ 11 m) ----
function encodeSigned(v: number): string {
  let s = v < 0 ? ~(v << 1) : v << 1
  let out = ''
  while (s >= 0x20) { out += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5 }
  return out + String.fromCharCode(s + 63)
}
export function encodePolyline(ring: number[][], f = 1e4): string {
  let px = 0, py = 0, out = ''
  for (const [x, y] of ring) {
    const ix = Math.round(x * f), iy = Math.round(y * f)
    out += encodeSigned(iy - py) + encodeSigned(ix - px)
    px = ix; py = iy
  }
  return out
}
export function decodePolyline(str: string, f = 1e4): number[][] {
  const pts: number[][] = []
  let i = 0, x = 0, y = 0
  const next = () => {
    let shift = 0, result = 0, b: number
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20 && i <= str.length)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < str.length) { y += next(); x += next(); pts.push([x / f, y / f]) }
  return pts
}

const nums = (s: string | null) => (s ? s.split(',').map(Number) : [])
const okNums = (a: number[], n: number) => a.length === n && a.every(Number.isFinite)

export function readHash(hash = location.hash): ViewState {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const v: ViewState = { ...DEFAULT_VIEW }
  const preset = presetById(q.get('p'))
  const c = nums(q.get('c')), b = nums(q.get('b')), g = q.get('g')
  if (preset) v.aoi = { rings: preset.rings, shape: { kind: 'polygon' }, label: preset.title, presetId: preset.id }
  else if (okNums(c, 3) && c[2] > 0) v.aoi = { rings: circlePolygon(c[0], c[1], c[2]), shape: { kind: 'circle', lon: c[0], lat: c[1], km: c[2] }, label: `${c[2]} km around ${c[1].toFixed(2)}, ${c[0].toFixed(2)}` }
  else if (okNums(b, 4) && b[2] > b[0] && b[3] > b[1]) v.aoi = { rings: bboxPolygon(b[0], b[1], b[2], b[3]), shape: { kind: 'bbox', w: b[0], s: b[1], e: b[2], n: b[3] }, label: 'Bounding box' }
  else if (g) {
    try {
      const ring = decodePolyline(g)
      if (ring.length >= 4) v.aoi = { rings: normalizeRings([ring]), shape: { kind: 'polygon' }, label: q.get('n') ?? 'Drawn area' }
    } catch { /* ignore malformed */ }
  }
  const m = q.get('m'); if (m) v.focusM = parseMonthIso(m)
  const cal = q.get('cal'); if (cal === 'anomaly' || cal === 'percentile' || cal === 'activity') v.calMode = cal
  const ov = q.get('ov'); if (ov === 'ratio' || ov === 'harmonized') v.overlay = ov
  const sw = Number(q.get('sw')); if (q.get('sw') && Number.isInteger(sw)) v.switchYear = sw
  const bl = (q.get('bl') ?? '').split('-').map(Number); if (bl.length === 2 && bl.every(Number.isInteger)) v.baseline = [bl[0], bl[1]]
  const dn = q.get('dn'); if (dn === 'day' || dn === 'night') v.dn = dn
  const r = (q.get('r') ?? '').split('-').map(Number); if (r.length === 2 && r.every(Number.isInteger)) v.rangeYears = [r[0], r[1]]
  return v
}

export function writeHash(v: ViewState) {
  const q: string[] = []
  const a = v.aoi
  if (a) {
    if (a.presetId) q.push(`p=${a.presetId}`)
    else if (a.shape.kind === 'circle') q.push(`c=${[a.shape.lon, a.shape.lat, a.shape.km].map((n) => +n.toFixed(4)).join(',')}`)
    else if (a.shape.kind === 'bbox') q.push(`b=${[a.shape.w, a.shape.s, a.shape.e, a.shape.n].map((n) => +n.toFixed(4)).join(',')}`)
    else q.push(`g=${encodeURIComponent(encodePolyline(a.rings[0]))}`)
  }
  if (v.focusM != null) q.push(`m=${monthIso(v.focusM)}`)
  if (v.calMode !== 'activity') q.push(`cal=${v.calMode}`)
  if (v.overlay !== 'harmonized') q.push(`ov=${v.overlay}`)
  if (v.switchYear != null) q.push(`sw=${v.switchYear}`)
  if (v.baseline) q.push(`bl=${v.baseline.join('-')}`)
  if (v.dn !== 'both') q.push(`dn=${v.dn}`)
  if (v.rangeYears) q.push(`r=${v.rangeYears.join('-')}`)
  const next = q.length ? `#${q.join('&')}` : ''
  if (next !== location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${next}`)
}
