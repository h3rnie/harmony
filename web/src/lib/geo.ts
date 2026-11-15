// Small geodesy helpers for AOIs (spherical approximations are fine for display and areas).
export type Ring = number[][]
export type Rings = number[][][]

export type AoiShape =
  | { kind: 'polygon' }
  | { kind: 'circle'; lon: number; lat: number; km: number }
  | { kind: 'bbox'; w: number; s: number; e: number; n: number }

export interface Aoi {
  rings: Rings
  shape: AoiShape
  label: string
  presetId?: string
}

const R = 6371.0088
const RAD = Math.PI / 180
const round6 = (v: number) => Math.round(v * 1e6) / 1e6

export function circlePolygon(lon: number, lat: number, km: number, n = 96): Rings {
  const ring: Ring = []
  const d = km / R, p1 = lat * RAD, l1 = lon * RAD
  for (let i = 0; i < n; i++) {
    const th = (i / n) * 2 * Math.PI
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th))
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
    ring.push([round6(((l2 / RAD + 540) % 360) - 180), round6(p2 / RAD)])
  }
  ring.push([...ring[0]])
  return normalizeRings([ring])
}

/** Rectangle in lon/lat, densified so it keeps its shape on any projection. */
export function bboxPolygon(w: number, s: number, e: number, n: number, steps = 16): Rings {
  const ring: Ring = []
  for (let i = 0; i < steps; i++) ring.push([w + ((e - w) * i) / steps, s])
  for (let i = 0; i < steps; i++) ring.push([e, s + ((n - s) * i) / steps])
  for (let i = 0; i < steps; i++) ring.push([e - ((e - w) * i) / steps, n])
  for (let i = 0; i < steps; i++) ring.push([w, n - ((n - s) * i) / steps])
  ring.push([w, s])
  return normalizeRings([ring])
}

function ringArea(ring: Ring): number {
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]
    s += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD))
  }
  return (-s * R * R) / 2
}

/** Spherical polygon area in km^2 (outer ring minus holes). */
export function ringsAreaKm2(rings: Rings): number {
  let a = 0
  rings.forEach((r, i) => {
    const v = Math.abs(ringArea(r))
    a += i === 0 ? v : -v
  })
  return Math.max(0, a)
}

export function ringsBbox(rings: Rings): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of rings[0]) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
  }
  return [w, s, e, n]
}
export function ringsCentroid(rings: Rings): [number, number] {
  const r = rings[0]
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < r.length - 1; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[i + 1]
    const f = x1 * y2 - x2 * y1
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
  }
  if (Math.abs(a) < 1e-12) {
    const [w, s, e, n] = ringsBbox(rings)
    return [(w + e) / 2, (s + n) / 2]
  }
  return [cx / (3 * a), cy / (3 * a)]
}
export function pointInRings(x: number, y: number, rings: Rings): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Closed rings, outer ring counter-clockwise, holes clockwise (GeoJSON right-hand rule). */
export function normalizeRings(rings: Rings): Rings {
  return rings.map((r, i) => {
    const ring = r.map((p) => [round6(+p[0]), round6(+p[1])])
    const f = ring[0], l = ring[ring.length - 1]
    if (f[0] !== l[0] || f[1] !== l[1]) ring.push([...f])
    let signed = 0
    for (let k = 0; k < ring.length - 1; k++) signed += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]
    const ccw = signed > 0
    return (i === 0) === ccw ? ring : ring.reverse()
  })
}

/** Parse any GeoJSON and return the largest polygon found, with a note if something was dropped. */
export function polygonFromGeoJSON(text: string): { rings: Rings; note?: string } {
  const gj = JSON.parse(text)
  const polys: Rings[] = []
  const visit = (g: any): void => {
    if (!g || typeof g !== 'object') return
    switch (g.type) {
      case 'FeatureCollection': g.features?.forEach((f: any) => visit(f?.geometry)); break
      case 'Feature': visit(g.geometry); break
      case 'GeometryCollection': g.geometries?.forEach(visit); break
      case 'Polygon': polys.push(g.coordinates); break
      case 'MultiPolygon': g.coordinates.forEach((c: Rings) => polys.push(c)); break
    }
  }
  visit(gj)
  if (!polys.length) throw new Error('No Polygon or MultiPolygon found in that file.')
  polys.sort((a, b) => ringsAreaKm2(b) - ringsAreaKm2(a))
  return {
    rings: normalizeRings(polys[0]),
    note: polys.length > 1 ? `Using the largest of ${polys.length} polygons.` : undefined,
  }
}

export function aoiToGeoJSON(aoi: Aoi, props: Record<string, unknown> = {}) {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: aoi.label, ...props }, geometry: { type: 'Polygon', coordinates: aoi.rings } },
    ],
  }
}

/** Kernel limit on an area's bounding box at the finest level (0.05° cells): MAX_BBOX_CELLS = 12,000,000. */
const MAX_BBOX_DEG2 = 12_000_000 * 0.05 * 0.05

export const AOI_MSG_ANTIMERIDIAN = 'Areas that cross the 180° meridian are not supported yet — split it in two.'
export const AOI_MSG_TOO_LARGE = 'This area is too large to analyse; the Global pulse shows the whole planet.'

/** True when a ring jumps across the antimeridian (or leaves −180…180), which the record's grid cannot represent. */
export function crossesAntimeridian(rings: Rings): boolean {
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const x = r[i][0]
      if (!(x >= -180 && x <= 180)) return true
      if (i > 0 && Math.abs(x - r[i - 1][0]) > 180) return true
    }
  }
  return false
}

/** Why an area cannot be analysed, in words for the viewer; null when it can. */
export function aoiProblem(aoi: Aoi): string | null {
  const sh = aoi.shape
  if (sh.kind === 'bbox') {
    if (!(sh.n > sh.s)) return 'North must be greater than south.'
    if (!(sh.e > sh.w)) return AOI_MSG_ANTIMERIDIAN
  }
  if (sh.kind === 'circle') {
    const dLon = sh.km / (111.32 * Math.max(0.01, Math.cos((Math.min(89, Math.abs(sh.lat) + sh.km / 111.32) * Math.PI) / 180)))
    if (sh.lon - dLon < -180 || sh.lon + dLon > 180) return AOI_MSG_ANTIMERIDIAN
  }
  if (!aoi.rings.length || aoi.rings[0].length < 4) return 'That outline has too few points to make an area.'
  if (crossesAntimeridian(aoi.rings)) return AOI_MSG_ANTIMERIDIAN
  const [w, s, e, n] = ringsBbox(aoi.rings)
  if ((e - w) * (n - s) > MAX_BBOX_DEG2) return AOI_MSG_TOO_LARGE
  return null
}

/** Centre and radius of a drawn circle (a regular ring), so it can be shared as `c=lon,lat,km`. */
export function circleFromRing(ring: Ring): { lon: number; lat: number; km: number } | null {
  const pts = ring.slice(0, -1)
  if (pts.length < 8) return null
  // Mean on the unit sphere: robust for any latitude.
  let x = 0, y = 0, z = 0
  for (const [lo, la] of pts) {
    const p = la * RAD, l = lo * RAD
    x += Math.cos(p) * Math.cos(l); y += Math.cos(p) * Math.sin(l); z += Math.sin(p)
  }
  const lon = Math.atan2(y, x) / RAD, lat = Math.atan2(z, Math.hypot(x, y)) / RAD
  const hav = (lo: number, la: number) => {
    const dp = (la - lat) * RAD, dl = (lo - lon) * RAD
    const h = Math.sin(dp / 2) ** 2 + Math.cos(lat * RAD) * Math.cos(la * RAD) * Math.sin(dl / 2) ** 2
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
  }
  const d = pts.map(([lo, la]) => hav(lo, la))
  const km = d.reduce((a, b) => a + b, 0) / d.length
  // Only a ring whose vertices are all (nearly) the same distance from the centre is a circle.
  if (!(km > 0) || d.some((v) => Math.abs(v - km) > km * 0.06)) return null
  return { lon, lat, km }
}
