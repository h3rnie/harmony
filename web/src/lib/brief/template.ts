// Rule-based situation brief: 4-6 plain sentences a duty officer can read aloud.
import type { Analysis } from '../kernel/types'
import { hasLevel, inProgressDays, inProgressOf, isSparse, meanAnnual, monthStats, onPace, seasonOneMonth, seasonUndefined, trendSuppressed, trendWords } from '../analysisUtil'
import { yearContext } from './yearContext'
import { LEVEL_LABEL, MONTHS_LONG, fmtArea, fmtNum, fmtRatio, monthLong, ordinal, rankFromEnds, rankPhrase } from '../format'

export interface BriefInput {
  area: string
  areaKm2: number
  focusM: number
  firstYear: number
  baseline: [number, number]
  analysis: Analysis
  /** ISO date of the newest data (meta.data_through): how many days of a month in progress are covered. */
  dataThrough?: string | null
}

export function templateBrief(i: BriefInput): string[] {
  const a = i.analysis
  const s = monthStats(a, i.focusM)
  const out: string[] = []
  if (!s) return ['No analysis is available for this area yet.']
  const mName = MONTHS_LONG[s.month - 1]
  const unit = a.harmonization?.unit === 'viirs' ? 'VIIRS' : 'MODIS'
  const unitShort = a.harmonization?.unit === 'viirs' ? 'AFCD-V' : 'AFCD-M'
  const where = `${i.area} (${fmtArea(i.areaKm2)})`
  const ip = inProgressOf(a)
  const ipDays = ip ? inProgressDays(ip, { data_through: i.dataThrough ?? '' }) : null
  const ipPhrase = (m: number) => `${monthLong(m)} is still in progress${ipDays != null ? ` (first ${ipDays} ${ipDays === 1 ? 'day' : 'days'})` : ''}`

  // Too little fire to describe a season, a level or a trend: one calm statement and the plain totals.
  if (isSparse(a)) {
    out.push(`${where}: too little fire here to describe a season or a trend: about ${fmtNum(meanAnnual(a) ?? 0)} ${unitShort} a year.`)
    out.push(s.value === 0 || s.value == null
      ? `No fire was detected in ${monthLong(i.focusM)}.`
      : `${monthLong(i.focusM)}: ${fmtNum(s.value)} ${unit}-equivalent active-fire cell-days${s.inProgress ? ' so far' : ''}.`)
    return out
  }

  // The month in view is still in progress: what has been seen so far, never a level or a rank.
  if (s.inProgress) {
    const pace = ip?.m === i.focusM ? onPace(ip) : null
    out.push(`${where}: ${ipPhrase(i.focusM)}; ${s.value ? `${fmtNum(s.value)} ${unit}-equivalent active-fire cell-days so far` : 'no fire detected so far'}${pace ? ` (${pace})` : ''}.`)
    out.push('It is compared with normal and ranked once the month is complete; see what is burning right now for the latest days.')
    return out
  }

  // 1. Headline
  const levelWord = hasLevel(s.level) ? (LEVEL_LABEL[s.level] ?? s.level).toLowerCase() : null
  const verb = s.isCurrent ? 'is' : 'was'
  let head: string
  if (!s.value) {
    head = `${where}: no fire was detected in ${monthLong(i.focusM)}`
    head += s.median > 0 ? `, against a ${mName} normal of ${fmtNum(s.median)}` : `, as usual for ${mName} here`
  } else if (s.ratio == null || !levelWord) {
    head = `${where}: ${fmtNum(s.value)} ${unitShort} in ${monthLong(i.focusM)}`
    if (!(s.median > 0)) head += `; ${mName} normally has no detections here`
  } else {
    head = `${where}: burning activity in ${monthLong(i.focusM)} ${verb} ${fmtRatio(s.ratio)} the ${mName} normal (${levelWord})`
    if (s.rank != null) head += `, the ${rankFromEnds(s.rank, s.of)} ${mName} since ${i.firstYear}`
    if (s.percentile != null) head += ` (${ordinal(Math.round(s.percentile))} percentile)`
  }
  out.push(head + '.')

  // 2. Numbers + provisional caveat (skipped for a month with no detections: there is nothing to qualify)
  if (s.value) {
    let n2 = `That is ${fmtNum(s.value)} ${unit}-equivalent active-fire cell-days against a ${i.baseline[0]}–${i.baseline[1]} median of ${fmtNum(s.median)}`
    if (s.lo80 != null && s.hi80 != null && s.hi80 > 0) n2 += `, with an 80 % range of ${fmtNum(s.lo80)} to ${fmtNum(s.hi80)}`
    n2 += '.'
    if (s.provisional) n2 += ' These figures are provisional, from near-real-time detections, and may be revised.'
    out.push(n2)
  }

  // 3. Year context. Latest month: current year to date. A past month: THAT year (year to date through the viewed
  //    month, computed from the calendar matrix, plus its annual rank when complete); never the current year.
  const yc = yearContext(a, s)
  if (yc) {
    const y = yc.ytd
    const v2 = s.isCurrent ? 'is running at' : 'ran at'
    if (y.ratio != null && y.rank != null) {
      out.push(`Year to date, ${y.year} ${v2} ${fmtRatio(y.ratio)} the median through ${MONTHS_LONG[y.throughMonth - 1]}, ${rankPhrase(y.rank, 'highest')} of ${y.of} years on record.`)
    }
    if (yc.annual) {
      out.push(`${yc.annual.year} as a whole totalled ${fmtNum(yc.annual.total)}, the ${rankPhrase(yc.annual.rank, 'highest')} of ${yc.annual.of} complete years.`)
    }
  }

  // 4. Season context
  const se = a.season
  // Nothing is said about a season where none can be described.
  if (!seasonUndefined(a) && seasonOneMonth(a)) {
    out.push(`Most burning here normally happens in ${MONTHS_LONG[se.peakMonth - 1]}${s.month === se.peakMonth ? ', the month in view' : ''}.`)
  } else if (!seasonUndefined(a)) {
    const inSeason = ((s.month - se.startMonth + 12) % 12) < se.lengthMonths
    out.push(
      `The fire season here normally runs ${MONTHS_LONG[se.startMonth - 1]} to ${MONTHS_LONG[se.endMonth - 1]} and peaks in ${MONTHS_LONG[se.peakMonth - 1]}` +
        `${se.secondPeak ? `, with a second peak in ${MONTHS_LONG[se.secondPeak - 1]}` : ''}; ${mName} is ${inSeason ? 'inside' : 'outside'} that season.`,
    )
  }

  // 5. Trend
  if (!trendSuppressed(a)) out.push(`Across ${a.trend.years[0]}–${a.trend.years[1]}, annual activity shows ${trendWords(a)}.`)

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
  const lines = out.slice(0, 6)
  // The newest month is in progress: say so once, after the latest complete month.
  if (s.isCurrent && ip) lines.push(`${ipPhrase(ip.m)} and is not yet compared with normal.`)
  return lines
}
