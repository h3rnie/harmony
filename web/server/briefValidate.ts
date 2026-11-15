// Strict validation of the /api/brief request body. The body is untrusted: it is rebuilt field by field from a
// known shape (unknown keys are rejected), numbers must be finite and in range, and strings are length-limited
// and stripped of control characters. The area label is the only free text and is reduced to a name-like
// character set, because it ends up inside the model prompt.
import type { BriefPayload, Level } from '../src/lib/brief/payloadTypes.ts'
import { LABEL_MAX_CHARS, LEVELS, PAYLOAD_MAX_BYTES, PAYLOAD_VERSION } from '../src/lib/brief/payloadTypes.ts'

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

function obj(v: unknown, path: string, keys: readonly string[]): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new PayloadError(`${path}: expected object`)
  const o = v as Obj
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new PayloadError(`${path}: unexpected field "${k}"`)
  for (const k of keys) if (!(k in o)) throw new PayloadError(`${path}: missing field "${k}"`)
  return o
}
function num(v: unknown, path: string, min = -1e12, max = 1e12): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new PayloadError(`${path}: expected finite number in [${min}, ${max}]`)
  return v
}
function numOrNull(v: unknown, path: string, min?: number, max?: number): number | null {
  return v === null ? null : num(v, path, min, max)
}
function int(v: unknown, path: string, min: number, max: number): number {
  const n = num(v, path, min, max)
  if (!Number.isInteger(n)) throw new PayloadError(`${path}: expected integer`)
  return n
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new PayloadError(`${path}: expected boolean`)
  return v
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new PayloadError(`${path}: unexpected value`)
  return v as T
}
function monthName(v: unknown, path: string): string {
  return oneOf(v, path, MONTHS)
}
function monthLabel(v: unknown, path: string): string {
  if (typeof v !== 'string' || !MONTH_LABEL.test(v)) throw new PayloadError(`${path}: expected "<Month> <year>"`)
  return v
}
function pair(v: unknown, path: string, min: number, max: number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new PayloadError(`${path}: expected [a, b]`)
  return [num(v[0], `${path}[0]`, min, max), num(v[1], `${path}[1]`, min, max)]
}
function list<T>(v: unknown, path: string, max: number, each: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length > max) throw new PayloadError(`${path}: expected array of at most ${max}`)
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

export function validatePayload(raw: unknown): BriefPayload {
  const top = obj(raw, 'payload', ['v', 'area', 'month', 'yearToDate', 'season', 'trend', 'outlook', 'records', 'seam', 'provenance'])
  if (top.v !== PAYLOAD_VERSION) throw new PayloadError('payload.v: unsupported version')

  const a = obj(top.area, 'area', ['label', 'isPreset', 'km2', 'centroid'])
  if (typeof a.label !== 'string') throw new PayloadError('area.label: expected string')
  const centroid = pair(a.centroid, 'area.centroid', -180, 180)
  if (Math.abs(centroid[1]) > 90) throw new PayloadError('area.centroid: bad latitude')
  const area: BriefPayload['area'] = {
    label: sanitizeLabel(a.label) || 'Selected area',
    isPreset: bool(a.isPreset, 'area.isPreset'),
    km2: num(a.km2, 'area.km2', 0, 6e8),
    centroid,
  }

  const m = obj(top.month, 'month', ['label', 'monthName', 'year', 'value', 'interval80', 'median', 'ratio', 'percentile', 'rankMostActive', 'ofYears', 'level', 'provisional', 'isLatestMonth'])
  const month: BriefPayload['month'] = {
    label: monthLabel(m.label, 'month.label'),
    monthName: monthName(m.monthName, 'month.monthName'),
    year: int(m.year, 'month.year', 1990, 2100),
    value: numOrNull(m.value, 'month.value', 0),
    interval80: m.interval80 === null ? null : pair(m.interval80, 'month.interval80', 0, 1e12),
    median: num(m.median, 'month.median', 0),
    ratio: numOrNull(m.ratio, 'month.ratio', 0, 1e9),
    percentile: numOrNull(m.percentile, 'month.percentile', 0, 100),
    rankMostActive: m.rankMostActive === null ? null : int(m.rankMostActive, 'month.rankMostActive', 1, 1000),
    ofYears: int(m.ofYears, 'month.ofYears', 0, 1000),
    level: oneOf<Level>(m.level, 'month.level', LEVELS),
    provisional: bool(m.provisional, 'month.provisional'),
    isLatestMonth: bool(m.isLatestMonth, 'month.isLatestMonth'),
  }

  const y = obj(top.yearToDate, 'yearToDate', ['year', 'throughMonth', 'ratio', 'rankMostActive', 'ofYears'])
  const yearToDate: BriefPayload['yearToDate'] = {
    year: int(y.year, 'yearToDate.year', 1990, 2100),
    throughMonth: monthName(y.throughMonth, 'yearToDate.throughMonth'),
    ratio: numOrNull(y.ratio, 'yearToDate.ratio', 0, 1e9),
    rankMostActive: int(y.rankMostActive, 'yearToDate.rankMostActive', 1, 1000),
    ofYears: int(y.ofYears, 'yearToDate.ofYears', 0, 1000),
  }

  const s = obj(top.season, 'season', ['peakMonth', 'startMonth', 'endMonth', 'lengthMonths', 'secondPeak', 'viewedMonthInSeason'])
  const season: BriefPayload['season'] = {
    peakMonth: monthName(s.peakMonth, 'season.peakMonth'),
    startMonth: monthName(s.startMonth, 'season.startMonth'),
    endMonth: monthName(s.endMonth, 'season.endMonth'),
    lengthMonths: int(s.lengthMonths, 'season.lengthMonths', 0, 12),
    secondPeak: s.secondPeak === null ? null : monthName(s.secondPeak, 'season.secondPeak'),
    viewedMonthInSeason: bool(s.viewedMonthInSeason, 'season.viewedMonthInSeason'),
  }

  const t = obj(top.trend, 'trend', ['years', 'pctPerYear', 'pValue', 'direction'])
  const trend: BriefPayload['trend'] = {
    years: pair(t.years, 'trend.years', 1990, 2100),
    pctPerYear: numOrNull(t.pctPerYear, 'trend.pctPerYear', -1e6, 1e6),
    pValue: numOrNull(t.pValue, 'trend.pValue', 0, 1),
    direction: oneOf(t.direction, 'trend.direction', ['up', 'down', 'none'] as const),
  }

  let outlook: BriefPayload['outlook'] = null
  if (top.outlook !== null) {
    const o = obj(top.outlook, 'outlook', ['method', 'skill', 'months'])
    outlook = {
      method: oneOf(o.method, 'outlook.method', ['anomaly-persistence', 'climatology'] as const),
      skill: num(o.skill, 'outlook.skill', -1e6, 1),
      months: list(o.months, 'outlook.months', 3, (x, p) => {
        const e = obj(x, p, ['label', 'median', 'lo80', 'hi80', 'normal'])
        return {
          label: monthLabel(e.label, `${p}.label`),
          median: num(e.median, `${p}.median`, 0), lo80: num(e.lo80, `${p}.lo80`, 0),
          hi80: num(e.hi80, `${p}.hi80`, 0), normal: num(e.normal, `${p}.normal`, 0),
        }
      }),
    }
  }

  const rc = obj(top.records, 'records', ['topMonths', 'topYears'])
  const records: BriefPayload['records'] = {
    topMonths: list(rc.topMonths, 'records.topMonths', 3, (x, p) => {
      const e = obj(x, p, ['label', 'value', 'ratio'])
      return { label: monthLabel(e.label, `${p}.label`), value: num(e.value, `${p}.value`, 0), ratio: numOrNull(e.ratio, `${p}.ratio`, 0, 1e9) }
    }),
    topYears: list(rc.topYears, 'records.topYears', 3, (x, p) => {
      const e = obj(x, p, ['year', 'total'])
      return { year: int(e.year, `${p}.year`, 1990, 2100), total: num(e.total, `${p}.total`, 0) }
    }),
  }

  const sm = obj(top.seam, 'seam', ['nMonths', 'rawViirsToModisRatio', 'harmonizedRatio', 'correlation'])
  const seam: BriefPayload['seam'] = {
    nMonths: int(sm.nMonths, 'seam.nMonths', 0, 1000),
    rawViirsToModisRatio: numOrNull(sm.rawViirsToModisRatio, 'seam.rawViirsToModisRatio', 0, 1e9),
    harmonizedRatio: numOrNull(sm.harmonizedRatio, 'seam.harmonizedRatio', 0, 1e9),
    correlation: numOrNull(sm.correlation, 'seam.correlation', -1, 1),
  }

  const pv = obj(top.provenance, 'provenance', ['dataThrough', 'recordStartYear', 'baselineYears'])
  if (pv.dataThrough !== null && (typeof pv.dataThrough !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pv.dataThrough))) {
    throw new PayloadError('provenance.dataThrough: expected YYYY-MM-DD or null')
  }
  const provenance: BriefPayload['provenance'] = {
    dataThrough: pv.dataThrough as string | null,
    recordStartYear: int(pv.recordStartYear, 'provenance.recordStartYear', 1990, 2100),
    baselineYears: pair(pv.baselineYears, 'provenance.baselineYears', 1990, 2100),
  }

  return { v: PAYLOAD_VERSION, area, month, yearToDate, season, trend, outlook, records, seam, provenance }
}

/** Parse + validate a raw request body string. The size cap is checked on bytes before JSON.parse. */
export function parseBody(text: string): BriefPayload {
  if (Buffer.byteLength(text, 'utf8') > PAYLOAD_MAX_BYTES) throw new PayloadError('payload too large', 400)
  let json: unknown
  try { json = JSON.parse(text) } catch { throw new PayloadError('invalid JSON') }
  return validatePayload(json)
}
