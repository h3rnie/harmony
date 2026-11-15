// A KernelClient that fabricates a believable Analysis from the AOI alone, so the whole UI works
// with no data and no wasm. Everything is deterministic in the AOI centroid. Numbers are NOT real.
import type {
  AnalogYear, Analogs, AnalyzeOptions, Analysis, AoiInfo, CellLayer, CellLayerOptions, KernelClient, Meta, MonthIndex, SourceCode,
  TileColumns,
} from '../kernel/types'
import { ringsAreaKm2, ringsBbox, ringsCentroid, pointInRings, type Rings } from '../geo'
import { gaussian, mannKendall, median, mulberry32, pearson, percentileOf, quantile, sortNum, theilSen } from '../stats'
import { monthOf, toM, yearOf } from '../format'

const M_FIRST = 10
// Mock "today" follows the real clock so the demo always ends on the current month.
const NOW = new Date()
const M_LAST = toM(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1)

export function mockMeta(): Meta {
  const n = M_LAST + 1
  const zeros = () => new Array(n).fill(0)
  const provisional = zeros()
  for (let m = M_LAST - 2; m <= M_LAST; m++) provisional[m] = 1
  const viirsSats = zeros().map((_, m) => (m < 145 ? 0 : m < toM(2018, 4) ? 1 : m < toM(2024, 1) ? 3 : m < toM(2026, 11) ? 7 : 6))
  const d = new Date(NOW.getTime() - 86400000)
  return {
    version: 1,
    generated: NOW.toISOString(),
    data_through: d.toISOString().slice(0, 10),
    m_first: M_FIRST,
    m_last: M_LAST,
    levels: [
      { level: 0, cell_deg: 0.05, tile_deg: 2.5, nx: 7200, ny: 3600 },
      { level: 1, cell_deg: 0.25, tile_deg: 10, nx: 1440, ny: 720 },
      { level: 2, cell_deg: 1, tile_deg: 360, nx: 360, ny: 180 },
    ],
    aqua_start_m: 30,
    viirs_start_m: 145,
    default_switch_m: toM(2023, 1),
    fit_window_m: [145, 263],
    months: {
      cov_modis: zeros().map((_, m) => (m >= M_FIRST ? 1 : 0)),
      cov_viirs: zeros().map((_, m) => (m >= 145 ? 1 : 0)),
      provisional,
      viirs_sats: viirsSats,
    },
    strata: [],
    ci_scale: 1,
    method: { note: 'mock meta — no pipeline output found' },
    sources: [
      { name: 'FIRMS MODIS C6.1 (MCD14ML)', years: '2000–2025', quality: 'standard' },
      { name: 'FIRMS VIIRS 375 m C2 (S-NPP, NOAA-20, NOAA-21)', years: '2012–2025', quality: 'standard' },
      { name: 'FIRMS NRT (MODIS, VIIRS)', years: '2026', quality: 'near real-time' },
    ],
  }
}

// Known events the demo should reproduce (centre lon/lat, radius deg, [year, month, multiplier]).
const EVENTS: { lon: number; lat: number; r: number; ms: [number, number, number][] }[] = [
  { lon: -57, lat: -9, r: 9, ms: [[2019, 8, 3.0], [2019, 9, 1.8], [2020, 8, 2.3], [2020, 9, 2.1], [2010, 9, 2.5], [2007, 9, 2.0], [2024, 9, 2.7], [2024, 8, 2.2]] },
  { lon: 150, lat: -33, r: 6, ms: [[2019, 12, 7.5], [2020, 1, 5.5], [2019, 11, 4.2], [2006, 12, 2.2], [2009, 2, 2.6], [2013, 10, 2.4]] },
  { lon: -119, lat: 57, r: 10, ms: [[2023, 8, 4.2], [2023, 7, 3.1], [2023, 6, 3.4], [2023, 5, 3.8], [2014, 7, 3.0], [2017, 8, 3.2], [2018, 8, 2.8], [2024, 7, 2.3]] },
  { lon: -61, lat: -23, r: 6, ms: [[2020, 9, 3.0], [2020, 8, 2.4], [2020, 10, 2.6], [2019, 9, 2.0], [2024, 9, 2.6], [2022, 9, 1.8]] },
  { lon: -122, lat: 40, r: 4, ms: [[2020, 9, 5.2], [2020, 8, 4.6], [2018, 11, 4.0], [2018, 8, 3.0], [2021, 8, 4.2], [2021, 7, 3.0], [2008, 7, 2.6]] },
]

interface Regime { peak: number; kappa: number; second: number | null; density: number }
function regime(lon: number, lat: number): Regime {
  if (lat < -25 && lon > 110) return { peak: 12, kappa: 2, second: null, density: 0.0016 }
  if (lat < -5 && lon > 0 && lon < 50) return { peak: 8, kappa: 3.2, second: null, density: 0.009 }
  if (lat < -5) return { peak: 9, kappa: 3.0, second: null, density: 0.006 }
  if (lat < 5) return { peak: 1, kappa: 2.2, second: 8, density: 0.004 }
  if (lat < 20) return { peak: 2, kappa: 2.8, second: null, density: 0.006 }
  if (lat < 45) return { peak: lon > 60 ? 4 : 8, kappa: 2.4, second: lon > 60 ? 10 : null, density: 0.0012 }
  return { peak: 7, kappa: 3.2, second: null, density: 0.0009 }
}
const seasonShape = (mo: number, r: Regime) => {
  const c = (p: number) => Math.exp(r.kappa * (Math.cos((2 * Math.PI * (mo - p)) / 12) - 1))
  return 0.02 + c(r.peak) + (r.second ? 0.45 * c(r.second) : 0)
}

interface Record_ {
  modisEq: number[]; viirsCal: (number | null)[]; viirsRaw: (number | null)[]
  rawModis: number[]; rawViirs: number[]; k: number; trueV: number[]
}

/** Level from rank and size (the kernel's stats::level_label): both the percentile and the ratio to the median. */
function levelOf(p: number | null, x: number, median: number): string {
  if (p == null || !(median >= 1)) return 'undefined'
  const r = x / median
  if (p >= 97.5 && r >= 2) return 'extreme'
  if (p >= 90 && r >= 1.5) return 'well-above'
  if (p >= 75 && r >= 1.2) return 'above'
  if (p <= 10 && r <= 1 / 1.5) return 'well-below'
  if (p <= 25 && r <= 1 / 1.2) return 'below'
  return 'normal'
}

export class MockKernel implements KernelClient {
  private meta: Meta = mockMeta()
  private rings: Rings = []
  private info: AoiInfo | null = null
  private level = 1
  private cache = new Map<string, Record_>()
  readonly kind = 'mock' as const

  async init(meta: Meta) { this.meta = meta }

  async setAoi(rings: number[][][]): Promise<AoiInfo> {
    this.rings = rings
    this.info = { areaKm2: ringsAreaKm2(rings), bbox: ringsBbox(rings), centroid: ringsCentroid(rings) }
    return this.info
  }

  async tilesFor(level: number): Promise<string[]> {
    const L = this.meta.levels.find((l) => l.level === level)
    if (!L || !this.info) return []
    const [w, s, e, n] = this.info.bbox
    const t = L.tile_deg
    const keys: string[] = []
    for (let tx = Math.floor((w + 180) / t); tx <= Math.floor((e + 180) / t - 1e-9); tx++)
      for (let ty = Math.floor((s + 90) / t); ty <= Math.floor((n + 90) / t - 1e-9); ty++) keys.push(`${tx}_${ty}`)
    return keys
  }

  async begin(level: number) { this.level = level }
  async ingestTile(cols: TileColumns) { return cols.cell.length }

  private seed(dn: string) {
    const [lon, lat] = this.info!.centroid
    return (Math.round(lon * 10) * 73856093) ^ (Math.round(lat * 10) * 19349663) ^ (dn === 'both' ? 0 : dn === 'day' ? 83492791 : 12345)
  }

  /** Full-record synthetic streams for this AOI. */
  private record(dn: AnalyzeOptions['dn']): Record_ {
    const key = `${this.info!.centroid.join(',')}|${this.info!.areaKm2.toFixed(0)}|${dn}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const rng = mulberry32(this.seed(dn))
    const [lon, lat] = this.info!.centroid
    const reg = regime(lon, lat)
    const dnScale = dn === 'both' ? 1 : dn === 'day' ? 0.76 : 0.24
    const base = Math.max(0.6, this.info!.areaKm2 * reg.density) * dnScale
    const slope = (rng() - 0.55) * 0.05
    const yearF = new Map<number, number>()
    for (let y = 2000; y <= yearOf(M_LAST) + 1; y++) yearF.set(y, Math.exp(0.32 * gaussian(rng)))
    const k = 3.6 + rng() * 2.4 // VIIRS / MODIS AFCD ratio
    const detM = 1.5 + rng() * 0.6 // detections per MODIS cell-day
    const detV = detM * (1.0 + rng() * 0.6) // VIIRS has more detections per cell-day still
    const events = EVENTS.filter((e) => Math.hypot(e.lon - lon, e.lat - lat) < e.r)
    const n = M_LAST + 1
    const trueV = new Array(n).fill(0)
    for (let m = M_FIRST; m <= M_LAST; m++) {
      const y = yearOf(m), mo = monthOf(m)
      let v = base * seasonShape(mo, reg) * yearF.get(y)! * (1 + slope * (y - 2013)) * Math.exp(0.28 * gaussian(rng))
      for (const e of events) for (const [ey, em, f] of e.ms) if (ey === y && em === mo) v *= f
      if (m === M_LAST) v *= 1.3 + rng() * 1.2 // keep the "now" story interesting
      trueV[m] = Math.max(0, v)
    }
    const modisEq: number[] = trueV.map((v, m) => (m < M_FIRST ? 0 : v * Math.exp(0.07 * gaussian(rng))))
    const viirsRaw: (number | null)[] = trueV.map((v, m) => (m < 145 ? null : v * k * Math.exp(0.09 * gaussian(rng))))
    const viirsCal: (number | null)[] = viirsRaw.map((v) => (v == null ? null : (v / k) * Math.exp(0.16 * gaussian(rng))))
    const rawModis = modisEq.map((v) => Math.round(v * detM))
    const rawViirs = viirsRaw.map((v) => (v == null ? 0 : Math.round(v * detV)))
    const rec = { modisEq, viirsCal, viirsRaw, rawModis, rawViirs, k, trueV }
    this.cache.set(key, rec)
    return rec
  }

  async analyze(opts: AnalyzeOptions): Promise<Analysis> {
    if (!this.info) throw new Error('setAoi first')
    const meta = this.meta
    const rec = this.record(opts.dn)
    const switchM = Math.max(meta.viirs_start_m, opts.switchM)
    const n = M_LAST + 1
    const prov = (m: number) => meta.months.provisional[m] === 1

    // Harmonized full record + intervals. Fused (default): a MODIS weight that falls with the (mock) orbit
    // drift after 2020, bounds on every month; switch: the original hard switch. Lens 'viirs': values x k.
    const mode = opts.mode ?? 'fused'
    const unit = opts.unit ?? 'modis'
    const lensK = unit === 'viirs' ? rec.k : 1
    const H: (number | null)[] = new Array(n).fill(null)
    const lo80: (number | null)[] = new Array(n).fill(null), hi80 = [...lo80], lo95 = [...lo80], hi95 = [...lo80]
    const wM: (number | null)[] = new Array(n).fill(null)
    const modisAdj: (number | null)[] = new Array(n).fill(null)
    const src: SourceCode[] = new Array(n).fill(0)
    for (let m = M_FIRST; m <= M_LAST; m++) {
      const y = yearOf(m)
      const drift = y >= 2020 ? Math.exp(0.012 * (y - 2019)) : 1
      modisAdj[m] = rec.modisEq[m] / drift
      const vc = rec.viirsCal[m]
      let v: number, w: number
      if (mode === 'switch') {
        const useV = m >= switchM && vc != null
        v = useV ? vc! : rec.modisEq[m]
        w = useV ? 0 : 1
        modisAdj[m] = rec.modisEq[m]
      } else if (vc == null) {
        v = modisAdj[m]!; w = 1
      } else {
        w = Math.min(0.7, Math.max(0.2, 0.7 - 0.08 * Math.max(0, y - 2019)))
        v = w * modisAdj[m]! + (1 - w) * vc
      }
      H[m] = v
      wM[m] = v > 0 ? w : null
      src[m] = w < 0.5 ? 3 : m < meta.aqua_start_m ? 1 : 2
      const rel = src[m] === 1 ? 0.035 : 0.018
      const sig = Math.sqrt(rel + 1 / Math.max(v, 0.5))
      const [q80, q95] = mode === 'switch' && src[m] === 2 ? [1.2816 * 1.3, 1.96 * 1.3] : [1.2816 * 1.25, 1.96 * 1.25]
      lo80[m] = v * Math.exp(-q80 * sig); hi80[m] = v * Math.exp(q80 * sig)
      lo95[m] = v * Math.exp(-q95 * sig); hi95[m] = v * Math.exp(q95 * sig)
    }
    const lensed = (arr: (number | null)[]) => arr.map((x) => (x == null ? null : x * lensK))
    for (const arr of [H, lo80, hi80, lo95, hi95, modisAdj]) arr.splice(0, arr.length, ...lensed(arr))
    const modisEqL = rec.modisEq.map((x) => x * lensK)
    const viirsCalL = lensed(rec.viirsCal)

    // Climatology over baseline years.
    const [b0, b1] = opts.baseline
    const base: number[][] = Array.from({ length: 12 }, () => [])
    for (let y = b0; y <= b1; y++) for (let mo = 1; mo <= 12; mo++) {
      const m = toM(y, mo)
      if (m >= M_FIRST && m <= M_LAST && H[m] != null) base[mo - 1].push(H[m]!)
    }
    const bs = base.map(sortNum)
    const q = (p: number) => bs.map((a) => (a.length ? quantile(a, p) : 0))
    const clim = {
      median: q(0.5), q10: q(0.1), q25: q(0.25), q75: q(0.75), q90: q(0.9), min: q(0), max: q(1),
      mean: bs.map((a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)),
    }
    const mad = bs.map((a, i) => (a.length ? median(a.map((v) => Math.abs(v - clim.median[i]))) : 0))
    const ratioOf = (v: number, mo: number) => (clim.median[mo - 1] > 0 ? v / clim.median[mo - 1] : null)
    const pctOf = (v: number, mo: number) => (bs[mo - 1].length ? percentileOf(v, bs[mo - 1]) : null)
    const zOf = (v: number, mo: number) => (mad[mo - 1] > 0 ? (v - clim.median[mo - 1]) / (1.4826 * mad[mo - 1]) : null)

    // Display range.
    const r0 = Math.max(M_FIRST, opts.range[0]), r1 = Math.min(M_LAST, opts.range[1])
    const months: MonthIndex[] = []
    for (let m = r0; m <= r1; m++) months.push(m)
    const pick = <T,>(arr: T[]) => months.map((m) => arr[m])
    const naive = rec.rawModis.map((v, m) => (m < meta.viirs_start_m ? v : rec.rawViirs[m]))

    const years: number[] = []
    for (let y = yearOf(r0); y <= yearOf(r1); y++) years.push(y)
    const cell = (y: number, mo: number) => {
      const m = toM(y, mo)
      return m < r0 || m > r1 ? null : H[m]
    }
    const calendar = {
      years,
      value: years.map((y) => Array.from({ length: 12 }, (_, i) => cell(y, i + 1))),
      ratio: years.map((y) => Array.from({ length: 12 }, (_, i) => { const v = cell(y, i + 1); return v == null ? null : ratioOf(v, i + 1) })),
      percentile: years.map((y) => Array.from({ length: 12 }, (_, i) => { const v = cell(y, i + 1); return v == null ? null : pctOf(v, i + 1) })),
      z: years.map((y) => Array.from({ length: 12 }, (_, i) => { const v = cell(y, i + 1); return v == null ? null : zOf(v, i + 1) })),
      partial: years.map(() => new Array<boolean>(12).fill(false)),
    }

    // Annual totals (display range), completeness and rank.
    const total = years.map((y) => {
      let s = 0, any = false
      for (let mo = 1; mo <= 12; mo++) { const v = cell(y, mo); if (v != null) { s += v; any = true } }
      return any ? s : null
    })
    const complete = years.map((y) => {
      for (let mo = 1; mo <= 12; mo++) { const m = toM(y, mo); if (m < r0 || m > r1 || prov(m)) return false }
      return true
    })
    const order = years.map((_, i) => i).filter((i) => complete[i] && total[i] != null).sort((a, b) => total[b]! - total[a]!)
    const rank = years.map((_, i) => (order.includes(i) ? order.indexOf(i) + 1 : null))

    // Year to date.
    const yNow = yearOf(M_LAST), through = monthOf(M_LAST)
    const cum = (y: number) => {
      const out: number[] = []; let s = 0
      for (let mo = 1; mo <= 12; mo++) { const m = toM(y, mo); s += m >= M_FIRST && m <= M_LAST ? H[m] ?? 0 : 0; out.push(s) }
      return out
    }
    const baseCum: number[][] = []
    for (let y = Math.max(b0, 2001); y <= b1; y++) baseCum.push(cum(y))
    const qc = (p: number) => Array.from({ length: 12 }, (_, i) => quantile(sortNum(baseCum.map((c) => c[i])), p))
    const cur = cum(yNow).slice(0, through)
    const ytdAll: number[] = []
    for (let y = 2001; y <= yNow; y++) ytdAll.push(cum(y)[through - 1])
    const ytdNow = cur[through - 1]
    const ytdMed = qc(0.5)
    const ytd = {
      year: yNow, throughMonth: through, current: cur,
      median: ytdMed, q25: qc(0.25), q75: qc(0.75), min: qc(0), max: qc(1),
      rank: 1 + ytdAll.filter((v) => v > ytdNow).length, of: ytdAll.length,
      ratio: ytdMed[through - 1] > 0 ? ytdNow / ytdMed[through - 1] : null,
    }

    // Current month.
    const cm = M_LAST, cmo = monthOf(cm), cv = H[cm]!
    const sameMonth: number[] = []
    for (let y = 2000; y <= yNow; y++) { const m = toM(y, cmo); if (m >= M_FIRST && m <= M_LAST) sameMonth.push(H[m]!) }
    const pct = pctOf(cv, cmo)
    const current = {
      m: cm, year: yNow, month: cmo, value: cv, lo80: lo80[cm], hi80: hi80[cm],
      median: clim.median[cmo - 1], ratio: ratioOf(cv, cmo), percentile: pct, z: zOf(cv, cmo),
      rank: 1 + sameMonth.filter((v) => v > cv).length, of: sameMonth.length,
      provisional: prov(cm), level: levelOf(pct, cv, clim.median[cmo - 1]),
    }

    // Trend on complete years in range.
    const ty = years.filter((_, i) => complete[i] && total[i] != null)
    const tv = years.map((_, i) => total[i]).filter((_, i) => complete[i] && total[i] != null) as number[]
    const ts = ty.length >= 3 ? theilSen(ty, tv) : { slope: 0, intercept: 0, lo: 0, hi: 0 }
    const mk = ty.length >= 3 ? mannKendall(tv) : { tau: 0, p: 1 }
    const medTot = tv.length ? median(tv) : 1
    const trend = {
      years: [ty[0] ?? yearOf(r0), ty[ty.length - 1] ?? yearOf(r1)] as [number, number],
      slopePerYear: ts.slope, slopePctPerYear: medTot > 0 ? (100 * ts.slope) / medTot : 0,
      lo: ts.lo, hi: ts.hi, tau: mk.tau, pValue: mk.p,
      direction: (mk.p < 0.05 ? (ts.slope > 0 ? 'up' : 'down') : 'none') as 'up' | 'down' | 'none',
      suppressed: false,
    }

    // Season.
    const med = clim.median
    const peak = med.indexOf(Math.max(...med)) + 1
    const thr = 0.35 * med[peak - 1]
    let start = peak, end = peak
    for (let i = 1; i < 6 && med[((peak - 1 - i) % 12 + 12) % 12] >= thr; i++) start = ((peak - 1 - i) % 12 + 12) % 12 + 1
    for (let i = 1; i < 6 && med[(peak - 1 + i) % 12] >= thr; i++) end = ((peak - 1 + i) % 12) + 1
    const len = ((end - start + 12) % 12) + 1
    const inSeason = (mo: number) => ((mo - start + 12) % 12) < len
    const sumAll = med.reduce((s, v) => s + v, 0) || 1
    let second: number | null = null
    for (let mo = 1; mo <= 12; mo++) {
      const v = med[mo - 1]
      if (!inSeason(mo) && v >= 0.4 * med[peak - 1] && v >= med[(mo + 10) % 12] && v >= med[mo % 12]) second = mo
    }
    const season = {
      peakMonth: peak, startMonth: start, endMonth: end, lengthMonths: len,
      concentration: med.reduce((s, v, i) => s + (inSeason(i + 1) ? v : 0), 0) / sumAll, secondPeak: second,
      defined: true,
    }

    // Outlook (anomaly persistence on log scale; skill decides whether to show it).
    const rng = mulberry32(this.seed(opts.dn) ^ 0x5bd1e995)
    const skill = rng() < 0.55 ? 0.08 + rng() * 0.22 : -0.02 - rng() * 0.1
    const rho = skill > 0 ? 0.35 + rng() * 0.3 : 0.1
    const a0 = Math.log((cv + 1) / (clim.median[cmo - 1] + 1))
    const oMonths = [cm + 1, cm + 2, cm + 3]
    const outlook = {
      months: oMonths, rho, skill, method: (skill > 0 ? 'anomaly-persistence' : 'climatology') as Analysis['outlook']['method'],
      climatology: oMonths.map((m) => clim.median[monthOf(m) - 1]),
      median: [] as number[], lo80: [] as number[], hi80: [] as number[],
    }
    oMonths.forEach((m, h) => {
      const c = clim.median[monthOf(m) - 1]
      const a = skill > 0 ? a0 * rho ** (h + 1) : 0
      const s = 0.55 * Math.sqrt(1 - rho ** (2 * (h + 1))) + 0.2
      outlook.median.push(Math.max(0, (c + 1) * Math.exp(a) - 1))
      outlook.lo80.push(Math.max(0, (c + 1) * Math.exp(a - 1.2816 * s) - 1))
      outlook.hi80.push((c + 1) * Math.exp(a + 1.2816 * s) - 1)
    })

    // Analog years: complete years whose log1p year-to-date trajectory is closest to this year's.
    const analogs = ((): Analogs | undefined => {
      const cands: number[] = []
      for (let y = 2001; y < yNow; y++) cands.push(y)
      if (cands.length < 4) return undefined
      const val = (y: number, mo: number) => H[toM(y, mo)] ?? 0
      const dist = (a: number, b: number) => {
        let s = 0
        for (let mo = 1; mo <= through; mo++) s += (Math.log1p(val(a, mo)) - Math.log1p(val(b, mo))) ** 2
        return Math.sqrt(s / through)
      }
      const rest = (y: number) => { let s = 0; for (let mo = through + 1; mo <= 12; mo++) s += val(y, mo); return s }
      const hasRest = through < 12
      const restMedian = hasRest ? median(sortNum(cands.map(rest))) : null
      const ratio = (y: number) => (restMedian != null && restMedian > 0 ? rest(y) / restMedian : null)
      const sd = (xs: number[]) => {
        if (xs.length < 2) return null
        const mu = xs.reduce((s, x) => s + x, 0) / xs.length
        return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1))
      }
      const logs = (ys: number[]) => ys.map(ratio).filter((r): r is number => r != null && r > 0).map(Math.log)
      const ranked = cands.map((y) => ({ y, d: dist(y, yNow) })).sort((a, b) => a.d - b.d || a.y - b.y)
      const top: AnalogYear[] = ranked.slice(0, 3).map(({ y, d }) => {
        let peak: number | null = null
        for (let mo = through + 1; mo <= 12; mo++) if (val(y, mo) > 0 && (peak == null || val(y, mo) > val(y, peak))) peak = mo
        return { year: y, distance: d, restTotal: hasRest ? rest(y) : null, restRatio: hasRest ? ratio(y) : null, peakMonth: hasRest ? peak : null }
      })
      const spread = hasRest ? sd(logs(top.map((t) => t.year))) : null
      const climSpread = hasRest ? sd(logs(cands)) : null
      const skill = hasRest ? 0.05 + (mulberry32(this.seed(opts.dn) ^ 0x2545f491)() - 0.5) * 0.3 : null
      const informative = skill != null && skill > 0.1 && spread != null && climSpread != null && spread < climSpread
      return {
        year: yNow, throughMonth: through, candidates: cands.length, top, restMedian, spread, climSpread, skill, informative,
        note: `Closest years so far: ${top.map((t) => t.year).join(', ')} (mock numbers).`,
      }
    })()

    // Seam diagnostics over the whole overlap.
    let sv = 0, sm = 0, sc = 0, se = 0
    const la: number[] = [], lb: number[] = []
    for (let m = meta.viirs_start_m; m <= M_LAST; m++) {
      sv += rec.rawViirs[m]; sm += rec.rawModis[m]; sc += rec.viirsCal[m] ?? 0; se += rec.modisEq[m]
      la.push(Math.log1p(rec.modisEq[m])); lb.push(Math.log1p(rec.viirsCal[m] ?? 0))
    }
    const rh = se > 0 ? sc / se : null
    const seam = {
      overlap: [meta.viirs_start_m, M_LAST] as [number, number], nMonths: M_LAST - meta.viirs_start_m + 1,
      ratioNaive: sm > 0 ? sv / sm : null, ratioHarmonized: rh, r: pearson(la, lb), biasPct: rh == null ? null : (rh - 1) * 100,
    }

    // Records.
    const allM: number[] = []
    for (let m = M_FIRST; m <= M_LAST; m++) allM.push(m)
    const topMonths = allM.sort((a, b) => H[b]! - H[a]!).slice(0, 5).map((m) => ({ m, value: H[m]!, ratio: ratioOf(H[m]!, monthOf(m)) }))
    const topYears = order.slice(0, 5).map((i) => ({ year: years[i], total: total[i]! }))

    const L = meta.levels.find((l) => l.level === this.level) ?? meta.levels[0]
    const nCells = Math.max(1, Math.round(this.info.areaKm2 / (111 * L.cell_deg) ** 2))

    return {
      months,
      series: {
        harmonized: pick(H), lo80: pick(lo80), hi80: pick(hi80), lo95: pick(lo95), hi95: pick(hi95),
        modisEq: pick(modisEqL), viirsCal: pick(viirsCalL), viirsRaw: pick(rec.viirsRaw),
        rawModisCount: pick(rec.rawModis), rawViirsCount: pick(rec.rawViirs), naive: pick(naive),
        source: pick(src), provisional: months.map(prov), partial: months.map(() => false),
        modisWeight: pick(wM), modisAdj: pick(modisAdj),
      },
      harmonization: {
        mode, unit, intervals: 'conformal',
        lensFactor: unit === 'viirs' ? new Array(12).fill(1 / rec.k) : null, lensFallback: false,
      },
      ...(analogs ? { analogs } : {}),
      calendar, climatology: clim,
      annual: { years, total, complete, rank },
      ytd, current, trend, season, outlook, seam,
      records: { topMonths, topYears },
      activity: {
        meanAnnual: clim.mean.reduce((a, b) => a + b, 0), sparse: false,
        nonzeroMonths: 240, baselineMonths: 240, modisEraMean: null, viirsEraMean: null,
      },
      aoi: { ...this.info, level: this.level, nCells, rows: nCells * 40 },
    }
  }

  async cellLayer(opts: CellLayerOptions): Promise<CellLayer> {
    const L = this.meta.levels.find((l) => l.level === this.level) ?? this.meta.levels[1]
    const c = L.cell_deg
    const [w, s, e, n] = this.info!.bbox
    const rng = mulberry32(this.seed('cells') ^ opts.mFrom)
    const ph = Array.from({ length: 6 }, () => rng() * Math.PI * 2)
    const fq = Array.from({ length: 6 }, () => 0.6 + rng() * 2.2)
    const span = Math.max(e - w, n - s)
    const cells: number[] = [], weights: number[] = [], values: number[] = []
    const rec = this.record(opts.dn ?? 'both')
    let agg = 0, aggMed = 0
    for (let m = opts.mFrom; m <= opts.mTo; m++) {
      agg += rec.trueV[m] ?? 0
      const mo = monthOf(m)
      const ref: number[] = []
      for (let y = opts.baseline[0]; y <= opts.baseline[1]; y++) ref.push(rec.trueV[toM(y, mo)] ?? 0)
      aggMed += median(ref)
    }
    const ratio = aggMed > 0 ? agg / aggMed : 1
    const ix0 = Math.floor((w + 180) / c), ix1 = Math.floor((e + 180) / c)
    const iy0 = Math.floor((s + 90) / c), iy1 = Math.floor((n + 90) / c)
    const field: number[] = []
    for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) {
      const lon = -180 + (ix + 0.5) * c, lat = -90 + (iy + 0.5) * c
      if (!pointInRings(lon, lat, this.rings)) continue
      const u = ((lon - w) / span) * 6, v = ((lat - s) / span) * 6
      let f = 0
      for (let k = 0; k < 3; k++) f += Math.sin(u * fq[k] + ph[k]) * Math.cos(v * fq[k + 3] + ph[k + 3])
      const hot = Math.exp(1.6 * f) * (0.5 + rng())
      cells.push(iy * L.nx + ix); weights.push(1)
      field.push(hot)
    }
    const sum = field.reduce((a, b) => a + b, 0) || 1
    for (let i = 0; i < field.length; i++) {
      if (opts.mode === 'harmonized') values.push(rng() < 0.12 ? 0 : (agg * field[i]) / sum)
      else values.push(ratio * Math.exp(0.6 * Math.log(field[i] / (sum / field.length)) * 0.5 + 0.25 * gaussian(rng)))
    }
    return { level: L.level, cells: Uint32Array.from(cells), weights: Float32Array.from(weights), values: Float32Array.from(values) }
  }
}
