// Output validation: structure/length rules for the structured brief and a pragmatic numeric-grounding check.
//
// Grounding: every number in the model's text must match a number that appears in the dossier (within rounding
// tolerance; signed figures keep their sign against "rising"/"falling"-type words), be a small ordinal or count in a
// recognised pattern (0..12: "3rd", "2 of 3", "4 months"; never before "times" or "%"), or be a method constant the
// payload allows (the area label's digits never count). It catches invented or mis-scaled
// figures; it is not a proof of correctness (the matrix holds hundreds of values, so for Ask it is deliberately
// loose, and Ask only warns because the text is already on screen).
import type { Brief, Dossier, Level } from '../../src/lib/brief/dossierTypes.ts'
import { LEVELS } from '../../src/lib/brief/dossierTypes.ts'
import { parseJsonObject } from './partialJson.ts'

export const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length

/** Belt and braces: the prompt asks for plain text; strip any markdown that slips through (keeps single line breaks off). */
export function toPlainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_`]{1,3}([^*_`\n]+)[*_`]{1,3}/g, '$1')
    .replace(/[*`#]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** Ask answers keep their line breaks and "- " list lines; bold/italic/heading markers and fences go. */
export function toPlainAnswer(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------- numbers

interface Found {
  raw: string; value: number; decimals: number; trailingZeros: number; scale: number; index: number
  /** Up to 48 characters of text before / after the number, for the context rules. */
  before: string; after: string
}

const NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(thousand|million|k)\b)?/gi

/** Numbers as a reader would see them: "41,200", "2.3", "98th", "1.4 million", "41k". */
export function extractNumbers(text: string): Found[] {
  const out: Found[] = []
  for (const m of text.matchAll(NUM_RE)) {
    const intPart = m[1].replace(/,/g, '')
    const dec = m[2] ?? ''
    const scaleWord = (m[3] ?? '').toLowerCase()
    const scale = scaleWord === 'million' ? 1e6 : scaleWord ? 1e3 : 1
    const base = parseFloat(dec ? `${intPart}.${dec}` : intPart)
    const trailing = dec ? 0 : (intPart.match(/0+$/)?.[0].length ?? 0)
    const index = m.index ?? 0
    const end = index + m[0].length
    out.push({
      raw: m[0].trim(), value: base * scale, decimals: dec.length, trailingZeros: trailing, scale, index,
      before: text.slice(Math.max(0, index - 48), index), after: text.slice(end, end + 48),
    })
  }
  return out
}

/**
 * What a model's numbers are checked against.
 * - `values`: magnitudes of the unsigned figures of the payload.
 * - `signed`: figures whose sign carries meaning (trend slope, seam bias and correlation, outlook skill), kept signed
 *   so "rising 3.2 percent" cannot pass for a slope of -3.2.
 * - `echoes`: untrusted strings (the area label). Their digits are not in the pool; a number inside a verbatim echo
 *   of the string is fine.
 * - `constants`: method constants this payload allows to be quoted, each with an optional context the text must show.
 */
export interface Pool {
  values: number[]
  signed: number[]
  echoes: string[]
  constants: { value: number; after?: RegExp }[]
}

/** Signed fields of the dossier, as [section, field]. */
const SIGNED_FIELDS = [['trend', 'pctPerYear'], ['seam', 'biasPct'], ['seam', 'correlation'], ['outlook', 'skill']] as const

function numbersIn(json: string): number[] {
  const vals: number[] = []
  for (const m of json.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)) vals.push(Math.abs(parseFloat(m[0])))
  return vals
}

/** Splits a payload into the pool parts: the area label and the signed fields are taken out of the unsigned values. */
function poolOf(d: Dossier, payload: object): Pool {
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, Record<string, unknown> | null>
  const signed: number[] = []
  for (const [a, b] of SIGNED_FIELDS) {
    const o = copy[a]
    if (o && typeof o === 'object' && typeof o[b] === 'number') { signed.push(o[b] as number); delete o[b] }
  }
  if (copy.area && typeof copy.area === 'object') delete copy.area.label
  const constants: Pool['constants'] = []
  // "80 percent range / interval" names the interval the payload carries (month.interval80, outlook lo80-hi80).
  if (d.month.interval80 || d.outlook) {
    constants.push({ value: 80, after: /^\s*(%|percent\b|per cent\b)[\s-]*(uncertainty\s+|prediction\s+)?(range|interval|band)\b/i })
  }
  // The seam caveat the brief task permits: "harmonizedRatio outside 0.8 to 1.25 or correlation below 0.7".
  const s = d.seam
  if ((s.correlation != null && s.correlation < 0.7) || (s.harmonizedRatio != null && (s.harmonizedRatio < 0.8 || s.harmonizedRatio > 1.25))) {
    constants.push({ value: 0.7 }, { value: 0.8 }, { value: 1.25 })
  }
  return { values: numbersIn(JSON.stringify(copy)), signed, echoes: d.area.label ? [d.area.label] : [], constants }
}

function tolerance(f: Found, v: number): number {
  if (f.decimals > 0) return 0.5 * 10 ** -f.decimals * f.scale + 0.002 * Math.abs(v)
  return Math.max(0.5 * f.scale, Math.min(0.5 * 10 ** f.trailingZeros * f.scale, 0.05 * Math.abs(v)))
}
const near = (f: Found, v: number) => Math.abs(f.value - Math.abs(v)) <= tolerance(f, v) + 1e-9

/** A multiplier or a percentage follows: never a free small count. */
const MULTIPLIER_AFTER = /^\s*(×|x(?![a-z])|times\b|-?fold\b|%|percent\b|per cent\b)/i
/** Small whole numbers pass without a payload match only as ordinals or counts in these patterns. */
const COUNT_AFTER = /^((st|nd|rd|th)\b|\s+of\s+\d|\s+(complete\s+)?(months?|years?|days?|weeks?)\b)/i
const COUNT_BEFORE = /\bof\s+$/i

const RISING = /\b(ris(e|es|ing|en)|rose|increas\w*|grow\w*|grew|upward|up|higher|above|gain\w*|climb\w*)\b/i
const FALLING = /\b(fall\w*|fell|declin\w*|decreas\w*|drop\w*|downward|down|lower|below|shrink\w*|reduc\w*)\b/i

/** Direction the text gives a number: an explicit sign, else direction words in the same clause (0 = none or both). */
function claimedSign(f: Found): number {
  if (/(^|[\s(])[-−]\s?$/.test(f.before)) return -1
  if (/(^|[\s(])\+\s?$/.test(f.before)) return 1
  const before = (f.before.split(/[.;:!?]\s/).pop() ?? '').split(/\s+/).slice(-6).join(' ')
  const after = f.after.split(/[.;:!?](?:\s|$)/)[0].split(/\s+/).slice(0, 5).join(' ')
  const ctx = `${before} ${after}`
  const up = RISING.test(ctx), down = FALLING.test(ctx)
  return up === down ? 0 : up ? 1 : -1
}

function matches(f: Found, pool: Pool): boolean {
  const smallInt = Number.isInteger(f.value) && f.scale === 1 && f.decimals === 0 && f.value <= 12
  if (smallInt && !MULTIPLIER_AFTER.test(f.after) && (COUNT_AFTER.test(f.after) || COUNT_BEFORE.test(f.before))) return true
  if (pool.values.some((v) => near(f, v))) return true
  if (pool.constants.some((c) => Math.abs(f.value - c.value) < 1e-9 && (!c.after || c.after.test(f.after)))) return true
  const signed = pool.signed.filter((v) => near(f, v))
  if (!signed.length) return false
  const claim = claimedSign(f)
  return claim === 0 || signed.some((v) => v === 0 || Math.sign(v) === claim)
}

const asPool = (p: Pool | readonly number[]): Pool =>
  Array.isArray(p) ? { values: [...p], signed: [], echoes: [], constants: [] } : (p as Pool)

/** Blanks verbatim echoes of untrusted strings (not glued to further digits), keeping offsets. */
function withoutEchoes(text: string, echoes: readonly string[]): string {
  let out = text
  for (const e of echoes) {
    if (!/\d/.test(e)) continue
    const re = new RegExp(`(?<![\\d.,])${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![.,]?\\d)`, 'g')
    out = out.replace(re, (m) => ' '.repeat(m.length))
  }
  return out
}

function unmatched(text: string, pool: Pool | readonly number[]): Found[] {
  const p = asPool(pool)
  return extractNumbers(withoutEchoes(text, p.echoes)).filter((f) => !matches(f, p))
}

/** Numbers in `text` that cannot be matched to the pool (display strings). */
export function ungroundedNumbers(text: string, pool: Pool | readonly number[]): string[] {
  return unmatched(text, pool).map((f) => f.raw)
}

/** Same, with a few words of context so a corrective retry (and the dev log) can say where the number came from. */
export function ungroundedWithContext(text: string, pool: Pool | readonly number[]): string[] {
  return unmatched(text, pool)
    .map((f) => `${f.raw} (in "${text.slice(Math.max(0, f.index - 30), f.index + f.raw.length + 20).replace(/\s+/g, ' ')}")`)
}

/**
 * Pool for the brief: every figure in the dossier except the bulk year x month matrices (afcd, pct, annual arrays) and
 * the live `now`. The climatology quantiles and similar years stay in, since the brief may legitimately touch them.
 */
export function briefPool(d: Dossier): Pool {
  const { detail, now: _now, ...facts } = d
  void _now
  return poolOf(d, { ...facts, climatology: detail.climatology, similarYears: detail.similarYears })
}

/** Pool for Ask: the whole dossier, the live summary and the numbers the user typed. */
export function askPool(d: Dossier, userTexts: readonly string[]): Pool {
  const p = poolOf(d, d)
  p.values.push(...userTexts.flatMap((t) => extractNumbers(t).map((f) => f.value)))
  return p
}

// ---------------------------------------------------------------- brief structure

const MARKDOWN = /[*_`#]|^\s*[-•]\s|\]\(|<\/?[a-z][^>]*>/m
const EMOJI = /\p{Extended_Pictographic}/u
const FUTURE_WORDS = /\b(outlook|forecasts?|forecasted|upcoming|next month|coming (weeks?|months?)|weeks? away|months? away|months? ahead|expected to)\b/i

function sentenceCount(s: string): number {
  const parts = s.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean)
  return parts.length
}

export interface BriefCheck {
  brief: Brief | null
  /** Empty when the draft is acceptable. */
  problems: string[]
}

/**
 * Parses and checks a model draft against the dossier. Returns a sanitised Brief when parseable (even if it has
 * problems), plus the list of problems used for the single corrective retry.
 */
export function checkBrief(text: string, d: Dossier): BriefCheck {
  const raw = parseJsonObject(text)
  if (!raw) return { brief: null, problems: ['the reply was not a JSON object'] }
  const str = (v: unknown): string => (typeof v === 'string' ? toPlainText(v) : '')
  const watchRaw = Array.isArray(raw.watch) ? raw.watch : []
  const brief: Brief = {
    headline: str(raw.headline).replace(/[.\s]+$/, ''),
    summary: str(raw.summary),
    watch: watchRaw.map(str).filter(Boolean),
    caveat: str(raw.caveat),
    // The level is a deterministic fact of the dossier; take it from there rather than trusting an echo.
    level: (LEVELS as readonly string[]).includes(String(raw.level)) ? (raw.level as Level) : d.month.level,
  }
  brief.level = d.month.level

  const problems: string[] = []
  const hw = wordCount(brief.headline)
  if (hw < 2 || hw > 12) problems.push(`headline has ${hw} words, must be 2 to 12`)
  const sw = wordCount(brief.summary)
  if (sw < 60 || sw > 110) problems.push(`summary has ${sw} words, must be 60 to 110`)
  const sc = sentenceCount(brief.summary)
  if (sc < 3 || sc > 7) problems.push(`summary has ${sc} sentences, must be 3 to 6`)
  if (brief.watch.length > 3) problems.push(`watch has ${brief.watch.length} items, at most 3`)
  brief.watch = brief.watch.slice(0, 3)
  brief.watch.forEach((w, i) => { if (wordCount(w) > 16) problems.push(`watch item ${i + 1} is longer than 14 words`) })
  const cw = wordCount(brief.caveat)
  if (cw < 4 || cw > 35 || sentenceCount(brief.caveat) !== 1) problems.push('caveat must be exactly one sentence of at most 30 words')

  const all = [brief.headline, brief.summary, ...brief.watch, brief.caveat]
  const rawAll = [raw.headline, raw.summary, ...watchRaw, raw.caveat].filter((x): x is string => typeof x === 'string')
  if (rawAll.some((t) => MARKDOWN.test(t))) problems.push('it used markdown formatting')
  if (all.some((t) => EMOJI.test(t))) problems.push('it used emoji')
  if (!d.month.isLatestMonth && all.some((t) => FUTURE_WORDS.test(t))) {
    problems.push('the viewed month is a past month: do not mention an outlook, forecast or anything about the future')
  }
  // The units lens: never name the other scale (the glossary tells the model which wording applies).
  const otherUnit = d.unit === 'viirs' ? /\bMODIS[- ]equivalent\b/i : /\bVIIRS[- ]equivalent\b/i
  if (all.some((t) => otherUnit.test(t))) {
    problems.push(`the unit of these statistics is ${d.unit === 'viirs' ? 'VIIRS' : 'MODIS'}-equivalent active-fire cell-days: do not name the other unit`)
  }
  const bad = [...new Set(ungroundedWithContext(all.join(' \n '), briefPool(d)))]
  if (bad.length) problems.push(`these numbers are not in the statistics: ${bad.slice(0, 5).join('; ')}`)
  return { brief, problems }
}
