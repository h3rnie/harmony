// Hotspot CSV export, core logic over the points archive (points/{px}_{py}/{year}.parquet).
// Pure functions: no Svelte, no DOM, no import.meta.env. Everything network-ish goes through an injected
// fetch-like function, so the same code runs in the browser and in the Node test (scripts/hotspots-export-test.mjs).
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet'
import type { AsyncBuffer, FileMetaData } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { pointInRings, ringsAreaKm2, ringsBbox } from '../geo'
import type { Rings } from '../geo'
import { monthIso, monthOf, yearOf } from '../format'

/** points/index.json: { "px_py": { "2023": [bytes, rows], ... } } */
export type PointsIndex = Record<string, Record<string, [number, number]>>

export interface FetchInit { headers?: Record<string, string>; signal?: AbortSignal }
/** Subset of window.fetch the reader needs (also satisfied by Node's fetch). */
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>

export const DEFAULT_MAX_ROWS = 1_000_000

/** CSV column order. */
export const CSV_COLUMNS = [
  'latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'instrument', 'confidence', 'frp', 'daynight',
  'type', 'quality', 'brightness', 'bright_2', 'scan', 'track', 'version', 'used_in_harmonized',
] as const
const PARQUET_COLUMNS = [
  'latitude', 'longitude', 'acq_time_utc', 'satellite', 'instrument', 'confidence', 'frp', 'daynight',
  'type', 'quality', 'brightness', 'bright_2', 'scan', 'track', 'version', 'used',
]

// Files up to this size are fetched whole (one request); larger ones use HTTP Range requests.
const WHOLE_FILE_LIMIT = 512 * 1024
const FOOTER_FETCH = 64 * 1024
const PLAN_CONCURRENCY = 4
const RUN_CONCURRENCY = 3

export class HotspotsAbort extends Error {
  constructor() {
    super('Hotspot export cancelled.')
    this.name = 'AbortError'
  }
}
export const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError'
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new HotspotsAbort()
}

export interface ByteCounter { bytes: number; requests: number }

/** AsyncBuffer over HTTP with byte accounting. Range requests; one whole-file fetch for small files or servers that ignore Range. */
export function makeBuffer(url: string, byteLength: number, fetcher: FetchLike, counter: ByteCounter, signal?: AbortSignal): AsyncBuffer {
  let whole: Promise<ArrayBuffer> | null = null
  const getWhole = () => {
    if (!whole) {
      const p = (async () => {
        counter.requests++
        const res = await fetcher(url, { signal })
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        counter.bytes += buf.byteLength
        return buf
      })()
      p.catch(() => { if (whole === p) whole = null })
      whole = p
    }
    return whole
  }
  return {
    byteLength,
    async slice(start: number, end?: number) {
      if (whole || byteLength <= WHOLE_FILE_LIMIT) return (await getWhole()).slice(start, end)
      counter.requests++
      const res = await fetcher(url, { signal, headers: { Range: `bytes=${start}-${end === undefined ? '' : end - 1}` } })
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      counter.bytes += buf.byteLength
      if (res.status === 200) {
        // server ignored Range and sent everything: keep it for the remaining slices of this file
        whole = Promise.resolve(buf)
        return buf.slice(start, end)
      }
      return buf
    },
  }
}

export interface PlanGroup { index: number; rowStart: number; rowEnd: number; rows: number; compressedBytes: number }
export interface PlanFile {
  key: string
  year: number
  url: string
  /** Bytes and rows according to points/index.json. */
  bytes: number
  indexRows: number
  totalGroups: number
  /** Row groups that survive bbox/time pruning, in file order. */
  groups: PlanGroup[]
  /** Row groups whose lat/lon statistics were missing (read unconditionally). */
  groupsWithoutStats: number
  metadata: FileMetaData
  buffer: AsyncBuffer
}

export interface HotspotRequest {
  rings: Rings
  mFrom: number
  mTo: number
  /** Display name of the area for the file header. */
  label?: string
}

export interface HotspotPlan {
  request: HotspotRequest
  bbox: [number, number, number, number]
  /** Files with at least one surviving row group, in deterministic order (tile px, py, then year). */
  files: PlanFile[]
  filesConsidered: number
  totalGroups: number
  keptGroups: number
  groupsWithoutStats: number
  /** Sum of row counts of surviving row groups: an upper bound on the rows exported. */
  estRows: number
  /** Heuristic expectation of the rows actually exported (statistics-based, polygon share applied). */
  likelyRows: number
  /** Compressed bytes of surviving row groups plus footer bytes already fetched. */
  estDownloadBytes: number
  /** Sum of whole-file sizes of the files considered (what an unpruned download would cost). */
  totalFileBytes: number
  /** Bytes already fetched while planning (Parquet footers). */
  metaBytes: number
  /** Rough size of the CSV, for display. */
  estCsvBytes: number
  /** Running byte/request totals, shared with the run phase. */
  counter: ByteCounter
}

export interface FileRef { key: string; year: number; bytes: number; rows: number }

/** 10 degree tiles x years intersecting bbox and month range, in deterministic order (px, py, year). */
export function selectFiles(index: PointsIndex, bbox: [number, number, number, number], mFrom: number, mTo: number): FileRef[] {
  const [w, s, e, n] = bbox
  const clampX = (v: number) => Math.min(35, Math.max(0, Math.floor((v + 180) / 10)))
  const clampY = (v: number) => Math.min(17, Math.max(0, Math.floor((v + 90) / 10)))
  const y0 = yearOf(mFrom), y1 = yearOf(mTo)
  const out: FileRef[] = []
  for (let px = clampX(w); px <= clampX(e); px++) {
    for (let py = clampY(s); py <= clampY(n); py++) {
      const key = `${px}_${py}`
      const tile = index[key]
      if (!tile) continue
      for (let year = y0; year <= y1; year++) {
        const ent = tile[String(year)]
        if (ent) out.push({ key, year, bytes: ent[0], rows: ent[1] })
      }
    }
  }
  return out
}

type Stat = { min?: unknown; max?: unknown; min_value?: unknown; max_value?: unknown } | undefined
const toNum = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'bigint') return Number(v)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function minMax(st: Stat, time: boolean): [number, number] | null {
  if (!st) return null
  const a = st.min_value ?? st.min, b = st.max_value ?? st.max
  let lo = toNum(a), hi = toNum(b)
  if (lo == null || hi == null) return null
  if (time && typeof a === 'bigint') { lo /= 1000; hi /= 1000 } // raw micros -> ms, only if hyparquet did not convert to Date
  return [lo, hi]
}

/** Row-group pruning by column statistics. Returns [mayIntersect, hadLatLonStats]; no stats means "keep". */
export function groupIntersects(
  rg: FileMetaData['row_groups'][number], bbox: [number, number, number, number], t0: number, t1: number,
): [boolean, boolean] {
  const stat = (name: string) => rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === name)?.meta_data?.statistics as Stat
  const [w, s, e, n] = bbox
  const lat = minMax(stat('latitude'), false), lon = minMax(stat('longitude'), false), tm = minMax(stat('acq_time_utc'), true)
  const hadStats = lat != null && lon != null
  if (lat && (lat[1] < s || lat[0] > n)) return [false, hadStats]
  if (lon && (lon[1] < w || lon[0] > e)) return [false, hadStats]
  if (tm && (tm[1] < t0 || tm[0] >= t1)) return [false, hadStats]
  return [true, hadStats]
}

/** Fraction of the stats range [lo, hi] that lies inside [a, b] (uniform assumption); 1 when the range is a point or unknown. */
function overlapFrac(r: [number, number] | null, a: number, b: number): number {
  if (!r) return 1
  const [lo, hi] = r
  if (!(hi > lo)) return lo >= a && lo <= b ? 1 : 0
  return Math.max(0, Math.min(hi, b) - Math.max(lo, a)) / (hi - lo)
}

/**
 * Heuristic expected share of a row group's rows that fall in the bbox and months, from its min/max statistics
 * (assumes rows spread uniformly between min and max, which is wrong for clustered fires, so it is only an indication).
 */
export function groupLikelyFraction(
  rg: FileMetaData['row_groups'][number], bbox: [number, number, number, number], t0: number, t1: number,
): number {
  const stat = (name: string) => rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === name)?.meta_data?.statistics as Stat
  const [w, s, e, n] = bbox
  return overlapFrac(minMax(stat('latitude'), false), s, n) * overlapFrac(minMax(stat('longitude'), false), w, e)
    * overlapFrac(minMax(stat('acq_time_utc'), true), t0, t1)
}

/** [start, end) of the inclusive month range, as epoch ms (UTC). */
export function monthRangeMs(mFrom: number, mTo: number): [number, number] {
  return [Date.UTC(yearOf(mFrom), monthOf(mFrom) - 1, 1), Date.UTC(yearOf(mTo), monthOf(mTo), 1)]
}

export interface HotspotProgress {
  phase: 'plan' | 'read'
  filesDone: number
  filesTotal: number
  /** Rows produced so far (read phase). */
  rows: number
  bytesFetched: number
}

export interface PlanOptions {
  index: PointsIndex
  baseUrl: string
  fetch: FetchLike
  signal?: AbortSignal
  onProgress?: (p: HotspotProgress) => void
}

export async function planHotspotExport(req: HotspotRequest, o: PlanOptions): Promise<HotspotPlan> {
  const bbox = ringsBbox(req.rings)
  const [t0, t1] = monthRangeMs(req.mFrom, req.mTo)
  const refs = selectFiles(o.index, bbox, req.mFrom, req.mTo).filter((r) => r.rows > 0)
  const counter: ByteCounter = { bytes: 0, requests: 0 }
  const results: (PlanFile | null)[] = new Array(refs.length).fill(null)
  const stats = { groups: 0, kept: 0, noStats: 0, likely: 0 }
  let done = 0
  let next = 0
  const worker = async () => {
    while (next < refs.length) {
      throwIfAborted(o.signal)
      const i = next++
      const ref = refs[i]
      const url = `${o.baseUrl}/points/${ref.key}/${ref.year}.parquet`
      const buffer = makeBuffer(url, ref.bytes, o.fetch, counter, o.signal)
      const metadata = await parquetMetadataAsync(buffer, { initialFetchSize: FOOTER_FETCH })
      const groups: PlanGroup[] = []
      let rowStart = 0, noStats = 0
      metadata.row_groups.forEach((rg, index) => {
        const rows = Number(rg.num_rows)
        const [ok, hadStats] = groupIntersects(rg, bbox, t0, t1)
        if (!hadStats) noStats++
        if (ok && rows > 0) {
          stats.likely += rows * groupLikelyFraction(rg, bbox, t0, t1)
          groups.push({
            index, rowStart, rowEnd: rowStart + rows, rows,
            compressedBytes: rg.columns.reduce((a, c) => a + Number(c.meta_data?.total_compressed_size ?? 0), 0),
          })
        }
        rowStart += rows
      })
      stats.groups += metadata.row_groups.length
      stats.kept += groups.length
      stats.noStats += noStats
      if (groups.length) {
        results[i] = {
          key: ref.key, year: ref.year, url, bytes: ref.bytes, indexRows: ref.rows,
          totalGroups: metadata.row_groups.length, groups, groupsWithoutStats: noStats, metadata, buffer,
        }
      }
      o.onProgress?.({ phase: 'plan', filesDone: ++done, filesTotal: refs.length, rows: 0, bytesFetched: counter.bytes })
    }
  }
  await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, refs.length) }, worker))
  throwIfAborted(o.signal)
  const files = results.filter((f): f is PlanFile => f != null)
  const estRows = files.reduce((a, f) => a + f.groups.reduce((b, g) => b + g.rows, 0), 0)
  const groupBytes = files.reduce((a, f) => a + f.groups.reduce((b, g) => b + g.compressedBytes, 0), 0)
  const [w, sb, e, nb] = bbox
  const bboxArea = ringsAreaKm2([[[w, sb], [e, sb], [e, nb], [w, nb], [w, sb]]])
  const polyShare = bboxArea > 0 ? Math.min(1, ringsAreaKm2(req.rings) / bboxArea) : 1
  return {
    request: req, bbox, files,
    likelyRows: Math.round(stats.likely * polyShare),
    filesConsidered: refs.length,
    totalGroups: stats.groups, keptGroups: stats.kept, groupsWithoutStats: stats.noStats,
    estRows, estDownloadBytes: groupBytes + counter.bytes,
    totalFileBytes: refs.reduce((a, r) => a + r.bytes, 0),
    metaBytes: counter.bytes,
    estCsvBytes: Math.round(stats.likely * polyShare) * 135,
    counter,
  }
}

// ---- CSV formatting -------------------------------------------------------

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const str = (v: unknown) => (v == null ? '' : quote(String(v)))

/** Shortest decimal that round-trips a float32 (Parquet FLOAT columns arrive widened to double). */
export function f32(v: unknown): string {
  if (v == null) return ''
  const x = typeof v === 'bigint' ? Number(v) : (v as number)
  if (!Number.isFinite(x)) return ''
  if (Number.isInteger(x)) return String(x)
  for (let p = 6; p < 10; p++) {
    const t = Number(x.toPrecision(p))
    if (Math.fround(t) === Math.fround(x)) return String(t)
  }
  return String(x)
}

export function csvLine(r: Record<string, unknown>): string {
  const t = r.acq_time_utc
  const ms = t instanceof Date ? t.getTime() : t == null ? NaN : Number(t)
  let date = '', time = ''
  if (Number.isFinite(ms)) {
    const iso = new Date(ms).toISOString()
    date = iso.slice(0, 10)
    time = iso.slice(11, 13) + iso.slice(14, 16)
  }
  return [
    String(r.latitude), String(r.longitude), date, time,
    str(r.satellite), str(r.instrument), str(r.confidence), f32(r.frp), str(r.daynight),
    r.type == null ? '' : String(r.type), str(r.quality), f32(r.brightness), f32(r.bright_2), f32(r.scan), f32(r.track),
    str(r.version), r.used ? 'true' : 'false',
  ].join(',')
}

export interface HeaderInfo {
  label?: string
  bbox: [number, number, number, number]
  areaKm2: number
  mFrom: number
  mTo: number
  rows: number
  truncated: boolean
  estRows: number
  generatedAt: string
  ack: string
}

const nf = (v: number) => v.toLocaleString('en-US')

/** 12.3 MB style size (decimal units). */
export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return '0 B'
  if (b < 1000) return `${Math.round(b)} B`
  if (b < 1e6) return `${(b / 1e3).toFixed(b < 1e4 ? 1 : 0)} kB`
  if (b < 1e9) return `${(b / 1e6).toFixed(b < 1e7 ? 2 : 1)} MB`
  return `${(b / 1e9).toFixed(2)} GB`
}

export function csvHeader(h: HeaderInfo): string {
  const [w, s, e, n] = h.bbox
  const f = (v: number) => String(+v.toFixed(4))
  const lines = [
    '# Harmony: hotspots (individual MODIS and VIIRS active-fire detections)',
    `# Area: ${(h.label ?? 'selected area').replace(/[\r\n]+/g, ' ')}; bbox W ${f(w)}, S ${f(s)}, E ${f(e)}, N ${f(n)}; polygon area ${nf(Math.round(h.areaKm2))} km2`,
    `# Date range: ${monthIso(h.mFrom)} to ${monthIso(h.mTo)} (inclusive months, UTC)`,
    `# Rows: ${nf(h.rows)}` + (h.truncated ? ` (truncated: the first ${nf(h.rows)} of about ${nf(h.estRows)}; narrow the area or dates for the rest)` : ''),
    `# Generated: ${h.generatedAt}`,
    '# used_in_harmonized=false rows were excluded from the harmonized record (low confidence, non-vegetation type, or static-source mask).',
    '# acq_date and acq_time are UTC; frp in MW; brightness/bright_2 in K (MODIS ch21/ch31, VIIRS I4/I5); scan/track in km.',
    `# ${h.ack}`,
  ]
  return lines.join('\n') + '\n' + CSV_COLUMNS.join(',') + '\n'
}

// ---- Run ------------------------------------------------------------------

export interface RunOptions {
  signal?: AbortSignal
  onProgress?: (p: HotspotProgress) => void
  /** Stop after this many rows (in deterministic file order) and mark the file truncated. Default: no cap. */
  rowLimit?: number
  ack: string
  now?: () => Date
}

export interface HotspotExportOk {
  kind: 'ok'
  blob: Blob
  rows: number
  /** Footer + row-group bytes fetched in total (planning included). */
  bytesFetched: number
  requests: number
  csvBytes: number
  files: number
  truncated: boolean
  groupsRead: number
}

export async function runHotspotExport(plan: HotspotPlan, o: RunOptions): Promise<HotspotExportOk> {
  const { request: req } = plan
  const [t0, t1] = monthRangeMs(req.mFrom, req.mTo)
  const [w, s, e, n] = plan.bbox
  const limit = o.rowLimit ?? Infinity
  const counter = plan.counter // continues counting from the planning phase
  const slots: (Blob[] | undefined)[] = new Array(plan.files.length)
  const chunks: Blob[] = []
  let flushed = 0
  let rows = 0 // rows produced so far (flushed or buffered)
  let filesDone = 0
  let groupsRead = 0
  let truncated = false

  const emit = () => o.onProgress?.({ phase: 'read', filesDone, filesTotal: plan.files.length, rows, bytesFetched: counter.bytes })

  // One Blob per row group keeps memory flat: the browser can keep Blob data out of the JS heap.
  const readFile = async (f: PlanFile): Promise<Blob[]> => {
    const parts: Blob[] = []
    for (const g of f.groups) {
      throwIfAborted(o.signal)
      if (rows >= limit) { truncated = true; break }
      const data = await parquetReadObjects({
        file: f.buffer, metadata: f.metadata, columns: PARQUET_COLUMNS, compressors,
        rowStart: g.rowStart, rowEnd: g.rowEnd,
      })
      throwIfAborted(o.signal)
      let out = ''
      let cnt = 0
      for (const r of data) {
        const lat = r.latitude as number, lon = r.longitude as number
        if (!(lat >= s && lat <= n && lon >= w && lon <= e)) continue
        const t = r.acq_time_utc
        const ms = t instanceof Date ? t.getTime() : Number(t)
        if (!(ms >= t0 && ms < t1)) continue
        if (!pointInRings(lon, lat, req.rings)) continue
        if (rows + cnt >= limit) { truncated = true; break }
        out += csvLine(r) + '\n'
        cnt++
      }
      groupsRead++
      rows += cnt
      if (cnt) parts.push(new Blob([out]))
      emit()
    }
    return parts
  }

  const flush = () => {
    while (flushed < slots.length && slots[flushed]) {
      for (const b of slots[flushed]!) chunks.push(b)
      slots[flushed] = undefined
      flushed++
    }
  }

  // Sequential when a row cap is in play, so "first N rows" means the first N in file order.
  const workers = Number.isFinite(limit) && limit < plan.estRows ? 1 : Math.min(RUN_CONCURRENCY, plan.files.length)
  let next = 0
  const worker = async () => {
    while (next < plan.files.length) {
      throwIfAborted(o.signal)
      const i = next++
      slots[i] = await readFile(plan.files[i])
      filesDone++
      flush()
      emit()
    }
  }
  await Promise.all(Array.from({ length: workers }, worker))
  throwIfAborted(o.signal)
  flush()

  const header = new Blob([csvHeader({
    label: req.label, bbox: plan.bbox, areaKm2: ringsAreaKm2(req.rings), mFrom: req.mFrom, mTo: req.mTo,
    rows, truncated, estRows: plan.estRows, generatedAt: (o.now ?? (() => new Date()))().toISOString(), ack: o.ack,
  })])
  const blob = new Blob([header, ...chunks], { type: 'text/csv' })
  return {
    kind: 'ok', blob, rows, bytesFetched: counter.bytes, requests: counter.requests, csvBytes: blob.size,
    files: plan.files.length, truncated, groupsRead,
  }
}

export interface HotspotTooLarge {
  kind: 'too-large'
  estimatedRows: number
  maxRows: number
  plan: HotspotPlan
}

export interface ExportOptions extends PlanOptions {
  ack: string
  label?: string
  /** Default 1,000,000. */
  maxRows?: number
  /** Export the first maxRows rows even when the estimate exceeds it. */
  force?: boolean
  now?: () => Date
}

/** One-shot: plan, refuse when the estimate exceeds maxRows (unless force), otherwise export. */
export async function exportHotspots(
  req: { rings: Rings; mFrom: number; mTo: number }, o: ExportOptions,
): Promise<HotspotExportOk | HotspotTooLarge> {
  const maxRows = o.maxRows ?? DEFAULT_MAX_ROWS
  const plan = await planHotspotExport({ ...req, label: o.label }, o)
  if (plan.estRows > maxRows && !o.force) return { kind: 'too-large', estimatedRows: plan.estRows, maxRows, plan }
  return runHotspotExport(plan, {
    signal: o.signal, onProgress: o.onProgress, ack: o.ack, now: o.now,
    rowLimit: plan.estRows > maxRows ? maxRows : undefined,
  })
}
