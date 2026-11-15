// Rule-based situation brief: 4-6 plain sentences a duty officer can read aloud.
import type { Analysis } from '../kernel/types'
import { monthStats, trendWords } from '../analysisUtil'
import { LEVEL_LABEL, MONTHS_LONG, fmtArea, fmtNum, fmtRatio, monthLong, ordinal, rankFromEnds, rankPhrase } from '../format'

export interface BriefInput {
  area: string
  areaKm2: number
  focusM: number
  firstYear: number
  baseline: [number, number]
  analysis: Analysis
}

export function templateBrief(i: BriefInput): string[] {
  const a = i.analysis
  const s = monthStats(a, i.focusM)
  const out: string[] = []
  if (!s) return ['No analysis is available for this area yet.']
  const mName = MONTHS_LONG[s.month - 1]
  const levelWord = (LEVEL_LABEL[s.level] ?? s.level).toLowerCase()

  // 1. Headline
  let head = `${i.area} (${fmtArea(i.areaKm2)}): burning activity in ${monthLong(i.focusM)} is ${fmtRatio(s.ratio)} the ${mName} normal — ${levelWord}`
  if (s.rank != null) head += `, the ${rankFromEnds(s.rank, s.of)} ${mName} since ${i.firstYear}`
  if (s.percentile != null) head += ` (${ordinal(Math.round(s.percentile))} percentile)`
  out.push(head + '.')

  // 2. Numbers + provisional caveat
  let n2 = `That is ${fmtNum(s.value)} MODIS-equivalent active-fire cell-days against a ${i.baseline[0]}–${i.baseline[1]} median of ${fmtNum(s.median)}`
  if (s.lo80 != null && s.hi80 != null) n2 += `, with an 80 % range of ${fmtNum(s.lo80)} to ${fmtNum(s.hi80)}`
  n2 += '.'
  if (s.provisional) n2 += ' These figures are provisional, from near-real-time detections, and may be revised.'
  out.push(n2)

  // 3. Year context: year-to-date for the current year, the annual total for a past year
  const y = a.ytd
  if (s.year === y.year && y.ratio != null) {
    out.push(`Year to date, ${y.year} is running at ${fmtRatio(y.ratio)} the median through ${MONTHS_LONG[y.throughMonth - 1]}, ${rankPhrase(y.rank, 'highest')} of ${y.of} years on record.`)
  } else {
    const ai = a.annual.years.indexOf(s.year)
    const rank = ai >= 0 ? a.annual.rank[ai] : null
    const nComplete = a.annual.complete.filter(Boolean).length
    if (ai >= 0 && a.annual.total[ai] != null && rank != null) {
      out.push(`${s.year} as a whole totalled ${fmtNum(a.annual.total[ai])}, the ${rankPhrase(rank, 'highest')} of ${nComplete} complete years.`)
    }
  }

  // 4. Season context
  const se = a.season
  const inSeason = ((s.month - se.startMonth + 12) % 12) < se.lengthMonths
  out.push(
    `The fire season here normally runs ${MONTHS_LONG[se.startMonth - 1]} to ${MONTHS_LONG[se.endMonth - 1]} and peaks in ${MONTHS_LONG[se.peakMonth - 1]}` +
      `${se.secondPeak ? `, with a second peak in ${MONTHS_LONG[se.secondPeak - 1]}` : ''}; ${mName} is ${inSeason ? 'inside' : 'outside'} that season.`,
  )

  // 5. Trend
  out.push(`Across ${a.trend.years[0]}–${a.trend.years[1]}, annual activity shows ${trendWords(a)}.`)

  // 6. Outlook (only when describing the latest month)
  const o = a.outlook
  if (s.isCurrent && o.months.length) {
    const nm = monthLong(o.months[0])
    if (o.method === 'climatology' || o.skill <= 0) {
      out.push(`For ${nm} there is no forecast skill beyond climatology; expect around the seasonal normal of ${fmtNum(o.climatology[0])}.`)
    } else {
      out.push(`For ${nm} the outlook is ${fmtNum(o.median[0])} (80 % range ${fmtNum(o.lo80[0])}–${fmtNum(o.hi80[0])}) against a normal of ${fmtNum(o.climatology[0])}.`)
    }
  }
  return out.slice(0, 6)
}
