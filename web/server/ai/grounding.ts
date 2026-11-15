// Output validation: structure/length rules for the structured brief and a pragmatic numeric-grounding check.
//
// Grounding: every number in the model's text must match a number that appears in the dossier (within rounding
// tolerance) or be a small ordinal/count (0..12: months, "3rd", "2 of 3"). It catches invented or mis-scaled
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

interface Found { raw: string; value: number; decimals: number; trailingZeros: number; scale: number; index: number }

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
    out.push({ raw: m[0].trim(), value: base * scale, decimals: dec.length, trailingZeros: trailing, scale, index: m.index ?? 0 })
  }
  return out
}

/** All numbers that appear anywhere in a JSON string (values, years inside labels, dates). */
/** Thresholds the method itself defines (percentile bands for the level words, 80 % interval, seam limits): fair to quote. */
const METHOD_CONSTANTS = [10, 25, 75, 90, 97.5, 98, 80, 0.7, 0.8, 1.25]

function numbersIn(json: string): number[] {
  const vals: number[] = [...METHOD_CONSTANTS]
  for (const m of json.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)) vals.push(Math.abs(parseFloat(m[0])))
  return vals
}

function matches(f: Found, pool: readonly number[]): boolean {
  if (Number.isInteger(f.value) && f.scale === 1 && f.decimals === 0 && f.value <= 12) return true // ordinals, months, small counts
  for (const v of pool) {
    let tol: number
    if (f.decimals > 0) tol = 0.5 * 10 ** -f.decimals * f.scale + 0.002 * Math.abs(v)
    else tol = Math.max(0.5 * f.scale, Math.min(0.5 * 10 ** f.trailingZeros * f.scale, 0.05 * Math.abs(v)))
    if (Math.abs(f.value - v) <= tol + 1e-9) return true
  }
  return false
}

/** Numbers in `text` that cannot be matched to the pool (display strings). */
export function ungroundedNumbers(text: string, pool: readonly number[]): string[] {
  return extractNumbers(text).filter((f) => !matches(f, pool)).map((f) => f.raw)
}

/** Same, with a few words of context so a corrective retry (and the dev log) can say where the number came from. */
export function ungroundedWithContext(text: string, pool: readonly number[]): string[] {
  return extractNumbers(text)
    .filter((f) => !matches(f, pool))
    .map((f) => `${f.raw} (in "${text.slice(Math.max(0, f.index - 30), f.index + f.raw.length + 20).replace(/\s+/g, ' ')}")`)
}

/**
 * Pool for the brief: every figure in the dossier except the bulk year x month matrices (afcd, pct, annual arrays) and
 * the live `now`. The climatology quantiles and similar years stay in, since the brief may legitimately touch them.
 */
export function briefPool(d: Dossier): number[] {
  const { detail, now: _now, ...facts } = d
  void _now
  return numbersIn(JSON.stringify({ ...facts, climatology: detail.climatology, similarYears: detail.similarYears }))
}

/** Pool for Ask: the whole dossier, the live summary and the numbers the user typed. */
export function askPool(d: Dossier, userTexts: readonly string[]): number[] {
  return [...numbersIn(JSON.stringify(d)), ...userTexts.flatMap((t) => extractNumbers(t).map((f) => f.value))]
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
  const bad = [...new Set(ungroundedWithContext(all.join(' \n '), briefPool(d)))]
  if (bad.length) problems.push(`these numbers are not in the statistics: ${bad.slice(0, 5).join('; ')}`)
  return { brief, problems }
}
