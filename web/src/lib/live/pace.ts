// Near-real-time pace in the record's own unit (AFCD-M), from live FIRMS rows.
// Pure functions with type-only imports, so Node can run this file directly (scripts/live-smoke.mjs).
//
// Method (mirrors docs/design.md "Harmonization method" as far as NRT allows):
//  1. Rows: NOAA-20 and NOAA-21 only, confidence nominal|high, inside the AOI polygon, day|night per the
//     analysis option. MODIS rows are shown and counted but not used for the pace (the record's recent
//     months are calibrated VIIRS).
//  2. Active-fire cell-day = distinct (0.0125° sub-cell, local-solar date, day|night), local-solar
//     date = date(UTC + lon/15 h), counted per satellite.
//  3. Per local-solar day: mean over the satellites that reported that day (never summed) = VIIRS cell-days.
//  4. AFCD-M = VIIRS cell-days × k_eff(calendar month), k_eff = Σ viirsCal / Σ viirsRaw over that calendar
//     month in the area's own series (fallback: all months; else no conversion, labelled).
//  5. Normal daily pace = climatological median of the calendar month / days in that month (q25–q75 band).
//  Only complete local-solar days (fully inside the fetched window and older than the NRT latency) enter
//  the pace; the current, partial day is shown but not averaged.
import type { LiveResponse } from './types'

export type DnFilter = 'both' | 'day' | 'night'
export type Level = 'extreme' | 'well-above' | 'above' | 'normal' | 'below' | 'well-below'

export const SUBCELL_DEG = 0.0125
/** NRT latency allowance before a finished local day counts as complete. */
export const NRT_LATENCY_SEC = 3 * 3600
/** A satellite with no row anywhere in the fetched bbox on a day while the other has at least this many is treated as not reporting. */
export const OUTAGE_MIN_OTHER = 20
const SAT_N20 = 0, SAT_N21 = 1

export type LiveRows = Pick<LiveResponse, 'n' | 'lat' | 'lon' | 't' | 'sat' | 'conf' | 'dn'>

/** Local-solar day number (days since 1970-01-01) of an acquisition at longitude lon. */
export const localSolarDay = (t: number, lon: number): number => Math.floor((t + lon * 240) / 86400)
export const dayIso = (day: number): string => new Date(day * 86400_000).toISOString().slice(0, 10)
const dayMonth = (day: number) => new Date(day * 86400_000).getUTCMonth() + 1
const dayYear = (day: number) => new Date(day * 86400_000).getUTCFullYear()
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export interface Calibration {
  /** k by calendar month 1..12 (index 0 = January); null where the month has too little VIIRS. */
  byMonth: (number | null)[]
  all: number | null
}

/** k_eff = Σ viirsCal / Σ viirsRaw per calendar month, from the area's own monthly series. */
export function calibrationFromSeries(months: number[], viirsCal: (number | null)[], viirsRaw: (number | null)[], minRaw = 10): Calibration {
  const cal = new Array(12).fill(0), raw = new Array(12).fill(0)
  months.forEach((m, i) => {
    const c = viirsCal[i], r = viirsRaw[i]
    if (c == null || r == null || !(r > 0)) return
    const mo = (((m % 12) + 12) % 12)
    cal[mo] += c; raw[mo] += r
  })
  const sumC = cal.reduce((a, b) => a + b, 0), sumR = raw.reduce((a, b) => a + b, 0)
  return {
    byMonth: cal.map((c, i) => (raw[i] >= minRaw ? c / raw[i] : null)),
    all: sumR >= minRaw ? sumC / sumR : null,
  }
}

export interface Normal { median: number[]; q10: number[]; q25: number[]; q75: number[]; q90: number[]; max: number[] }

export interface PaceDay {
  day: number
  date: string
  month: number
  complete: boolean
  /** Sub-cell-days per satellite [NOAA-20, NOAA-21]; null = that satellite did not report this day. */
  perSat: [number | null, number | null]
  /** Mean over reporting satellites; null when none reported. */
  viirsCd: number | null
  k: number | null
  /** AFCD-M (or VIIRS cell-days when k is null). */
  value: number | null
  normal: { median: number; q25: number; q75: number }
  /** Accepted detections inside the AOI on this local day (all satellites incl. MODIS). */
  detections: number
}

export interface PaceResult {
  days: PaceDay[]
  /** Mean daily value over complete days with data, AFCD-M/day (VIIRS cell-days/day when calibration = 'none'). */
  pace: number | null
  normalPace: number | null
  normalBand: [number, number] | null
  ratio: number | null
  level: Level | null
  calibration: 'month' | 'all' | 'none'
  nComplete: number
  /** Accepted detections inside the AOI in the whole fetched window, by sat index. */
  detBySat: number[]
  detTotal: number
}

export interface PaceInput {
  rows: LiveRows
  /** inside[i] = row i lies in the AOI polygon. */
  inside: ArrayLike<boolean | number>
  dn: DnFilter
  /** UTC start of the fetched window, epoch s. */
  windowStart: number
  now: number
  /** Longitude used to place local-solar day boundaries (AOI centroid). */
  refLon: number
  /** Which VIIRS sources were fetched successfully. */
  sourceOk: { n20: boolean; n21: boolean }
  calibration: Calibration
  normal: Normal
  /** Number of local-solar days to return, ending with the current one. */
  nDays?: number
}

function levelOf(v: number, q10: number, q25: number, q75: number, q90: number, max: number): Level {
  if (max > 0 && v > max) return 'extreme'
  if (v > q90) return 'well-above'
  if (v > q75) return 'above'
  if (v < q10) return 'well-below'
  if (v < q25) return 'below'
  return 'normal'
}

export function computePace(inp: PaceInput): PaceResult {
  const { rows, inside, dn, windowStart, now, refLon, sourceOk, calibration, normal } = inp
  const nDays = inp.nDays ?? 7
  const today = localSolarDay(now, refLon)
  const first = today - nDays + 1
  const dnOk = (d: number) => dn === 'both' || (dn === 'day' ? d === 0 : d === 1)

  // Per-day row counts per VIIRS satellite over the whole fetched bbox (availability heuristic).
  const anyRows = new Map<number, [number, number]>()
  const sets = new Map<number, [Set<number>, Set<number>]>()
  const detByDay = new Map<number, number>()
  const detBySat = [0, 0, 0, 0]
  let detTotal = 0
  const NX = Math.round(360 / SUBCELL_DEG)
  for (let i = 0; i < rows.n; i++) {
    const s = rows.sat[i]
    const lon = rows.lon[i]
    const d = localSolarDay(rows.t[i], lon)
    if (s === SAT_N20 || s === SAT_N21) {
      const a = anyRows.get(d) ?? [0, 0]
      a[s]++
      anyRows.set(d, a)
    }
    if (!inside[i] || rows.conf[i] < 1 || !dnOk(rows.dn[i])) continue
    detTotal++
    detBySat[s] = (detBySat[s] ?? 0) + 1
    detByDay.set(d, (detByDay.get(d) ?? 0) + 1)
    if (s !== SAT_N20 && s !== SAT_N21) continue
    const ix = Math.floor((lon + 180) / SUBCELL_DEG), iy = Math.floor((rows.lat[i] + 90) / SUBCELL_DEG)
    // (sub-cell, day|night) key; the local-solar day is the map key.
    const key = (iy * NX + ix) * 2 + (rows.dn[i] === 1 ? 1 : 0)
    let pair = sets.get(d)
    if (!pair) { pair = [new Set(), new Set()]; sets.set(d, pair) }
    pair[s].add(key)
  }

  const ok = [sourceOk.n20, sourceOk.n21]
  const days: PaceDay[] = []
  for (let d = first; d <= today; d++) {
    const start = d * 86400 - refLon * 240
    const complete = start >= windowStart && start + 86400 + NRT_LATENCY_SEC <= now
    const a = anyRows.get(d) ?? [0, 0]
    const pair = sets.get(d)
    const perSat = [0, 1].map((s) => {
      if (!ok[s]) return null
      if (a[s] === 0 && a[1 - s] >= OUTAGE_MIN_OTHER) return null // outage or not yet delivered
      return pair ? pair[s].size : 0
    }) as [number | null, number | null]
    const rep = perSat.filter((v): v is number => v != null)
    const viirsCd = rep.length ? rep.reduce((x, y) => x + y, 0) / rep.length : null
    const month = dayMonth(d)
    const k = calibration.byMonth[month - 1] ?? calibration.all
    const dim = daysInMonth(dayYear(d), month)
    days.push({
      day: d, date: dayIso(d), month, complete, perSat, viirsCd, k,
      value: viirsCd == null ? null : k != null ? viirsCd * k : viirsCd,
      normal: { median: normal.median[month - 1] / dim, q25: normal.q25[month - 1] / dim, q75: normal.q75[month - 1] / dim },
      detections: detByDay.get(d) ?? 0,
    })
  }

  const used = days.filter((x) => x.complete && x.value != null)
  const calModes = new Set(used.map((x) => (calibration.byMonth[x.month - 1] != null ? 'month' : calibration.all != null ? 'all' : 'none')))
  const calibrationMode = calModes.has('none') ? 'none' : calModes.has('all') ? 'all' : 'month'
  const mean = (xs: number[]) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null)
  // Values of mixed calibration states are not averaged together: without k for every day, fall back to raw cell-days.
  const vals = used.map((x) => (calibrationMode === 'none' ? x.viirsCd! : x.value!))
  const pace = mean(vals)
  const per = (f: (mo: number, dim: number) => number) => mean(used.map((x) => f(x.month - 1, daysInMonth(dayYear(x.day), x.month))))
  const normalPace = calibrationMode === 'none' ? null : per((m, dim) => normal.median[m] / dim)
  const band: [number, number] | null = calibrationMode === 'none' || !used.length ? null : [per((m, dim) => normal.q25[m] / dim)!, per((m, dim) => normal.q75[m] / dim)!]
  let ratio: number | null = null, level: Level | null = null
  if (pace != null && normalPace != null && normalPace > 0) {
    ratio = pace / normalPace
    level = levelOf(pace, per((m, dim) => normal.q10[m] / dim)!, band![0], band![1], per((m, dim) => normal.q90[m] / dim)!, per((m, dim) => normal.max[m] / dim)!)
  }
  return {
    days, pace, normalPace, normalBand: band, ratio, level,
    calibration: calibrationMode, nComplete: used.length, detBySat, detTotal,
  }
}
