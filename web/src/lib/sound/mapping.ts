// Sonification, pure part: value -> pitch, the event schedule of each listening mode, and the words that say the
// same thing for people who cannot hear it. No Web Audio here (see player.ts), no runtime imports, so
// scripts/sound-test.mjs runs this file directly under Node.
//
// Design (auditory-graph practice):
// - Positive polarity: more fire = higher pitch (Walker & Mauney 2010 found blind and sighted listeners mostly agree
//   on polarity; Highcharts' sonification defaults map higher values to higher pitch).
// - Pitch is log-scaled over about 2.4 octaves, C4 (262 Hz) to about F6 (1.38 kHz), anchored to this area's own range:
//   the quietest positive month sounds at the bottom, the busiest at the top. Equal ratios sound as equal intervals.
// - 100–250 ms per month (adjustable); a soft noise tick before each January, with the year shown and announced.
// - Months outside the record are silent; months with no detections play the lowest note, softly, in a different timbre.
// - "Normal" is a separate, quieter reference tone played just BEFORE the month's own tone, never at the same time,
//   so above/below normal is heard as the step up or down between two notes, not as beating between detuned voices.

export type ListenMode = 'record' | 'seam' | 'year'

export const F_LOW = 261.63 // C4
export const OCTAVES = 2.4 // top ≈ 1.38 kHz (about F6); G4–F6 is the most accurately judged band
export const SPEEDS = { slow: 250, normal: 160, fast: 100 } as const
export type Speed = keyof typeof SPEEDS

export interface PitchScale { lo: number; hi: number; fLow: number; octaves: number }

/** Log pitch scale anchored to the positive values given (the area's own range). */
export function pitchScale(values: Iterable<number | null | undefined>, fLow = F_LOW, octaves = OCTAVES): PitchScale {
  let lo = Infinity, hi = 0
  for (const v of values) if (v != null && Number.isFinite(v) && v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  if (!(hi > 0)) return { lo: 1, hi: 10, fLow, octaves }
  lo = Math.max(lo, hi / 1e4)
  if (!(lo < hi)) lo = hi / 10
  return { lo, hi, fLow, octaves }
}

/** Frequency in Hz for a value (> 0) on the scale; values outside the range are clamped to its ends. 0 -> the floor. */
export function freqFor(v: number, s: PitchScale): number {
  if (!(v > 0)) return s.fLow
  const u = Math.log(v / s.lo) / Math.log(s.hi / s.lo)
  return s.fLow * 2 ** (s.octaves * Math.max(0, Math.min(1, u)))
}

export type EventKind = 'value' | 'zero' | 'rest' | 'normal' | 'tick' | 'pause'

export interface ToneEvent {
  /** Seconds from the start. */
  t: number
  dur: number
  kind: EventKind
  /** Hz for 'value' | 'zero' | 'normal'; null otherwise. */
  freq: number | null
  /** Month index the event belongs to (highlighted while it sounds); null for ticks and pauses. */
  m: number | null
  /** Set on the first event of each year (the tick): what the year readout and live region say. */
  year: number | null
  /** Set on the first event of a part ("Raw counts", "Harmonized record"). */
  part?: string
}

export interface Schedule { mode: ListenMode; events: ToneEvent[]; duration: number; msPerMonth: number; scale: PitchScale; note: string }

/** Everything the schedule needs from an analysis (kept apart from the kernel types so it is testable). */
export interface ListenInput {
  months: number[]
  harmonized: (number | null)[]
  /** Naive concatenation: MODIS counts before VIIRS starts, VIIRS counts after. */
  naive: number[]
  /** Normal (baseline median) per calendar month, length 12. */
  median: number[]
  /** Displayed months, inclusive. */
  range: [number, number]
  viirsStartM: number
  /** The month the answer describes as "latest" (the "this year" mode stops here). */
  currentM: number
  annual?: { years: number[]; total: (number | null)[]; complete: boolean[] }
}

export interface ScheduleOptions { msPerMonth?: number; withNormal?: boolean }

const yearOf = (m: number) => 2000 + Math.floor(m / 12)
const moy = (m: number) => ((m % 12) + 12) % 12
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const h = v.length / 2
  return v.length % 2 ? v[Math.floor(h)] : (v[h - 1] + v[h]) / 2
}

/** Indices of the series inside the displayed range. */
function rangeIdx(inp: ListenInput): number[] {
  const out: number[] = []
  inp.months.forEach((m, i) => { if (m >= inp.range[0] && m <= inp.range[1]) out.push(i) })
  return out
}

/**
 * The "raw, then harmonized" normalisation: each series is divided by its own median over the MODIS-only months shown
 * (before VIIRS starts), so both start at the same pitch level and any later difference is the sensor change.
 * Falls back to the median of the whole span when no MODIS-only month is shown.
 */
export function seamNormalise(inp: ListenInput): { raw: (number | null)[]; harm: (number | null)[]; idx: number[]; preMonths: number } {
  const idx = rangeIdx(inp)
  const pre = idx.filter((i) => inp.months[i] < inp.viirsStartM)
  const base = pre.length ? pre : idx
  const rawRef = median(base.map((i) => inp.naive[i]).filter((v) => v > 0)) ?? 1
  const harmRef = median(base.map((i) => inp.harmonized[i] ?? NaN).filter((v) => v > 0)) ?? 1
  const raw = inp.months.map((_, i) => (inp.naive[i] == null ? null : inp.naive[i] / rawRef))
  const harm = inp.months.map((_, i) => (inp.harmonized[i] == null ? null : inp.harmonized[i]! / harmRef))
  return { raw, harm, idx, preMonths: pre.length }
}

/** Build the event list for one mode. Times are in seconds; every event is pure data. */
export function buildSchedule(mode: ListenMode, inp: ListenInput, o: ScheduleOptions = {}): Schedule {
  const step = Math.max(0.05, (o.msPerMonth ?? SPEEDS.normal) / 1000)
  const tickDur = Math.min(0.06, step * 0.4)
  const events: ToneEvent[] = []
  let t = 0
  let lastYear: number | null = null

  const tick = (m: number) => {
    const y = yearOf(m)
    if (y === lastYear) return
    lastYear = y
    events.push({ t, dur: tickDur, kind: 'tick', freq: null, m: null, year: y })
    t += tickDur + step * 0.15
  }
  const month = (m: number, v: number | null, scale: PitchScale, normal: number | null) => {
    if (normal != null) {
      events.push({ t, dur: step * 0.6, kind: 'normal', freq: freqFor(normal, scale), m, year: null })
      t += step * 0.75
    }
    if (v == null) events.push({ t, dur: step * 0.8, kind: 'rest', freq: null, m, year: null })
    else if (v > 0) events.push({ t, dur: step * 0.8, kind: 'value', freq: freqFor(v, scale), m, year: null })
    else events.push({ t, dur: step * 0.8, kind: 'zero', freq: scale.fLow, m, year: null })
    t += step
  }

  let scale: PitchScale
  let note = ''
  if (mode === 'seam') {
    const n = seamNormalise(inp)
    scale = pitchScale([...n.idx.map((i) => n.raw[i]), ...n.idx.map((i) => n.harm[i])])
    note = n.preMonths
      ? 'Both series are divided by their own median before 2012, so they start at the same pitch; any jump after that is the sensor change.'
      : 'Both series are divided by their own median over the years shown, so they share one pitch range.'
    const parts: [string, (number | null)[]][] = [['Raw counts (MODIS, then VIIRS)', n.raw], ['Harmonized record', n.harm]]
    parts.forEach(([label, series], p) => {
      if (p > 0) { events.push({ t, dur: 0.9, kind: 'pause', freq: null, m: null, year: null }); t += 0.9 }
      lastYear = null
      const first = events.length
      for (const i of n.idx) { tick(inp.months[i]); month(inp.months[i], series[i], scale, null) }
      if (events[first]) events[first].part = label
    })
  } else if (mode === 'year') {
    const y = yearOf(inp.currentM)
    const idx = inp.months.map((m, i) => ({ m, i })).filter(({ m }) => yearOf(m) === y && m <= inp.currentM)
    scale = pitchScale([...idx.map(({ i }) => inp.harmonized[i]), ...idx.map(({ m }) => inp.median[moy(m)])])
    note = `Each month of ${y} plays twice: first a softer tone for its normal, then the month itself.`
    for (const { m, i } of idx) { tick(m); month(m, inp.harmonized[i], scale, inp.median[moy(m)] ?? null) }
  } else {
    const idx = rangeIdx(inp)
    scale = pitchScale([...idx.map((i) => inp.harmonized[i]), ...(o.withNormal ? inp.median : [])])
    note = o.withNormal ? 'Each month is preceded by a softer tone for its normal.' : ''
    for (const i of idx) {
      const m = inp.months[i]
      tick(m)
      month(m, inp.harmonized[i], scale, o.withNormal ? inp.median[moy(m)] ?? null : null)
    }
  }
  return { mode, events, duration: t, msPerMonth: step * 1000, scale, note }
}

/** Last event at or before time `pos` that belongs to a month (for the moving highlight). */
export function eventAt(events: ToneEvent[], pos: number): ToneEvent | null {
  let lo = 0, hi = events.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].t <= pos) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  for (let i = found; i >= 0; i--) {
    const e = events[i]
    if (e.kind === 'pause') return null
    if (e.m != null) return pos <= e.t + e.dur + 0.25 ? e : null
    if (e.kind === 'tick') return null
  }
  return null
}

// ---------------------------------------------------------------- words (the text alternative)

const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(0) : v.toFixed(1))
const ratioWords = (r: number) => (r >= 10 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`)

/** Seam jump: ratio of the 24 months after VIIRS starts to the 24 months before, raw and harmonized. */
export function seamJump(inp: ListenInput): { year: number; raw: number | null; harm: number | null } {
  const pre: number[] = [], post: number[] = []
  inp.months.forEach((m, i) => {
    if (m >= inp.viirsStartM - 24 && m < inp.viirsStartM) pre.push(i)
    else if (m >= inp.viirsStartM && m < inp.viirsStartM + 24) post.push(i)
  })
  const sum = (ix: number[], f: (i: number) => number | null) => ix.reduce((s, i) => s + (f(i) ?? 0), 0)
  const r = (a: number, b: number) => (a > 0 && b > 0 ? b / a : null)
  return {
    year: yearOf(inp.viirsStartM),
    raw: pre.length && post.length ? r(sum(pre, (i) => inp.naive[i]), sum(post, (i) => inp.naive[i])) : null,
    harm: pre.length && post.length ? r(sum(pre, (i) => inp.harmonized[i]), sum(post, (i) => inp.harmonized[i])) : null,
  }
}

/** The same information in sentences, for people who cannot hear it. */
export function transcript(mode: ListenMode, inp: ListenInput): string[] {
  const out: string[] = []
  const y0 = yearOf(inp.range[0]), y1 = yearOf(inp.range[1])
  if (mode === 'record' && inp.annual) {
    const yrs = inp.annual.years
      .map((y, i) => ({ y, t: inp.annual!.total[i], c: inp.annual!.complete[i] }))
      .filter((r) => r.c && r.t != null && r.y >= y0 && r.y <= y1) as { y: number; t: number }[]
    if (yrs.length >= 3) {
      const by = [...yrs].sort((a, b) => b.t - a.t)
      out.push(`Highest years (highest pitch through the season): ${by.slice(0, 3).map((r) => `${r.y} (${fmt(r.t)} fire-days)`).join(', ')}.`)
      out.push(`Lowest years: ${by.slice(-3).reverse().map((r) => `${r.y} (${fmt(r.t)})`).join(', ')}.`)
    }
    const idx = rangeIdx(inp).filter((i) => (inp.harmonized[i] ?? 0) > 0)
    if (idx.length) {
      const top = idx.reduce((a, b) => ((inp.harmonized[b] ?? 0) > (inp.harmonized[a] ?? 0) ? b : a))
      const tm = inp.months[top]
      out.push(`The single highest note is ${MONTHS[moy(tm)]} ${yearOf(tm)} (${fmt(inp.harmonized[top]!)} fire-days).`)
    }
    const months = inp.median.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
    if (months[0]?.v > 0) out.push(`Each year rises to its highest notes around ${MONTHS[months[0].i]}, the usual peak, and falls back after.`)
  } else if (mode === 'seam') {
    const j = seamJump(inp)
    if (j.raw != null) {
      const oct = Math.log2(j.raw)
      out.push(`Raw counts: in ${j.year}, when VIIRS replaces MODIS, the level jumps about ${ratioWords(j.raw)} (${oct >= 0 ? 'up' : 'down'} about ${Math.abs(oct).toFixed(1)} octaves) within a few notes, though the fires did not change.`)
    }
    if (j.harm != null) out.push(`Harmonized record: across the same years the level changes ${ratioWords(j.harm)}, so no jump is heard.`)
    if (j.raw == null && j.harm == null) out.push(`The years shown do not span ${j.year}, when VIIRS replaces MODIS, so there is no jump to hear.`)
  } else {
    const y = yearOf(inp.currentM)
    const parts: string[] = []
    inp.months.forEach((m, i) => {
      if (yearOf(m) !== y || m > inp.currentM) return
      const v = inp.harmonized[i], n = inp.median[moy(m)]
      if (v == null) return
      if (!(n > 0)) parts.push(`${MONTHS[moy(m)]}: ${v > 0 ? 'fire where there is normally none' : 'none, as normal'}`)
      else {
        const r = v / n
        parts.push(`${MONTHS[moy(m)]}: ${ratioWords(r)} normal (${r >= 1.15 ? 'second note higher' : r <= 0.87 ? 'second note lower' : 'about the same note'})`)
      }
    })
    if (parts.length) out.push(`${y} so far. ${parts.join('; ')}.`)
  }
  return out
}
