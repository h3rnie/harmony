// Contract between the Rust/WASM kernel (crates/harmony-wasm) and the web app.
// The kernel returns these shapes as JSON strings; keep this file and the Rust serde structs in sync.

/** Month index: (year - 2000) * 12 + (month - 1). */
export type MonthIndex = number

export interface LevelMeta { level: number; cell_deg: number; tile_deg: number; nx: number; ny: number }

export interface StratumMeta {
  id: number; biome: number; realm: string; name: string
  relvar: [number, number]; alpha: [number, number]; relvar_bridge: [number, number]
  k: [number[], number[]]
}

export interface Meta {
  version: number; generated: string; data_through: string
  m_first: MonthIndex; m_last: MonthIndex
  levels: LevelMeta[]
  aqua_start_m: MonthIndex; viirs_start_m: MonthIndex; default_switch_m: MonthIndex
  fit_window_m: [MonthIndex, MonthIndex]
  months: { cov_modis: number[]; cov_viirs: number[]; provisional: number[]; viirs_sats: number[] }
  strata: StratumMeta[]
  ci_scale: number
  method: Record<string, unknown>
  sources: { name: string; years: string; quality: string }[]
}

export interface AoiInfo {
  areaKm2: number
  bbox: [number, number, number, number]   // west, south, east, north
  centroid: [number, number]               // lon, lat
}

export interface AnalyzeOptions {
  /** First month served from calibrated VIIRS. Earlier months use MODIS. */
  switchM: MonthIndex
  /** Inclusive baseline years for medians, percentiles and anomalies. */
  baseline: [number, number]
  dn: 'both' | 'day' | 'night'
  /** Inclusive display range; statistics still use the whole record. */
  range: [MonthIndex, MonthIndex]
}

/** 0 no data · 1 Terra-only bridged · 2 MODIS native · 3 calibrated VIIRS */
export type SourceCode = 0 | 1 | 2 | 3

export interface Series {
  harmonized: (number | null)[]            // AFCD-M per month
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
  cellLayer(opts: { mFrom: MonthIndex; mTo: MonthIndex; mode: 'harmonized' | 'ratio'; switchM: MonthIndex; baseline: [number, number] }): Promise<CellLayer>
}

export interface TileColumns {
  cell: Uint32Array; stratum: Uint16Array; m: Uint16Array; dn: Uint8Array
  meq: Uint32Array; kv: Uint32Array; kvsq: Float32Array; v: Uint32Array
  nmod: Uint32Array; nvii: Uint32Array
}
