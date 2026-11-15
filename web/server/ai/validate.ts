// Strict validation of request bodies. Bodies are untrusted: the dossier is rebuilt field by field in a FIXED key
// order from a known shape (unknown keys are rejected), numbers must be finite and in range and are re-rounded
// exactly like the browser rounds them, and strings are length-limited and stripped of control characters. The
// result serialises to the same bytes for the same statistics, which is what makes the prompt cache hit.
// The area label is the only free text and is reduced to a name-like character set, because it ends up in the prompt.
import type { ChatTurn, Dossier, Level, LiveNow } from '../../src/lib/brief/dossierTypes.ts'
import {
  ASK_MAX_ANSWER_CHARS, ASK_MAX_QUESTION_CHARS, ASK_MAX_TURNS, DOSSIER_MAX_BYTES, DOSSIER_VERSION, LABEL_MAX_CHARS, LEVELS,
} from '../../src/lib/brief/dossierTypes.ts'
import { fix, sig } from '../../src/lib/brief/round.ts'

export class PayloadError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const
const MONTH_LABEL = /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/

type Obj = Record<string, unknown>

function obj(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new PayloadError(`${path}: expected object`)
  const o = v as Obj
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) throw new PayloadError(`${path}: unexpected field "${k}"`)
  for (const k of keys) if (!(k in o)) throw new PayloadError(`${path}: missing field "${k}"`)
  return o
}
function num(v: unknown, path: string, min = -1e12, max = 1e12): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new PayloadError(`${path}: expected finite number in [${min}, ${max}]`)
  return v
}
function int(v: unknown, path: string, min: number, max: number): number {
  const n = num(v, path, min, max)
  if (!Number.isInteger(n)) throw new PayloadError(`${path}: expected integer`)
  return n
}
function intOrNull(v: unknown, path: string, min: number, max: number): number | null {
  return v === null ? null : int(v, path, min, max)
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new PayloadError(`${path}: expected boolean`)
  return v
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new PayloadError(`${path}: unexpected value`)
  return v as T
}
function monthName(v: unknown, path: string): string { return oneOf(v, path, MONTHS) }
function monthLabel(v: unknown, path: string): string {
  if (typeof v !== 'string' || !MONTH_LABEL.test(v)) throw new PayloadError(`${path}: expected "<Month> <year>"`)
  return v
}
function pair(v: unknown, path: string, min: number, max: number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new PayloadError(`${path}: expected [a, b]`)
  return [num(v[0], `${path}[0]`, min, max), num(v[1], `${path}[1]`, min, max)]
}
function list<T>(v: unknown, path: string, max: number, each: (x: unknown, p: string) => T, min = 0): T[] {
  if (!Array.isArray(v) || v.length > max || v.length < min) throw new PayloadError(`${path}: expected array of ${min}..${max}`)
  return v.map((x, i) => each(x, `${path}[${i}]`))
}
function fixedList<T>(v: unknown, path: string, n: number, each: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length !== n) throw new PayloadError(`${path}: expected array of ${n}`)
  return v.map((x, i) => each(x, `${path}[${i}]`))
}

/**
 * Control characters (incl. newlines, tabs, bidi and zero-width marks) are removed, then everything that is not a
 * letter, number, mark, space or common place-name punctuation is replaced by a space, whitespace is collapsed,
 * and the result is capped. Angle brackets, braces and quotes never reach the prompt.
 */
export function sanitizeLabel(raw: string): string {
  const s = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\p{M} .,'’()&/+\-–—:#°]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(s).slice(0, LABEL_MAX_CHARS).join('').trim()
}

function validateNow(v: unknown): LiveNow {
  const n = obj(v, 'now', ['last24h', 'last48h', 'last7d', 'highConfidence24h', 'newestAgeHours'])
  return {
    last24h: int(n.last24h, 'now.last24h', 0, 1e7),
    last48h: int(n.last48h, 'now.last48h', 0, 1e7),
    last7d: int(n.last7d, 'now.last7d', 0, 1e7),
    highConfidence24h: int(n.highConfidence24h, 'now.highConfidence24h', 0, 1e7),
    newestAgeHours: n.newestAgeHours === null ? null : fix(num(n.newestAgeHours, 'now.newestAgeHours', 0, 24 * 8), 1),
  }
}

/** Validates and canonicalises a dossier. Throws PayloadError (400). */
export function validateDossier(raw: unknown): Dossier {
  let size: number
  try { size = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') } catch { throw new PayloadError('invalid JSON') }
  if (size > DOSSIER_MAX_BYTES) throw new PayloadError('payload too large')

  const top = obj(raw, 'dossier', ['v', 'area', 'month', 'yearToDate', 'annual', 'season', 'trend', 'outlook', 'records', 'seam', 'provenance', 'detail'], ['now'])
  if (top.v !== DOSSIER_VERSION) throw new PayloadError('dossier.v: unsupported version')

  const a = obj(top.area, 'area', ['label', 'isPreset', 'km2', 'centroid'])
  if (typeof a.label !== 'string') throw new PayloadError('area.label: expected string')
  const centroid = pair(a.centroid, 'area.centroid', -180, 180)
  if (Math.abs(centroid[1]) > 90) throw new PayloadError('area.centroid: bad latitude')
  const area: Dossier['area'] = {
    label: sanitizeLabel(a.label) || 'Selected area',
    isPreset: bool(a.isPreset, 'area.isPreset'),
    km2: Math.round(num(a.km2, 'area.km2', 0, 6e8)),
    centroid: [fix(centroid[0], 2), fix(centroid[1], 2)],
  }

  const m = obj(top.month, 'month', ['label', 'monthName', 'year', 'value', 'interval80', 'median', 'ratio', 'percentile', 'rankMostActive', 'ofYears', 'level', 'provisional', 'isLatestMonth'])
  const i80 = m.interval80 === null ? null : pair(m.interval80, 'month.interval80', 0, 1e12)
  const month: Dossier['month'] = {
    label: monthLabel(m.label, 'month.label'),
    monthName: monthName(m.monthName, 'month.monthName'),
    year: int(m.year, 'month.year', 1990, 2100),
    value: m.value === null ? null : fix(num(m.value, 'month.value', 0), 1),
    interval80: i80 ? [fix(i80[0], 1), fix(i80[1], 1)] : null,
    median: fix(num(m.median, 'month.median', 0), 1),
    ratio: m.ratio === null ? null : fix(num(m.ratio, 'month.ratio', 0, 1e9), 2),
    percentile: m.percentile === null ? null : Math.round(num(m.percentile, 'month.percentile', 0, 100)),
    rankMostActive: intOrNull(m.rankMostActive, 'month.rankMostActive', 1, 1000),
    ofYears: int(m.ofYears, 'month.ofYears', 0, 1000),
    level: oneOf<Level>(m.level, 'month.level', LEVELS),
    provisional: bool(m.provisional, 'month.provisional'),
    isLatestMonth: bool(m.isLatestMonth, 'month.isLatestMonth'),
  }

  const y = obj(top.yearToDate, 'yearToDate', ['year', 'throughMonth', 'ratio', 'rankMostActive', 'ofYears'])
  const yearToDate: Dossier['yearToDate'] = {
    year: int(y.year, 'yearToDate.year', 1990, 2100),
    throughMonth: monthName(y.throughMonth, 'yearToDate.throughMonth'),
    ratio: y.ratio === null ? null : fix(num(y.ratio, 'yearToDate.ratio', 0, 1e9), 2),
    rankMostActive: intOrNull(y.rankMostActive, 'yearToDate.rankMostActive', 1, 1000),
    ofYears: int(y.ofYears, 'yearToDate.ofYears', 0, 1000),
  }

  let annual: Dossier['annual'] = null
  if (top.annual !== null) {
    const an = obj(top.annual, 'annual', ['year', 'total', 'rankMostActive', 'ofCompleteYears'])
    annual = {
      year: int(an.year, 'annual.year', 1990, 2100),
      total: sig(num(an.total, 'annual.total', 0)),
      rankMostActive: int(an.rankMostActive, 'annual.rankMostActive', 1, 1000),
      ofCompleteYears: int(an.ofCompleteYears, 'annual.ofCompleteYears', 0, 1000),
    }
  }

  const s = obj(top.season, 'season', ['peakMonth', 'startMonth', 'endMonth', 'lengthMonths', 'secondPeak', 'viewedMonthInSeason'])
  const season: Dossier['season'] = {
    peakMonth: monthName(s.peakMonth, 'season.peakMonth'),
    startMonth: monthName(s.startMonth, 'season.startMonth'),
    endMonth: monthName(s.endMonth, 'season.endMonth'),
    lengthMonths: int(s.lengthMonths, 'season.lengthMonths', 0, 12),
    secondPeak: s.secondPeak === null ? null : monthName(s.secondPeak, 'season.secondPeak'),
    viewedMonthInSeason: bool(s.viewedMonthInSeason, 'season.viewedMonthInSeason'),
  }

  const t = obj(top.trend, 'trend', ['years', 'pctPerYear', 'pValue', 'direction'])
  const trend: Dossier['trend'] = {
    years: pair(t.years, 'trend.years', 1990, 2100),
    pctPerYear: t.pctPerYear === null ? null : fix(num(t.pctPerYear, 'trend.pctPerYear', -1e6, 1e6), 1),
    pValue: t.pValue === null ? null : fix(num(t.pValue, 'trend.pValue', 0, 1), 3),
    direction: oneOf(t.direction, 'trend.direction', ['up', 'down', 'none'] as const),
  }

  let outlook: Dossier['outlook'] = null
  if (top.outlook !== null) {
    const o = obj(top.outlook, 'outlook', ['method', 'skill', 'months'])
    outlook = {
      method: oneOf(o.method, 'outlook.method', ['anomaly-persistence', 'climatology'] as const),
      skill: fix(num(o.skill, 'outlook.skill', -1e6, 1), 2),
      months: list(o.months, 'outlook.months', 3, (x, p) => {
        const e = obj(x, p, ['label', 'median', 'lo80', 'hi80', 'normal'])
        return {
          label: monthLabel(e.label, `${p}.label`),
          median: fix(num(e.median, `${p}.median`, 0), 1), lo80: fix(num(e.lo80, `${p}.lo80`, 0), 1),
          hi80: fix(num(e.hi80, `${p}.hi80`, 0), 1), normal: fix(num(e.normal, `${p}.normal`, 0), 1),
        }
      }),
    }
  }

  const rc = obj(top.records, 'records', ['topMonths', 'topYears'])
  const records: Dossier['records'] = {
    topMonths: list(rc.topMonths, 'records.topMonths', 3, (x, p) => {
      const e = obj(x, p, ['label', 'value', 'ratio'])
      return { label: monthLabel(e.label, `${p}.label`), value: fix(num(e.value, `${p}.value`, 0), 1), ratio: e.ratio === null ? null : fix(num(e.ratio, `${p}.ratio`, 0, 1e9), 2) }
    }),
    topYears: list(rc.topYears, 'records.topYears', 3, (x, p) => {
      const e = obj(x, p, ['year', 'total'])
      return { year: int(e.year, `${p}.year`, 1990, 2100), total: Math.round(num(e.total, `${p}.total`, 0)) }
    }),
  }

  const sm = obj(top.seam, 'seam', ['nMonths', 'rawViirsToModisRatio', 'harmonizedRatio', 'correlation', 'biasPct'])
  const seam: Dossier['seam'] = {
    nMonths: int(sm.nMonths, 'seam.nMonths', 0, 1000),
    rawViirsToModisRatio: sm.rawViirsToModisRatio === null ? null : fix(num(sm.rawViirsToModisRatio, 'seam.rawViirsToModisRatio', 0, 1e9), 2),
    harmonizedRatio: sm.harmonizedRatio === null ? null : fix(num(sm.harmonizedRatio, 'seam.harmonizedRatio', 0, 1e9), 2),
    correlation: sm.correlation === null ? null : fix(num(sm.correlation, 'seam.correlation', -1, 1), 2),
    biasPct: sm.biasPct === null ? null : fix(num(sm.biasPct, 'seam.biasPct', -1e6, 1e6), 1),
  }

  const pv = obj(top.provenance, 'provenance', ['dataThrough', 'recordStartYear', 'baselineYears', 'dayNight', 'switchMonth', 'aquaStartMonth', 'viirsStartMonth', 'provisionalMonths'])
  if (pv.dataThrough !== null && (typeof pv.dataThrough !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pv.dataThrough))) {
    throw new PayloadError('provenance.dataThrough: expected YYYY-MM-DD or null')
  }
  const provenance: Dossier['provenance'] = {
    dataThrough: pv.dataThrough as string | null,
    recordStartYear: int(pv.recordStartYear, 'provenance.recordStartYear', 1990, 2100),
    baselineYears: pair(pv.baselineYears, 'provenance.baselineYears', 1990, 2100),
    dayNight: oneOf(pv.dayNight, 'provenance.dayNight', ['both', 'day', 'night'] as const),
    switchMonth: monthLabel(pv.switchMonth, 'provenance.switchMonth'),
    aquaStartMonth: monthLabel(pv.aquaStartMonth, 'provenance.aquaStartMonth'),
    viirsStartMonth: monthLabel(pv.viirsStartMonth, 'provenance.viirsStartMonth'),
    provisionalMonths: list(pv.provisionalMonths, 'provenance.provisionalMonths', 6, (x, p) => monthLabel(x, p)),
  }

  const d = obj(top.detail, 'detail', ['years', 'afcd', 'pct', 'source', 'climatology', 'annualTotal', 'annualRank', 'similarYears'])
  const years = list(d.years, 'detail.years', 60, (x, p) => int(x, p, 1990, 2100), 1)
  const n = years.length
  const matrix = <T>(v: unknown, path: string, cell: (x: unknown, p: string) => T): T[][] =>
    fixedList(v, path, n, (row, rp) => fixedList(row, rp, 12, cell))
  const cl = obj(d.climatology, 'detail.climatology', ['median', 'q10', 'q25', 'q75', 'q90'])
  const c12 = (v: unknown, p: string) => fixedList(v, p, 12, (x, q) => sig(num(x, q, 0)))
  const detail: Dossier['detail'] = {
    years,
    afcd: matrix(d.afcd, 'detail.afcd', (x, p) => (x === null ? null : sig(num(x, p, 0)))),
    pct: matrix(d.pct, 'detail.pct', (x, p) => (x === null ? null : Math.round(num(x, p, 0, 100)))),
    source: fixedList(d.source, 'detail.source', n, (x, p) => {
      if (typeof x !== 'string' || !/^[0-3x]{12}$/.test(x)) throw new PayloadError(`${p}: expected 12 characters from 0-3, x`)
      return x
    }),
    climatology: {
      median: c12(cl.median, 'detail.climatology.median'), q10: c12(cl.q10, 'detail.climatology.q10'), q25: c12(cl.q25, 'detail.climatology.q25'),
      q75: c12(cl.q75, 'detail.climatology.q75'), q90: c12(cl.q90, 'detail.climatology.q90'),
    },
    annualTotal: fixedList(d.annualTotal, 'detail.annualTotal', n, (x, p) => (x === null ? null : sig(num(x, p, 0)))),
    annualRank: fixedList(d.annualRank, 'detail.annualRank', n, (x, p) => intOrNull(x, p, 1, 1000)),
    similarYears: list(d.similarYears, 'detail.similarYears', 3, (x, p) => int(x, p, 1990, 2100)),
  }

  const out: Dossier = { v: DOSSIER_VERSION, area, month, yearToDate, annual, season, trend, outlook, records, seam, provenance, detail }
  if (top.now !== undefined) out.now = validateNow(top.now)
  return out
}

/** The serialisation sent to the model as the cached context block: byte-stable, never includes the volatile `now`. */
export function canonicalDossier(d: Dossier): string {
  const { now: _now, ...rest } = d
  void _now
  return JSON.stringify(rest)
}

const CTRL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Free text from a user turn: control / bidi / zero-width characters become spaces, whitespace is collapsed. */
function cleanTurn(s: string): string {
  return s.replace(CTRL, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Conversation: 1..8 turns, alternating, starting and ending with a user turn. User turns <= 500 chars, assistant
 * turns (history echoed by the client) <= 1600 chars. Returns cleaned turns.
 */
export function validateConversation(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ASK_MAX_TURNS) throw new PayloadError(`messages: expected 1..${ASK_MAX_TURNS} turns`)
  const turns = raw.map((t, i): ChatTurn => {
    const o = obj(t, `messages[${i}]`, ['role', 'content'])
    const role = oneOf(o.role, `messages[${i}].role`, ['user', 'assistant'] as const)
    if (typeof o.content !== 'string') throw new PayloadError(`messages[${i}].content: expected string`)
    const max = role === 'user' ? ASK_MAX_QUESTION_CHARS : ASK_MAX_ANSWER_CHARS
    if (Array.from(o.content).length > max) throw new PayloadError(`messages[${i}].content: longer than ${max} characters`)
    const content = role === 'user' ? cleanTurn(o.content) : o.content.replace(CTRL, ' ').replace(/[ \t]+/g, ' ').trim()
    if (!content) throw new PayloadError(`messages[${i}].content: empty`)
    return { role, content }
  })
  turns.forEach((t, i) => { if (t.role !== (i % 2 === 0 ? 'user' : 'assistant')) throw new PayloadError('messages: turns must alternate, starting with a user turn') })
  if (turns[turns.length - 1].role !== 'user') throw new PayloadError('messages: the last turn must be a user turn')
  return turns
}
