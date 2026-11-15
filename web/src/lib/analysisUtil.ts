import type { Analysis, MonthIndex, SourceCode } from './kernel/types'
import { levelFromPercentile, monthOf, yearOf } from './format'

export const SOURCE_LABEL: Record<SourceCode, string> = {
  0: 'No data',
  1: 'MODIS Terra-only, bridged to Terra + Aqua',
  2: 'MODIS Terra + Aqua (native)',
  3: 'VIIRS, calibrated to MODIS-equivalent',
}
export const SOURCE_SHORT: Record<SourceCode, string> = { 0: '—', 1: 'Terra-bridged', 2: 'MODIS', 3: 'VIIRS-cal' }

export interface MonthStats {
  m: MonthIndex; year: number; month: number
  value: number | null; lo80: number | null; hi80: number | null; lo95: number | null; hi95: number | null
  median: number; ratio: number | null; percentile: number | null; z: number | null
  rank: number | null; of: number; source: SourceCode; provisional: boolean; level: string
  isCurrent: boolean
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
    }
  }
  if (yi < 0) return null
  const value = a.calendar.value[yi][month - 1]
  const col = a.calendar.value.map((row) => row[month - 1]).filter((v): v is number => v != null)
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
    level: levelFromPercentile(pct),
    isCurrent: false,
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
  if (t.direction === 'none' || !Number.isFinite(t.slopePctPerYear)) return 'no significant trend'
  const pct = Math.abs(t.slopePctPerYear)
  const word = t.direction === 'up' ? 'rising' : 'falling'
  return `${word} ~${pct < 1 ? pct.toFixed(1) : Math.round(pct)} %/yr`
}

export const LEVEL_TONE: Record<string, 'critical' | 'serious' | 'warning' | 'neutral' | 'info'> = {
  extreme: 'critical', 'well-above': 'serious', above: 'warning', normal: 'neutral', below: 'info', 'well-below': 'info',
}
