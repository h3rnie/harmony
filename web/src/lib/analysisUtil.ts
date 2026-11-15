import type { Analysis, Meta, MonthIndex, SourceCode } from './kernel/types'
import { levelFromPercentile, monthOf, toM as toYm, yearOf } from './format'

/** Short per-code labels. Prefer `monthSource`, which also reads the per-month MODIS weight. */
export const SOURCE_SHORT: Record<SourceCode, string> = { 0: '—', 1: 'Terra-bridged', 2: 'MODIS', 3: 'VIIRS' }

// ---- optional kernel fields (newer kernels; read defensively so older kernels and mocks keep working) ----

export interface InProgress { m: MonthIndex; coverage: number | null; daysCovered: number | null }
export interface Activity { meanAnnual: number | null; sparse: boolean; reason: string | null }
type Extras = {
  inProgress?: { m?: number; coverage?: number; daysCovered?: number } | null
  activity?: { meanAnnual?: number; sparse?: boolean; reason?: string } | null
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * The newest month when it is still in progress (fewer than ~90 % of its days observed): drawn, flagged partial,
 * never ranked, no level. From `analysis.inProgress` when the kernel provides it; otherwise the newest drawn month
 * whose `series.partial` is set and which lies after the month the kernel describes (`current`).
 */
export function inProgressOf(a: Analysis): InProgress | null {
  const x = (a as Analysis & Extras).inProgress
  const xm = num(x?.m)
  if (x && xm != null) return { m: xm, coverage: num(x.coverage), daysCovered: num(x.daysCovered) }
  const p = a.series.partial
  if (!p) return null
  for (let i = a.months.length - 1; i >= 0; i--) {
    if (a.series.harmonized[i] == null) continue
    return p[i] && a.months[i] > a.current.m ? { m: a.months[i], coverage: null, daysCovered: null } : null
  }
  return null
}
export const isInProgress = (a: Analysis, m: MonthIndex): boolean => inProgressOf(a)?.m === m

/** Days observed so far in the in-progress month: the kernel's count, else the day of `data_through` in that month. */
export function inProgressDays(ip: InProgress, meta: Pick<Meta, 'data_through'> | null | undefined): number | null {
  if (ip.daysCovered != null) return Math.round(ip.daysCovered)
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(meta?.data_through ?? '')
  if (!d) return null
  return +d[1] === yearOf(ip.m) && +d[2] === monthOf(ip.m) ? +d[3] : null
}

/** Kernel `analysis.activity`: mean annual activity and whether the area has too little fire to describe. */
export function activityOf(a: Analysis): Activity | null {
  const x = (a as Analysis & Extras).activity
  if (!x) return null
  return { meanAnnual: num(x.meanAnnual), sparse: x.sparse === true, reason: x.reason ?? null }
}
export const isSparse = (a: Analysis): boolean => activityOf(a)?.sparse === true
/** The trend is not worth stating (kernel `trend.suppressed`, or a sparse area). */
export const trendSuppressed = (a: Analysis): boolean => (a.trend as { suppressed?: boolean }).suppressed === true || isSparse(a)
/** The fire season is not defined here (kernel `season.defined === false`, or a sparse area). */
export const seasonUndefined = (a: Analysis): boolean => (a.season as { defined?: boolean }).defined === false || isSparse(a)
/** Mean annual activity for the sparse-area sentence: the kernel's figure, else the mean of complete years. */
export function meanAnnual(a: Analysis): number | null {
  const k = activityOf(a)?.meanAnnual
  if (k != null) return k
  const t = a.annual.total.filter((v, i): v is number => v != null && a.annual.complete[i])
  return t.length ? t.reduce((x, y) => x + y, 0) / t.length : null
}

// ---- where a month's value comes from ----

export type Era = 'none' | 'terra' | 'modis' | 'fused' | 'viirs'
export interface MonthSource { era: Era; w: number | null; label: string; short: string }

/**
 * Honest per-month provenance from the kernel's source code and MODIS weight (share of the value carried by MODIS):
 * "MODIS only", "MODIS + VIIRS, fused (MODIS share 34 %)", "VIIRS only", "Terra only, bridged".
 */
export function monthSource(a: Analysis, si: number): MonthSource {
  const src = (si >= 0 ? a.series.source[si] : 0) as SourceCode
  if (src === 0) return { era: 'none', w: null, label: 'No data', short: '—' }
  const raw = si >= 0 ? a.series.modisWeight?.[si] : null
  const w = raw != null && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null
  if (src === 1 && (w == null || w >= 0.995)) return { era: 'terra', w, label: 'Terra only, bridged', short: 'Terra-bridged' }
  if (w == null) {
    return src === 3 ? { era: 'viirs', w, label: 'VIIRS only', short: 'VIIRS' } : { era: 'modis', w, label: 'MODIS only', short: 'MODIS' }
  }
  if (w >= 0.995) return { era: 'modis', w, label: 'MODIS only', short: 'MODIS' }
  if (w <= 0.005) return { era: 'viirs', w, label: 'VIIRS only', short: 'VIIRS' }
  const pct = Math.round(w * 100)
  return { era: 'fused', w, label: `MODIS + VIIRS, fused (MODIS share ${pct} %)`, short: `Fused (MODIS ${pct} %)` }
}
/** The calendar's corner mark: VIIRS carries most of the month's value. */
export const viirsMark = (s: MonthSource): boolean => s.era === 'viirs' || (s.era === 'fused' && (s.w ?? 1) < 0.5)

export interface MonthStats {
  m: MonthIndex; year: number; month: number
  value: number | null; lo80: number | null; hi80: number | null; lo95: number | null; hi95: number | null
  median: number; ratio: number | null; percentile: number | null; z: number | null
  rank: number | null; of: number; source: SourceCode; provisional: boolean; level: string
  isCurrent: boolean
  /** Month still in progress: no ratio, percentile, rank or level is stated for it. */
  inProgress: boolean
  /** Per-month provenance (see monthSource). */
  src: MonthSource
}

export function seriesIndex(a: Analysis, m: MonthIndex): number {
  if (!a.months.length) return -1
  const i = m - a.months[0]
  return a.months[i] === m ? i : a.months.indexOf(m)
}

/** Everything the UI says about one month, using kernel fields where they exist. */
export function monthStats(a: Analysis, m: MonthIndex): MonthStats | null {
  const year = yearOf(m), month = monthOf(m)
  const yi = a.calendar.years.indexOf(year)
  const si = seriesIndex(a, m)
  if (a.current.m === m) {
    const c = a.current
    return {
      m, year, month, value: c.value, lo80: c.lo80, hi80: c.hi80,
      lo95: si >= 0 ? a.series.lo95[si] : null, hi95: si >= 0 ? a.series.hi95[si] : null,
      median: c.median, ratio: c.ratio, percentile: c.percentile, z: c.z, rank: c.rank, of: c.of,
      source: si >= 0 ? a.series.source[si] : 0, provisional: c.provisional, level: c.level, isCurrent: true,
      inProgress: false, src: monthSource(a, si),
    }
  }
  if (yi < 0) return null
  const value = a.calendar.value[yi][month - 1]
  if (value != null && isInProgress(a, m)) {
    return {
      m, year, month, value, lo80: si >= 0 ? a.series.lo80[si] : null, hi80: si >= 0 ? a.series.hi80[si] : null,
      lo95: null, hi95: null, median: a.climatology.median[month - 1], ratio: null, percentile: null, z: null,
      rank: null, of: 0, source: si >= 0 ? a.series.source[si] : 0, provisional: si >= 0 ? a.series.provisional[si] : false,
      level: 'in-progress', isCurrent: false, inProgress: true, src: monthSource(a, si),
    }
  }
  // Same-month ranks never count the month in progress.
  const ip = inProgressOf(a)
  const col = a.calendar.value
    .map((row, i) => (ip && toYm(a.calendar.years[i], month) === ip.m ? null : row[month - 1]))
    .filter((v): v is number => v != null)
  const pct = a.calendar.percentile[yi][month - 1]
  return {
    m, year, month, value,
    lo80: si >= 0 ? a.series.lo80[si] : null, hi80: si >= 0 ? a.series.hi80[si] : null,
    lo95: si >= 0 ? a.series.lo95[si] : null, hi95: si >= 0 ? a.series.hi95[si] : null,
    median: a.climatology.median[month - 1],
    ratio: a.calendar.ratio[yi][month - 1],
    percentile: pct,
    z: a.calendar.z[yi][month - 1],
    rank: value == null ? null : 1 + col.filter((v) => v > value).length,
    of: col.length,
    source: si >= 0 ? a.series.source[si] : 0,
    provisional: si >= 0 ? a.series.provisional[si] : false,
    level: isSparse(a) ? 'undefined' : levelFromPercentile(pct, a.calendar.ratio[yi][month - 1], a.climatology.median[month - 1]),
    isCurrent: false,
    inProgress: false,
    src: monthSource(a, si),
  }
}

/** Theil–Sen intercept is not in the contract; derive it as median(y - slope * x) over complete years. */
export function trendLine(a: Analysis): { x0: number; x1: number; y0: number; y1: number } | null {
  const { years, total, complete } = a.annual
  const [t0, t1] = a.trend.years
  const pts: number[] = []
  years.forEach((y, i) => {
    if (complete[i] && total[i] != null && y >= t0 && y <= t1) pts.push(total[i]! - a.trend.slopePerYear * y)
  })
  if (pts.length < 2) return null
  pts.sort((p, q) => p - q)
  const mid = pts.length / 2
  const b = pts.length % 2 ? pts[Math.floor(mid)] : (pts[mid - 1] + pts[mid]) / 2
  return { x0: t0, x1: t1, y0: b + a.trend.slopePerYear * t0, y1: b + a.trend.slopePerYear * t1 }
}

export function trendWords(a: Analysis): string {
  const t = a.trend
  if (trendSuppressed(a)) return 'too little fire to measure a trend'
  if (t.direction === 'none' || !Number.isFinite(t.slopePctPerYear)) return 'no significant trend'
  const pct = Math.abs(t.slopePctPerYear)
  const word = t.direction === 'up' ? 'rising' : 'falling'
  return `${word} ~${pct < 1 ? pct.toFixed(1) : Math.round(pct)} %/yr`
}

// Only real levels have a tone; "undefined" (sparse area) and "in-progress" are deliberately absent (see hasLevel).
export const LEVEL_TONE: Record<string, 'critical' | 'serious' | 'warning' | 'neutral' | 'info'> = {
  extreme: 'critical', 'well-above': 'serious', above: 'warning', normal: 'neutral', below: 'info', 'well-below': 'info',
}

/** Levels that may be shown as a chip; "undefined" (sparse area) and "in-progress" never are. */
export const hasLevel = (level: string): boolean => level in LEVEL_TONE
