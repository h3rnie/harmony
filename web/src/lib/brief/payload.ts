// The compact statistics payload sent to POST /api/brief. This file is shared by the client (which builds it)
// and the server (which validates it against the same shape), so keep it free of DOM / Svelte imports.
//
// Design rules:
//  - Only numbers the brief may quote. Everything is already rounded to a sensible precision.
//  - Rank fields say which end is which (1 = most active) so the model cannot flip them.
//  - The area label is the only free text and is untrusted; the server sanitises it again.
import type { Analysis } from '../kernel/types'
import { LEVELS, PAYLOAD_VERSION, type BriefPayload, type Level } from './payloadTypes'
import { monthStats } from '../analysisUtil'
import { MONTHS_LONG, monthLong } from '../format'

export * from './payloadTypes'

export interface PayloadInput {
  areaLabel: string
  isPreset: boolean
  areaKm2: number
  centroid: [number, number]
  focusM: number
  firstYear: number
  baseline: [number, number]
  dataThrough: string | null
  analysis: Analysis
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const r = (v: number | null | undefined, d = 2): number | null => (fin(v) ? +v.toFixed(d) : null)
const r0 = (v: number): number => +v.toFixed(1)

/** Strict ISO date prefix only; anything else is dropped rather than forwarded. */
function isoDate(s: string | null | undefined): string | null {
  const m = typeof s === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(s) : null
  return m ? m[0] : null
}

export function buildBriefPayload(i: PayloadInput): BriefPayload | null {
  const a = i.analysis
  const s = monthStats(a, i.focusM)
  if (!s) return null
  const se = a.season
  const inSeason = ((s.month - se.startMonth + 12) % 12) < se.lengthMonths
  const o = a.outlook
  const tr = a.trend
  return {
    v: PAYLOAD_VERSION,
    area: {
      label: i.areaLabel,
      isPreset: i.isPreset,
      km2: Math.round(i.areaKm2),
      centroid: [+i.centroid[0].toFixed(2), +i.centroid[1].toFixed(2)],
    },
    month: {
      label: monthLong(i.focusM),
      monthName: MONTHS_LONG[s.month - 1],
      year: s.year,
      value: s.value == null ? null : r0(s.value),
      interval80: fin(s.lo80) && fin(s.hi80) ? [r0(s.lo80), r0(s.hi80)] : null,
      median: r0(s.median),
      ratio: r(s.ratio),
      percentile: fin(s.percentile) ? Math.round(s.percentile) : null,
      rankMostActive: s.rank,
      ofYears: s.of,
      level: (LEVELS as readonly string[]).includes(s.level) ? (s.level as Level) : 'normal',
      provisional: s.provisional,
      isLatestMonth: s.isCurrent,
    },
    yearToDate: {
      year: a.ytd.year,
      throughMonth: MONTHS_LONG[a.ytd.throughMonth - 1],
      ratio: r(a.ytd.ratio),
      rankMostActive: a.ytd.rank,
      ofYears: a.ytd.of,
    },
    season: {
      peakMonth: MONTHS_LONG[se.peakMonth - 1],
      startMonth: MONTHS_LONG[se.startMonth - 1],
      endMonth: MONTHS_LONG[se.endMonth - 1],
      lengthMonths: se.lengthMonths,
      secondPeak: se.secondPeak ? MONTHS_LONG[se.secondPeak - 1] : null,
      viewedMonthInSeason: inSeason,
    },
    trend: {
      years: [tr.years[0], tr.years[1]],
      pctPerYear: r(tr.slopePctPerYear, 1),
      pValue: r(tr.pValue, 3),
      direction: tr.direction,
    },
    outlook:
      s.isCurrent && o.months.length
        ? {
            method: o.method,
            skill: r(o.skill) ?? 0,
            months: o.months.slice(0, 3).map((m, k) => ({
              label: monthLong(m), median: r0(o.median[k]), lo80: r0(o.lo80[k]), hi80: r0(o.hi80[k]), normal: r0(o.climatology[k]),
            })),
          }
        : null,
    records: {
      topMonths: a.records.topMonths.slice(0, 3).map((t) => ({ label: monthLong(t.m), value: r0(t.value), ratio: r(t.ratio) })),
      topYears: a.records.topYears.slice(0, 3).map((t) => ({ year: t.year, total: Math.round(t.total) })),
    },
    seam: {
      nMonths: a.seam.nMonths,
      rawViirsToModisRatio: r(a.seam.ratioNaive),
      harmonizedRatio: r(a.seam.ratioHarmonized),
      correlation: r(a.seam.r),
    },
    provenance: {
      dataThrough: isoDate(i.dataThrough),
      recordStartYear: i.firstYear,
      baselineYears: [i.baseline[0], i.baseline[1]],
    },
  }
}

/**
 * Stable key for "did the statistics meaningfully change". JSON of the payload is already rounded, so equal
 * statistics give equal keys; the card uses this to decide when to ask again.
 */
export function payloadKey(p: BriefPayload): string {
  return JSON.stringify(p)
}

