// Builds the area dossier (see dossierTypes.ts) from the kernel's Analysis. Pure: no DOM, no Svelte.
import type { Analysis } from '../kernel/types'
import { monthStats, seriesIndex } from '../analysisUtil'
import { MONTHS_LONG, monthLong, toM } from '../format'
import { DOSSIER_VERSION, LEVELS, type Dossier, type DossierUnit, type Level, type LiveNow } from './dossierTypes'
import { fix, sig } from './round'
import { yearContext } from './yearContext'

export * from './dossierTypes'

export interface DossierInput {
  areaLabel: string
  isPreset: boolean
  areaKm2: number
  centroid: [number, number]
  focusM: number
  firstYear: number
  baseline: [number, number]
  dataThrough: string | null
  dayNight: 'both' | 'day' | 'night'
  switchM: number
  aquaStartM: number
  viirsStartM: number
  analysis: Analysis
  /** Units lens the values are on; defaults to what the analysis itself reports (`harmonization.unit`), else 'modis'. */
  unit?: DossierUnit
  /** Optional live summary; only passed for follow-up questions. */
  now?: LiveNow | null
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)
const r = (v: number | null | undefined, d = 2): number | null => (fin(v) ? fix(v, d) : null)
const r1 = (v: number): number => fix(v, 1)

/** Strict ISO date prefix only; anything else is dropped rather than forwarded. */
function isoDate(s: string | null | undefined): string | null {
  const m = typeof s === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(s) : null
  return m ? m[0] : null
}

/** Up to 3 other years whose January..viewed-month profile (log1p) is closest to the viewed year's. */
export function similarYears(a: Analysis, year: number, throughMonth: number): number[] {
  const yi = a.calendar.years.indexOf(year)
  if (yi < 0) return []
  const base = a.calendar.value[yi].slice(0, throughMonth)
  if (base.some((v) => v == null)) return []
  const scored: { y: number; d: number }[] = []
  a.calendar.years.forEach((y, i) => {
    if (i === yi) return
    const row = a.calendar.value[i].slice(0, throughMonth)
    if (row.length < throughMonth || row.some((v) => v == null)) return
    let d = 0
    for (let k = 0; k < throughMonth; k++) d += Math.abs(Math.log1p(row[k] as number) - Math.log1p(base[k] as number))
    scored.push({ y, d: d / throughMonth })
  })
  scored.sort((p, q) => p.d - q.d || p.y - q.y)
  return scored.slice(0, 3).map((x) => x.y)
}

export function buildDossier(i: DossierInput): Dossier | null {
  const a = i.analysis
  const s = monthStats(a, i.focusM)
  if (!s) return null
  const yc = yearContext(a, s)
  if (!yc) return null
  const se = a.season
  const inSeason = ((s.month - se.startMonth + 12) % 12) < se.lengthMonths
  const o = a.outlook
  const tr = a.trend
  const cl = a.climatology
  const sig12 = (xs: number[]) => xs.slice(0, 12).map((v) => sig(v))

  const years = a.calendar.years
  const afcd = years.map((_, yi) => a.calendar.value[yi].map((v) => (v == null ? null : sig(v))))
  const pct = years.map((_, yi) => a.calendar.percentile[yi].map((p) => (p == null ? null : Math.round(p))))
  const source = years.map((y, yi) =>
    a.calendar.value[yi].map((v, k) => {
      if (v == null) return '0'
      const si = seriesIndex(a, toM(y, k + 1))
      return si >= 0 ? String(a.series.source[si]) : 'x'
    }).join(''),
  )
  const annualIdx = years.map((y) => a.annual.years.indexOf(y))
  const annualTotal = annualIdx.map((k) => (k >= 0 && a.annual.complete[k] && a.annual.total[k] != null ? sig(a.annual.total[k] as number) : null))
  const annualRank = annualIdx.map((k) => (k >= 0 && a.annual.complete[k] ? a.annual.rank[k] : null))
  const provisionalMonths: string[] = []
  a.months.forEach((m, k) => { if (a.series.provisional[k]) provisionalMonths.push(monthLong(m)) })

  const dossier: Dossier = {
    v: DOSSIER_VERSION,
    unit: i.unit ?? a.harmonization?.unit ?? 'modis',
    area: {
      label: i.areaLabel,
      isPreset: i.isPreset,
      km2: Math.round(i.areaKm2),
      centroid: [fix(i.centroid[0], 2), fix(i.centroid[1], 2)],
    },
    month: {
      label: monthLong(i.focusM),
      monthName: MONTHS_LONG[s.month - 1],
      year: s.year,
      value: s.value == null ? null : r1(s.value),
      interval80: fin(s.lo80) && fin(s.hi80) ? [r1(s.lo80), r1(s.hi80)] : null,
      median: r1(s.median),
      ratio: r(s.ratio),
      percentile: fin(s.percentile) ? Math.round(s.percentile) : null,
      rankMostActive: s.rank,
      ofYears: s.of,
      level: (LEVELS as readonly string[]).includes(s.level) ? (s.level as Level) : 'normal',
      provisional: s.provisional,
      isLatestMonth: s.isCurrent,
    },
    yearToDate: {
      year: yc.ytd.year,
      throughMonth: MONTHS_LONG[yc.ytd.throughMonth - 1],
      ratio: r(yc.ytd.ratio),
      rankMostActive: yc.ytd.rank,
      ofYears: yc.ytd.of,
    },
    annual: yc.annual ? { year: yc.annual.year, total: sig(yc.annual.total), rankMostActive: yc.annual.rank, ofCompleteYears: yc.annual.of } : null,
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
    // A forecast only makes sense from the latest month; for a past month the brief describes that year instead.
    outlook:
      s.isCurrent && o.months.length
        ? {
            method: o.method,
            skill: r(o.skill) ?? 0,
            months: o.months.slice(0, 3).map((m, k) => ({
              label: monthLong(m), median: r1(o.median[k]), lo80: r1(o.lo80[k]), hi80: r1(o.hi80[k]), normal: r1(o.climatology[k]),
            })),
          }
        : null,
    records: {
      topMonths: a.records.topMonths.slice(0, 3).map((t) => ({ label: monthLong(t.m), value: r1(t.value), ratio: r(t.ratio) })),
      topYears: a.records.topYears.slice(0, 3).map((t) => ({ year: t.year, total: Math.round(t.total) })),
    },
    seam: {
      nMonths: a.seam.nMonths,
      rawViirsToModisRatio: r(a.seam.ratioNaive),
      harmonizedRatio: r(a.seam.ratioHarmonized),
      correlation: r(a.seam.r),
      biasPct: r(a.seam.biasPct, 1),
    },
    provenance: {
      dataThrough: isoDate(i.dataThrough),
      recordStartYear: i.firstYear,
      baselineYears: [i.baseline[0], i.baseline[1]],
      dayNight: i.dayNight,
      switchMonth: monthLong(i.switchM),
      aquaStartMonth: monthLong(i.aquaStartM),
      viirsStartMonth: monthLong(i.viirsStartM),
      provisionalMonths: provisionalMonths.slice(-6),
    },
    detail: {
      years,
      afcd,
      pct,
      source,
      climatology: { median: sig12(cl.median), q10: sig12(cl.q10), q25: sig12(cl.q25), q75: sig12(cl.q75), q90: sig12(cl.q90) },
      annualTotal,
      annualRank,
      similarYears: similarYears(a, s.year, s.month),
    },
  }
  if (i.now) dossier.now = i.now
  return dossier
}

/** The dossier without the volatile `now`: equal statistics give an equal key, so identical numbers never re-ask. */
export function dossierKey(d: Dossier): string {
  const { now: _now, ...rest } = d
  void _now
  return JSON.stringify(rest)
}
