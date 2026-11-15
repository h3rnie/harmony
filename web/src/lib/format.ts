import type { MonthIndex } from './kernel/types'

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const MONTHS_INITIAL = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

export const toM = (year: number, month: number): MonthIndex => (year - 2000) * 12 + (month - 1)
export const yearOf = (m: MonthIndex) => 2000 + Math.floor(m / 12)
export const monthOf = (m: MonthIndex) => (((m % 12) + 12) % 12) + 1

export const monthShort = (m: MonthIndex) => `${MONTHS_SHORT[monthOf(m) - 1]} ${yearOf(m)}`
export const monthLong = (m: MonthIndex) => `${MONTHS_LONG[monthOf(m) - 1]} ${yearOf(m)}`
/** "2019-08" */
export const monthIso = (m: MonthIndex) => `${yearOf(m)}-${String(monthOf(m)).padStart(2, '0')}`
export function parseMonthIso(s: string): MonthIndex | null {
  const r = /^(\d{4})-(\d{1,2})$/.exec(s.trim())
  if (!r) return null
  const y = +r[1], mo = +r[2]
  return mo >= 1 && mo <= 12 ? toM(y, mo) : null
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Human number: 0.42 · 12.3 · 1,234 · 56K */
export function fmtNum(v: number | null | undefined, compactAbove = 100_000): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= compactAbove) return nfc.format(v)
  if (a >= 100) return nf0.format(v)
  if (a >= 10) return nf1.format(v)
  if (a === 0) return '0'
  return v.toPrecision(2).replace(/\.?0+$/, '')
}
/** Short cell label: never more than 4 characters. */
export function fmtCell(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a >= 9999.5) return nfc.format(v).replace('.0', '')
  if (a >= 100) return String(Math.round(v))
  if (a >= 10) return String(Math.round(v))
  if (a === 0) return '0'
  return v.toFixed(1)
}
export function fmtRatio(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return '—'
  if (r >= 10) return `${Math.round(r)}×`
  if (r >= 1) return `${r.toFixed(1)}×`
  if (r >= 0.01) return `${r.toFixed(2)}×`
  return r === 0 ? '0×' : '<0.01×'
}
export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)} %`
}
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
/** "most active" for rank 1, "3rd most active" otherwise. */
export function rankPhrase(rank: number, word = 'most active'): string {
  return rank === 1 ? word : `${ordinal(rank)} ${word}`
}
/** Rank among n, phrased from the nearer end: "3rd most active" or "2nd least active". */
export function rankFromEnds(rank: number, n: number): string {
  if (n < 4 || rank <= Math.ceil(n / 2)) return rankPhrase(rank)
  const lr = n - rank + 1
  return lr === 1 ? 'least active' : `${ordinal(lr)} least active`
}
export function signed(v: number, digits = 1): string {
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s.replace('-', '−')
}
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—'
  return p < 0.001 ? 'p < 0.001' : `p = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`
}
export function fmtArea(km2: number): string {
  return km2 >= 1e6 ? `${(km2 / 1e6).toFixed(2)} M km²` : `${nf0.format(km2)} km²`
}
export const LEVEL_LABEL: Record<string, string> = {
  extreme: 'Extreme',
  'well-above': 'Well above normal',
  above: 'Above normal',
  normal: 'Near normal',
  below: 'Below normal',
  'well-below': 'Well below normal',
}
/** Same thresholds the UI uses when it has to derive a level for a non-current month. */
export function levelFromPercentile(p: number | null): string {
  if (p == null) return 'normal'
  if (p >= 97.5) return 'extreme'
  if (p >= 90) return 'well-above'
  if (p >= 75) return 'above'
  if (p <= 10) return 'well-below'
  if (p <= 25) return 'below'
  return 'normal'
}
