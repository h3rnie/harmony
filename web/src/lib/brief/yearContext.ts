// "What year is the brief talking about?" Shared by the dossier builder and the rule-based template so both agree.
//
//  - Latest month: year to date comes from the kernel (current year through the latest month), with the outlook.
//  - Any earlier month (e.g. September 2020): the brief describes THAT year: year to date through the viewed month,
//    computed from the calendar matrix, against the baseline median year to date; plus that year's annual rank
//    when the year is complete. The outlook is omitted by the callers.
import type { Analysis } from '../kernel/types'
import type { MonthStats } from '../analysisUtil'

export interface YearContext {
  ytd: { year: number; throughMonth: number; ratio: number | null; rank: number | null; of: number }
  /** Null while the viewed month's year is incomplete. */
  annual: { year: number; total: number; rank: number; of: number } | null
}

/** Cumulative sum through `k` months (1..12); null as soon as a month is outside the record (same rule as the kernel). */
function cumulative(row: (number | null)[], k: number): number | null {
  let acc = 0
  for (let i = 0; i < k; i++) {
    const v = row[i]
    if (v == null) return null
    acc += v
  }
  return acc
}

function annualFor(a: Analysis, year: number): YearContext['annual'] {
  const i = a.annual.years.indexOf(year)
  if (i < 0) return null
  const total = a.annual.total[i]
  const rank = a.annual.rank[i]
  if (!a.annual.complete[i] || total == null || rank == null) return null
  return { year, total, rank, of: a.annual.complete.filter(Boolean).length }
}

export function yearContext(a: Analysis, s: MonthStats): YearContext | null {
  if (s.isCurrent) {
    const y = a.ytd
    return { ytd: { year: y.year, throughMonth: y.throughMonth, ratio: y.ratio, rank: y.rank, of: y.of }, annual: annualFor(a, y.year) }
  }
  const yi = a.calendar.years.indexOf(s.year)
  if (yi < 0) return null
  const cur = cumulative(a.calendar.value[yi], s.month)
  let rank: number | null = null
  let of = 0
  let ratio: number | null = null
  if (cur != null) {
    const others: number[] = []
    a.calendar.years.forEach((_, i) => {
      if (i === yi) return
      const c = cumulative(a.calendar.value[i], s.month)
      if (c != null) others.push(c)
    })
    rank = 1 + others.filter((v) => v > cur).length
    of = others.length + 1
    const med = a.ytd.median[s.month - 1]
    ratio = med != null && med > 1e-9 ? cur / med : null
  }
  return { ytd: { year: s.year, throughMonth: s.month, ratio, rank, of }, annual: annualFor(a, s.year) }
}
