// MapLibre circle layer for live FIRMS detections (colour + fill + stroke by age, radius by FRP, dimmed outside the AOI).
import type { CircleLayerSpecification, ExpressionSpecification } from 'maplibre-gl'
import type { LiveResponse } from './types'
import { LIVE_CONF, LIVE_SATS } from './types'

export type Theme = 'dark' | 'light'

/** Age classes: 0 = < 6 h, 1 = < 24 h, 2 = older. Cool hues, absent from the historical overlay's inferno ramp. */
export const AGE_LABELS = ['< 6 h', '6–24 h', '> 24 h'] as const
export const AGE_COLORS: Record<Theme, { fill: [string, string, string]; ring: [string, string, string] }> = {
  // fresh: bright filled + contrasting ring · recent: filled, hairline ring · older: small faint dot
  dark: { fill: ['#7cf0ff', '#2f8fe8', '#7d8da0'], ring: ['#ffffff', '#0a0d12', '#7d8da0'] },
  light: { fill: ['#0047b3', '#2f86d6', '#5f6f82'], ring: ['#0a0d12', '#faf9f6', '#5f6f82'] },
}

export function ageClass(ageSec: number): 0 | 1 | 2 {
  return ageSec < 6 * 3600 ? 0 : ageSec < 24 * 3600 ? 1 : 2
}

export function liveGeoJson(d: LiveResponse, inside: Uint8Array, nowSec: number, windowHours: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  const cutoff = nowSec - windowHours * 3600
  // Oldest first so the freshest detections draw on top.
  for (let i = d.n - 1; i >= 0; i--) {
    if (d.t[i] < cutoff) continue
    features.push({
      type: 'Feature',
      id: i,
      properties: { i, age: ageClass(nowSec - d.t[i]), frp: d.frp[i], in: inside[i] },
      geometry: { type: 'Point', coordinates: [d.lon[i], d.lat[i]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

const sqrtFrp: ExpressionSpecification = ['sqrt', ['max', 0, ['to-number', ['get', 'frp'], 0]]]
/** Radius from sqrt(FRP), clamped to 2.5..8 px at mid zoom, scaled gently with zoom. Older detections shrink. */
const ageScale: ExpressionSpecification = ['match', ['get', 'age'], 0, 1, 1, 0.82, 0.5]
const radius = (k: number): ExpressionSpecification => ['*', k, ageScale, ['min', 8, ['max', 2.5, ['+', 2.4, ['*', 0.7, sqrtFrp]]]]]
const inAoi: ExpressionSpecification = ['==', ['get', 'in'], 1]

export function livePaint(theme: Theme): CircleLayerSpecification['paint'] {
  const c = AGE_COLORS[theme]
  const byAge = (v: [string, string, string]): ExpressionSpecification => ['match', ['get', 'age'], 0, v[0], 1, v[1], v[2]]
  return {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, radius(0.7), 7, radius(1), 11, radius(1.35)],
    'circle-color': byAge(c.fill),
    // fresh: bright, ringed · recent: filled, hairline ring · older: small faint dot, no ring (keeps 7-day views calm)
    'circle-opacity': ['match', ['get', 'age'],
      0, ['case', inAoi, 0.95, 0.3],
      1, ['case', inAoi, 0.8, 0.22],
      ['case', inAoi, 0.4, 0.12]],
    'circle-stroke-color': byAge(c.ring),
    'circle-stroke-width': ['match', ['get', 'age'], 0, 1.2, 1, 0.6, 0],
    'circle-stroke-opacity': ['case', inAoi, 0.9, 0.25],
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`

/** Popup content as DOM nodes (no HTML strings). */
export function popupNode(d: LiveResponse, i: number, nowSec: number, inAoi: boolean, ageText: (s: number) => string): HTMLElement {
  const t = d.t[i]
  const utc = new Date(t * 1000)
  const solar = new Date((t + d.lon[i] * 240) * 1000)
  const root = document.createElement('div')
  root.className = 'live-pop'
  const h = document.createElement('p')
  h.className = 'lp-h'
  h.textContent = `${LIVE_SATS[d.sat[i]] ?? 'Unknown'} · ${d.dn[i] === 1 ? 'night' : 'day'} overpass`
  root.append(h)
  const dl = document.createElement('dl')
  const row = (k: string, v: string) => {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    dl.append(dt, dd)
  }
  row('UTC', `${utc.toISOString().slice(0, 10)} ${hhmm(utc)}`)
  row('Local solar', `${solar.toISOString().slice(0, 10)} ${hhmm(solar)}`)
  row('Age', `${ageText(nowSec - t)} ago`)
  row('Confidence', LIVE_CONF[d.conf[i]] ?? '—')
  row('FRP', `${d.frp[i].toFixed(1)} MW`)
  row('Position', `${d.lat[i].toFixed(4)}, ${d.lon[i].toFixed(4)}`)
  root.append(dl)
  const note = document.createElement('p')
  note.className = 'lp-note'
  note.textContent = inAoi ? 'Near-real-time, provisional.' : 'Outside the selected area · near-real-time, provisional.'
  root.append(note)
  return root
}
