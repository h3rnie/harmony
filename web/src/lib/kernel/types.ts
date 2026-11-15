// Contract between the Rust/WASM kernel (crates/harmony-wasm) and the web app.
// The kernel returns these shapes as JSON strings; keep this file and the Rust serde structs in sync.

/** Month index: (year - 2000) * 12 + (month - 1). */
export type MonthIndex = number

export interface LevelMeta { level: number; cell_deg: number; tile_deg: number; nx: number; ny: number }

/** Error-model parameters of one stream, [day, night]: Var(μ) = rho μ² + phi μ (MODIS-equivalent AFCD). */
export interface StreamErr { rho: [number, number]; phi: [number, number] }

export interface StratumMeta {
  id: number; biome: number; realm: string; name: string
  relvar: [number, number]; alpha: [number, number]; relvar_bridge: [number, number]
  k: [number[], number[]]
  /** Sensor error model (schema/data-contract.md). VIIRS rows by number of satellites 1..3; its rho excludes relvar. */
  err?: { modis: StreamErr; bridge: StreamErr; viirs: { rho: [number, number][]; phi: [number, number][] } }
}

/** MODIS orbit-drift correction factors per biome ("all" = fallback), [day, night] arrays aligned with `years`. */
export interface DriftMeta {
  ref_years: [number, number]; start_year: number; years: number[]; attr_frac: number
  biome: Record<string, { log_f: [number[], number[]]; log_sd: [number[], number[]] }>
}

/** Split-conformal multipliers on sigma_log by biome group x size class (H in MODIS units). */
export interface ConformalMeta {
  size_edges: number[]
  groups: { name: string; biomes: number[] }[]
  q80: number[][]; q95: number[][]; n: number[][]
  global: { q80: number[]; q95: number[]; n: number[] }
}

export interface Meta {
  version: number; generated: string; data_through: string
  m_first: MonthIndex; m_last: MonthIndex
  levels: LevelMeta[]
  aqua_start_m: MonthIndex; viirs_start_m: MonthIndex; default_switch_m: MonthIndex
  fit_window_m: [MonthIndex, MonthIndex]
  months: { cov_modis: number[]; cov_viirs: number[]; provisional: number[]; viirs_sats: number[] }
  strata: StratumMeta[]
  /** Legacy interval inflation; used only when the error model / conformal table is absent. */
  ci_scale: number
  /** Correlation of the MODIS and VIIRS stratum-coherent error components, [day, night]. Optional. */
  fusion?: { kappa: [number, number] }
  drift?: DriftMeta
  conformal?: ConformalMeta
  method: Record<string, unknown>
  sources: { name: string; years: string; quality: string }[]
}

export interface AoiInfo {
  areaKm2: number
  bbox: [number, number, number, number]   // west, south, east, north
  centroid: [number, number]               // lon, lat
}

export interface AnalyzeOptions {
  /** First month served from calibrated VIIRS in `mode: 'switch'` (earlier months use MODIS). Ignored when fused. */
  switchM: MonthIndex
  /** Inclusive baseline years for medians, percentiles and anomalies. */
  baseline: [number, number]
  dn: 'both' | 'day' | 'night'
  /** Inclusive display range; statistics still use the whole record. */
  range: [MonthIndex, MonthIndex]
  /**
   * 'fused' (default): per month, a precision-weighted combination of every stream available (MODIS,
   * drift-corrected in the drift era, and calibrated VIIRS) under the sensor error model.
   * 'switch': MODIS before `switchM`, calibrated VIIRS from it (the original record).
   * Without an error model in meta.json, 'fused' behaves as 'switch' (see `Analysis.harmonization.mode`).
   */
  mode?: 'fused' | 'switch'
  /**
   * 'modis' (default): MODIS-equivalent cell-days. 'viirs': every MODIS-equivalent value of a month is
   * divided by the area's calibration factor of that calendar month (sum kv / sum v over the fit window), so
   * the record reads in VIIRS cell-days. Ratios, percentiles and same-month ranks are unchanged; cross-month
   * aggregates (annual totals, YTD, trend) are re-weighted when the factor varies by season.
   */
  unit?: 'modis' | 'viirs'
}

/**
 * 0 no data · 1 Terra-only bridged · 2 MODIS native · 3 calibrated VIIRS.
 * In fused mode: the stream carrying most of the weight — 3 when VIIRS contributes and the MODIS weight is
 * below 0.5 (or MODIS is not used), otherwise 1/2 when MODIS contributes.
 */
export type SourceCode = 0 | 1 | 2 | 3

export interface Series {
  harmonized: (number | null)[]            // AFCD-M per month (the fused series in fused mode)
  /** Bounds for every covered month (conformal multipliers; legacy meta: VIIRS / bridge months only). */
  lo80: (number | null)[]; hi80: (number | null)[]
  lo95: (number | null)[]; hi95: (number | null)[]
  modisEq: (number | null)[]               // MODIS-derived, where MODIS exists
  viirsCal: (number | null)[]              // calibrated VIIRS, where VIIRS exists
  viirsRaw: (number | null)[]              // uncalibrated VIIRS AFCD
  rawModisCount: number[]                  // accepted hotspot detections
  rawViirsCount: number[]
  /** What a naive concatenation would show: MODIS counts before VIIRS starts, VIIRS counts after. */
  naive: number[]
  source: SourceCode[]
  provisional: boolean[]
  /**
   * The month has a value but the stream serving it covers < 50 % of it (typically the month in
   * progress). Drawn, but never used in a statistic: `current`, YTD, ranks, records, annual totals,
   * the seam and the outlook origin all stop at the latest complete-enough month. Optional for
   * older kernels/mocks; absent = no partial months.
   */
  partial?: boolean[]
  /**
   * Share of the harmonized value carried by MODIS, 0..1 (switch mode: 1 or 0). Null where the month has no
   * value or the value is 0. Optional for older kernels/mocks.
   */
  modisWeight?: (number | null)[]
  /** MODIS after the orbit-drift correction (fused mode, drift years); equals modisEq otherwise. */
  modisAdj?: (number | null)[]
}

export interface Calendar {
  years: number[]
  /** [yearIdx][0..11]; null = month outside the record. */
  value: (number | null)[][]
  ratio: (number | null)[][]               // value / baseline median of that calendar month
  percentile: (number | null)[][]          // 0..100 among baseline years for that calendar month
  z: (number | null)[][]                   // robust z = (x - median) / (1.4826 MAD)
}

export interface Climatology {
  median: number[]; mean: number[]; q10: number[]; q25: number[]; q75: number[]; q90: number[]
  min: number[]; max: number[]             // each length 12
}

export interface Annual {
  years: number[]; total: (number | null)[]; complete: boolean[]
  /** 1 = most active complete year. */
  rank: (number | null)[]
}

export interface Ytd {
  year: number; throughMonth: number       // 1..12
  current: number[]                        // cumulative, length throughMonth
  median: number[]; q25: number[]; q75: number[]; min: number[]; max: number[]   // length 12, baseline years
  rank: number; of: number                 // rank of this year's YTD among all years at throughMonth
  ratio: number | null                     // current YTD / baseline median YTD
}

export interface Current {
  m: MonthIndex; year: number; month: number
  value: number; lo80: number | null; hi80: number | null
  median: number; ratio: number | null; percentile: number | null; z: number | null
  rank: number; of: number                 // rank among all years for this calendar month
  provisional: boolean
  /** normal | above | well-above | extreme | below | well-below — from the percentile. */
  level: string
}

export interface Trend {
  years: [number, number]
  slopePerYear: number; slopePctPerYear: number
  lo: number; hi: number                   // 95 % CI of the Theil–Sen slope
  tau: number; pValue: number
  direction: 'up' | 'down' | 'none'
}

export interface Season {
  peakMonth: number                        // 1..12, month of the highest climatological median
  startMonth: number; endMonth: number; lengthMonths: number
  /** Share of annual activity inside the season, 0..1. */
  concentration: number
  /** Second peak month if the regime is bimodal, else null. */
  secondPeak: number | null
}

export interface Outlook {
  months: MonthIndex[]                     // next 1..3 months
  median: number[]; lo80: number[]; hi80: number[]
  climatology: number[]
  /** Hindcast skill vs climatology, 1 - MSE/MSE_clim on log scale; <= 0 means no skill. */
  skill: number
  rho: number
  method: 'anomaly-persistence' | 'climatology'
}

/** How well MODIS and calibrated VIIRS agree for THIS area in their overlap months. */
export interface Seam {
  overlap: [MonthIndex, MonthIndex]
  nMonths: number
  ratioNaive: number | null                // sum raw VIIRS counts / sum raw MODIS counts
  ratioHarmonized: number | null           // sum viirsCal / sum modisEq
  r: number | null                         // Pearson r of log1p monthly values
  biasPct: number | null
}

export interface Records {
  topMonths: { m: MonthIndex; value: number; ratio: number | null }[]
  topYears: { year: number; total: number }[]
}

export interface AnalogYear {
  year: number
  /** RMS difference of log1p monthly values over months 1..throughMonth. */
  distance: number
  /** Total of months throughMonth+1..12 of that year; null when throughMonth = 12. */
  restTotal: number | null
  /** restTotal / restMedian; null when the median is 0 or throughMonth = 12. */
  restRatio: number | null
  /** Month (1..12) with the largest value after throughMonth; null if none is positive. */
  peakMonth: number | null
}

/** Past years whose year-to-date trajectory is closest to the latest year's (selected series). */
export interface Analogs {
  year: number; throughMonth: number
  /** Complete years before `year`. */
  candidates: number
  /** Up to 3, closest first (ties: earlier year). */
  top: AnalogYear[]
  /** Median rest-of-year total over the candidates. */
  restMedian: number | null
  /** SD of ln(restRatio) over `top`, and over all candidates. */
  spread: number | null; climSpread: number | null
  /** Leave-one-out hindcast skill of the 3-nearest-analog mean ln ratio vs the median (null: < 6 candidates or nothing to explain). */
  skill: number | null
  /** skill > 0.1 and spread < climSpread. */
  informative: boolean
  note: string
}

/** How the record in this analysis was built. */
export interface Harmonization {
  /** Effective mode ('fused' falls back to 'switch' when meta.json has no error model). */
  mode: 'fused' | 'switch'
  unit: 'modis' | 'viirs'
  /** 'conformal' when the error model and conformal table produced the bounds, else 'legacy'. */
  intervals: 'conformal' | 'legacy'
  /** The 12 calendar-month factors dividing MODIS-equivalent values (unit 'viirs' only). */
  lensFactor: number[] | null
  /** Some calendar month had no VIIRS in the fit window and used a pooled factor. */
  lensFallback: boolean
}

export interface Analysis {
  months: MonthIndex[]
  series: Series
  calendar: Calendar
  climatology: Climatology
  annual: Annual
  ytd: Ytd
  current: Current
  trend: Trend
  season: Season
  outlook: Outlook
  seam: Seam
  records: Records
  aoi: AoiInfo & { level: number; nCells: number; rows: number }
  /** Optional for older kernels/mocks. */
  harmonization?: Harmonization
  /** Absent when the area has fewer than 4 complete years before the latest year. */
  analogs?: Analogs
}

export interface CellLayerOptions {
  mFrom: MonthIndex; mTo: MonthIndex
  mode: 'harmonized' | 'ratio'
  switchM: MonthIndex
  baseline: [number, number]
  /** Overpass filter; absent = both. */
  dn?: AnalyzeOptions['dn']
  /** Per-row fusion ('fused', default) or the stream at `switchM` ('switch'); named apart from `mode` above. */
  seriesMode?: AnalyzeOptions['mode']
}

export interface CellLayer {
  level: number
  cells: Uint32Array        // cell ids at `level`
  weights: Float32Array     // AOI coverage fraction 0..1
  values: Float32Array      // per-cell value for the requested months
}

/** What the UI talks to (implemented by a Web Worker wrapping the WASM kernel, and by a mock). */
export interface KernelClient {
  init(meta: Meta): Promise<void>
  /** rings: GeoJSON Polygon coordinates [[[lon, lat], …], …] (first ring outer). */
  setAoi(rings: number[][][]): Promise<AoiInfo>
  /** Tile keys "tx_ty" intersecting the AOI at a level. */
  tilesFor(level: number): Promise<string[]>
  /** Clears previous data and fixes the working level. */
  begin(level: number): Promise<void>
  ingestTile(cols: TileColumns): Promise<number>
  analyze(opts: AnalyzeOptions): Promise<Analysis>
  cellLayer(opts: CellLayerOptions): Promise<CellLayer>
}

export interface TileColumns {
  cell: Uint32Array; stratum: Uint16Array; m: Uint16Array; dn: Uint8Array
  meq: Uint32Array; kv: Uint32Array; kvsq: Float32Array; v: Uint32Array
  nmod: Uint32Array; nvii: Uint32Array
}
