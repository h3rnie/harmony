// Wire contract of POST /api/brief: the compact statistics payload. Imported by the client (builder in payload.ts)
// and by the server (validator in web/server/briefValidate.ts). No imports, so plain Node can load it.
//
// Design rules:
//  - Only numbers the brief may quote. Everything is already rounded to a sensible precision.
//  - Rank fields say which end is which (1 = most active) so the model cannot flip them.
//  - The area label is the only free text and is untrusted; the server sanitises it again.

export const PAYLOAD_VERSION = 1
export const PAYLOAD_MAX_BYTES = 8 * 1024
export const LABEL_MAX_CHARS = 80

export type Level = 'normal' | 'above' | 'well-above' | 'extreme' | 'below' | 'well-below'
export const LEVELS: readonly Level[] = ['normal', 'above', 'well-above', 'extreme', 'below', 'well-below']

export interface BriefPayload {
  v: typeof PAYLOAD_VERSION
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
    /** AFCD-M: MODIS-equivalent active-fire cell-days. */
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
    isLatestMonth: boolean
  }
  yearToDate: {
    year: number
    throughMonth: string
    /** current YTD / baseline median YTD */
    ratio: number | null
    /** 1 = most active year-to-date on record */
    rankMostActive: number
    ofYears: number
  }
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
  }
  provenance: {
    /** ISO date of the newest detection in the data build, if known. */
    dataThrough: string | null
    recordStartYear: number
    baselineYears: [number, number]
  }
}
