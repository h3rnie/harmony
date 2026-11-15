// Wire contract of POST /api/brief and POST /api/ask: the "area dossier". Imported by the client (builder in
// dossier.ts) and by the server (validator in web/server/ai/validate.ts). No imports, so plain Node can load it.
//
// Design rules:
//  - Facts first: everything up to `provenance` is what the brief may quote. `detail` adds what follow-up questions
//    need (the year x month matrix, climatology, annual ranks). `now` is optional live context and is the only part
//    that changes minute to minute, so the server keeps it OUT of the cached prefix.
//  - Everything is rounded here AND re-rounded on the server, and keys are built in a fixed order, so the serialised
//    dossier is byte-identical for the same area, options and viewed month. That is what makes the prompt cache hit.
//  - Rank fields say which end is which (1 = most active) so the model cannot flip them.
//  - The area label is the only free text and is untrusted; the server sanitises it again.

// v3: adds `unit` (the units lens: which scale every activity value is on). Bumped because the validator rejects unknown keys.
export const DOSSIER_VERSION = 3
export const DOSSIER_MAX_BYTES = 16 * 1024
export const LABEL_MAX_CHARS = 80

export const ASK_MAX_TURNS = 8
/** Cap for a user turn (a question). */
export const ASK_MAX_QUESTION_CHARS = 500
/** Cap for an assistant turn echoed back as history (answers are ~120 words, lists a little more). */
export const ASK_MAX_ANSWER_CHARS = 1600

export type Level = 'normal' | 'above' | 'well-above' | 'extreme' | 'below' | 'well-below'
export const LEVELS: readonly Level[] = ['normal', 'above', 'well-above', 'extreme', 'below', 'well-below']

/** The units lens: MODIS-equivalent (AFCD-M) or VIIRS-equivalent (AFCD-V) active-fire cell-days. */
export type DossierUnit = 'modis' | 'viirs'
export const DOSSIER_UNITS: readonly DossierUnit[] = ['modis', 'viirs']

export interface Dossier {
  v: typeof DOSSIER_VERSION
  /** Scale of every activity value below (month.value, intervals, medians, records, detail.afcd, climatology, outlook). */
  unit: DossierUnit
  area: {
    /** Preset name (trusted) or user-typed / uploaded label (untrusted data). */
    label: string
    isPreset: boolean
    km2: number
    /** [lon, lat] */
    centroid: [number, number]
  }
  /** The month the user is looking at. */
  month: {
    /** e.g. "August 2019" */
    label: string
    monthName: string
    year: number
    /** In `unit` (AFCD-M or AFCD-V cell-days). */
    value: number | null
    interval80: [number, number] | null
    /** Median of the same calendar month over the baseline years. */
    median: number
    /** value / median */
    ratio: number | null
    /** 0..100 among baseline years for this calendar month. */
    percentile: number | null
    /** 1 = the most active such month on record. */
    rankMostActive: number | null
    ofYears: number
    level: Level
    provisional: boolean
    /** False when the user is looking at a past month: then yearToDate describes THAT year and outlook is null. */
    isLatestMonth: boolean
  }
  /** Year to date of the viewed month's year, through the viewed month. */
  yearToDate: {
    year: number
    throughMonth: string
    /** YTD / baseline median YTD at that month */
    ratio: number | null
    /** 1 = most active year-to-date on record */
    rankMostActive: number | null
    ofYears: number
  }
  /** Whole-year total of the viewed month's year; null while that year is incomplete. */
  annual: { year: number; total: number; rankMostActive: number; ofCompleteYears: number } | null
  season: {
    peakMonth: string
    startMonth: string
    endMonth: string
    lengthMonths: number
    secondPeak: string | null
    /** The viewed month lies inside the normal season. */
    viewedMonthInSeason: boolean
  }
  trend: {
    years: [number, number]
    pctPerYear: number | null
    pValue: number | null
    direction: 'up' | 'down' | 'none'
  }
  /** Only present when the viewed month is the latest one (otherwise a forecast is meaningless). */
  outlook: {
    method: 'anomaly-persistence' | 'climatology'
    /** Hindcast skill vs climatology; <= 0 means no skill beyond climatology. */
    skill: number
    months: { label: string; median: number; lo80: number; hi80: number; normal: number }[]
  } | null
  /** Records top 3. */
  records: {
    topMonths: { label: string; value: number; ratio: number | null }[]
    topYears: { year: number; total: number }[]
  }
  /** How well MODIS and calibrated VIIRS agree in this area over their overlap. */
  seam: {
    nMonths: number
    rawViirsToModisRatio: number | null
    harmonizedRatio: number | null
    correlation: number | null
    biasPct: number | null
  }
  provenance: {
    /** ISO date of the newest detection in the data build, if known. */
    dataThrough: string | null
    recordStartYear: number
    baselineYears: [number, number]
    dayNight: 'both' | 'day' | 'night'
    /** First month served from calibrated VIIRS ("January 2012"); earlier months are MODIS. */
    switchMonth: string
    aquaStartMonth: string
    viirsStartMonth: string
    /** Months built from near-real-time detections (may be revised); at most 6, oldest first. */
    provisionalMonths: string[]
  }
  /** Year x month harmonized matrix and friends: what follow-up questions are answered from. */
  detail: {
    /** Row labels of the three matrices below (ascending). */
    years: number[]
    /** AFCD-M per [year][month 0..11], 3 significant figures; null = outside the record. */
    afcd: (number | null)[][]
    /** Percentile 0..100 among baseline years for that calendar month; null = outside the record. */
    pct: (number | null)[][]
    /** One 12-character string per year: 0 no data, 1 Terra-only bridged, 2 MODIS native, 3 calibrated VIIRS, x unknown. */
    source: string[]
    /** Baseline climatology per calendar month (index 0 = January). */
    climatology: { median: number[]; q10: number[]; q25: number[]; q75: number[]; q90: number[] }
    /** Aligned with `years`: whole-year total (null while incomplete) and rank (1 = most active complete year). */
    annualTotal: (number | null)[]
    annualRank: (number | null)[]
    /** Up to 3 other years whose January-to-viewed-month profile (log scale) is closest to the viewed year's. */
    similarYears: number[]
  }
  /** Optional live summary (last days, inside the area). Never part of the cached prefix. */
  now?: LiveNow
}

/** Live (near-real-time) context for the area, computed in the browser from the live layer when it is on. */
export interface LiveNow {
  /** Detections inside the area in the last 24 h / 48 h / 7 days. */
  last24h: number
  last48h: number
  last7d: number
  /** High-confidence detections among the last 24 h. */
  highConfidence24h: number
  /** Age of the newest detection in hours, null when there is none in the window. */
  newestAgeHours: number | null
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** The structured situation brief. */
export interface Brief {
  headline: string
  summary: string
  watch: string[]
  caveat: string
  level: Level
}
