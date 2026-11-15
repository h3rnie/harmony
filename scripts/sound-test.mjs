// Unit tests for the pure sonification mapping (web/src/lib/sound/mapping.ts). Node >= 23 runs the .ts directly.
//   node scripts/sound-test.mjs
// Audio quality is not tested here (nothing can be heard in CI); this checks pitch mapping and schedule building.
import { buildSchedule, eventAt, freqFor, pitchScale, seamJump, seamNormalise, transcript, F_LOW, OCTAVES, SPEEDS } from '../web/src/lib/sound/mapping.ts'

let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++ }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))

// ---- value -> frequency
{
  const s = pitchScale([0, null, 5, 50, 500, undefined])
  ok(s.lo === 5 && s.hi === 500, 'scale anchors to the positive min and max of this area')
  ok(near(freqFor(5, s), F_LOW), 'lowest positive value -> floor (C4)')
  ok(near(freqFor(500, s), F_LOW * 2 ** OCTAVES), `highest value -> ${OCTAVES} octaves up`)
  ok(near(freqFor(50, s), F_LOW * 2 ** (OCTAVES / 2)), 'geometric midpoint -> half the octave span (log scale)')
  ok(near(freqFor(0, s), F_LOW), 'zero -> floor (played softly as a distinct tone)')
  ok(near(freqFor(5000, s), F_LOW * 2 ** OCTAVES) && near(freqFor(0.1, s), F_LOW), 'out-of-range values clamp')
  const vs = Array.from({ length: 200 }, (_, i) => 0.5 + i * 7.3)
  const s2 = pitchScale(vs)
  ok(vs.every((v, i) => i === 0 || freqFor(v, s2) > freqFor(vs[i - 1], s2)), 'pitch is strictly increasing in value (positive polarity)')
  const top = F_LOW * 2 ** OCTAVES
  ok(OCTAVES >= 2 && OCTAVES <= 3 && top < 1500, `span ${OCTAVES} octaves, ${F_LOW.toFixed(0)}–${top.toFixed(0)} Hz`)
  const flat = pitchScale([7, 7, 7])
  ok(flat.lo < flat.hi, 'degenerate range still gives a usable scale')
  const empty = pitchScale([0, null])
  ok(empty.lo > 0 && empty.hi > empty.lo, 'no positive values: fallback scale')
}

// ---- synthetic record: 2001-01 .. 2014-12, seasonal, VIIRS from 2012 with 4x raw counts
const months = Array.from({ length: 14 * 12 }, (_, i) => 12 + i)
const season = (m) => 10 + 90 * Math.exp(-(((m % 12) - 7) ** 2) / 4)
const harmonized = months.map((m) => (m === 12 + 30 ? null : m === 12 + 40 ? 0 : season(m)))
const viirsStartM = 144
const naive = months.map((m) => season(m) * (m >= viirsStartM ? 4 : 1))
const median = Array.from({ length: 12 }, (_, i) => season(i))
const inp = { months, harmonized, naive, median, range: [12, 12 + 14 * 12 - 1], viirsStartM, currentM: 12 + 14 * 12 - 3,
  annual: { years: Array.from({ length: 14 }, (_, i) => 2001 + i), total: Array.from({ length: 14 }, (_, i) => 1000 + i * 10), complete: Array(14).fill(true) } }

{
  const s = buildSchedule('record', inp, { msPerMonth: SPEEDS.normal })
  const notes = s.events.filter((e) => e.m != null)
  const ticks = s.events.filter((e) => e.kind === 'tick')
  ok(notes.length === months.length, `record: one month event per month (${notes.length})`)
  ok(ticks.length === 14 && ticks.every((t, i) => t.year === 2001 + i), 'record: one tick per year, carrying the year')
  ok(s.events.find((e) => e.m === 12 + 30)?.kind === 'rest', 'record: month without data is a rest (silence)')
  ok(s.events.find((e) => e.m === 12 + 40)?.kind === 'zero', 'record: month with no detections is a soft zero tone')
  ok(s.events.every((e, i) => i === 0 || e.t >= s.events[i - 1].t), 'events are in time order')
  ok(s.events.every((e) => e.t + e.dur <= s.duration + 1e-9), 'every event ends within the schedule')
  const per = (s.duration - ticks.length * (Math.min(0.06, 0.16 * 0.4) + 0.16 * 0.15)) / months.length
  ok(near(per, 0.16, 1e-6), `record: ${SPEEDS.normal} ms per month`)
  // monotone mapping inside the schedule
  const vals = notes.filter((e) => e.kind === 'value').map((e) => ({ v: harmonized[months.indexOf(e.m)], f: e.freq }))
  const sorted = [...vals].sort((a, b) => a.v - b.v)
  ok(sorted.every((x, i) => i === 0 || x.f >= sorted[i - 1].f), 'record: higher value never gets a lower pitch')
  const fast = buildSchedule('record', inp, { msPerMonth: SPEEDS.fast }), slow = buildSchedule('record', inp, { msPerMonth: SPEEDS.slow })
  ok(fast.duration < s.duration && s.duration < slow.duration, 'speed scales the duration')
  ok(SPEEDS.fast >= 100 && SPEEDS.slow <= 250, 'speeds stay within 100–250 ms per month')
  const wn = buildSchedule('record', inp, { withNormal: true })
  ok(wn.events.filter((e) => e.kind === 'normal').length === months.length, 'record + normal: one reference tone per month')
  const pairsOk = wn.events.every((e, i) => e.kind !== 'normal' || (wn.events[i + 1]?.m === e.m && wn.events[i + 1].t >= e.t + e.dur))
  ok(pairsOk, 'normal tone ends before the month tone starts (sequential, no beating)')
  // eventAt
  const mid = notes[50]
  ok(eventAt(s.events, mid.t + 0.01)?.m === mid.m, 'eventAt finds the sounding month')
  ok(eventAt(s.events, -1) == null, 'eventAt before start is null')
  // range limits
  const part = buildSchedule('record', { ...inp, range: [12 + 24, 12 + 24 + 35] })
  ok(part.events.filter((e) => e.m != null).length === 36, 'record: only the displayed years are played')
}

{
  const s = buildSchedule('seam', inp)
  const parts = s.events.filter((e) => e.part)
  ok(parts.length === 2 && parts[0].part.startsWith('Raw') && parts[1].part.startsWith('Harmonized'), 'seam: raw part, then harmonized part')
  ok(s.events.some((e) => e.kind === 'pause'), 'seam: a pause separates the two parts')
  const n = seamNormalise(inp)
  ok(n.preMonths === viirsStartM - 12, 'seam: normalised on the MODIS-only months shown')
  const split = s.events.findIndex((e) => e.kind === 'pause')
  const raw = s.events.slice(0, split).filter((e) => e.kind === 'value')
  const harm = s.events.slice(split).filter((e) => e.kind === 'value')
  const meanF = (es, pred) => { const x = es.filter((e) => pred(e.m)).map((e) => Math.log2(e.freq)); return x.reduce((a, b) => a + b, 0) / x.length }
  const rawJump = meanF(raw, (m) => m >= viirsStartM) - meanF(raw, (m) => m < viirsStartM)
  const harmJump = meanF(harm, (m) => m >= viirsStartM) - meanF(harm, (m) => m < viirsStartM)
  ok(rawJump > 0.8, `seam: raw counts jump in pitch at 2012 (+${rawJump.toFixed(2)} octaves on this scale)`)
  ok(Math.abs(harmJump) < 0.1, `seam: harmonized record does not (${harmJump.toFixed(2)} octaves)`)
  const j = seamJump(inp)
  ok(near(j.raw, 4, 1e-9) && near(j.harm, 1, 1e-6), 'seamJump: raw 4×, harmonized 1×')
  const words = transcript('seam', inp).join(' ')
  ok(/jumps about 4\.0×/.test(words) && /2012/.test(words), 'transcript names the raw jump and the year')
}

{
  const s = buildSchedule('year', inp)
  const y = 2000 + Math.floor(inp.currentM / 12)
  const expected = months.filter((m) => 2000 + Math.floor(m / 12) === y && m <= inp.currentM).length
  ok(s.events.filter((e) => e.kind === 'normal').length === expected, `year: a normal reference per month of ${y} so far (${expected})`)
  ok(s.events.filter((e) => e.kind === 'value' || e.kind === 'zero' || e.kind === 'rest').length === expected, 'year: one month tone per month')
  const t = transcript('year', inp).join(' ')
  ok(t.startsWith(`${y} so far`), 'year transcript starts with the year')
}

{
  const t = transcript('record', inp)
  ok(t.some((l) => l.startsWith('Highest years') && l.includes('2014')), 'record transcript names the highest years')
  ok(t.some((l) => l.startsWith('Lowest years') && l.includes('2001')), 'record transcript names the lowest years')
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
