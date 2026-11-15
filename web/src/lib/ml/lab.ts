// Method lab: run the ML challenger over the current L0 area and compare it with the production
// calibration and observed MODIS. Reads the already-cached L0 tiles (data/tileReader) and the
// kernel's per-cell AOI weights (CellLayer); everything else happens here, off the critical path.
import type { CellLayer, Meta, TileColumns } from '../kernel/types'
import { DATA_BASE } from '../config'
import { mapLimit, readTile, tileInfo, type TileIndex } from '../data/tileReader'
import { FEATURES, L0_NX, NF, featureContext, writeRow } from './features'
import { loadSession, type Provider } from './runtime'

export interface Metric { n?: number; r_log1p?: number; log_rmse?: number; bias_pct?: number; slope?: number }
export interface ModelJson {
  version: number
  generated: string
  /**
   * Data build the model was trained on: the build's meta.json `generated` (older files), or an object naming it
   * (`meta_generated`, `data_through`, `snapshot_taken`, `calib_m_last`, `trained`); absent in the oldest files.
   */
  trained_on_build?: string | { meta_generated?: string; data_through?: string; snapshot_taken?: string; calib_m_last?: number; trained?: string }
  n_params: number
  architecture: string
  form: string
  features: string[]
  onnx: { bytes: number; opset: number }
  training: { window_m: [number, number]; rows_sampled: number; mass_balance: number }
  evaluation: {
    protocol: string; train_m: [number, number]; test_m: [number, number]
    labels: Record<string, string>
    table: Record<string, { cell1deg_month: Metric; stratum_month: Metric }>
  }
  out_of_time: { note: string; by_year: Record<string, { year: number; bias_pct: number }[]> }
  verdict: string
}

let modelJson: Promise<ModelJson> | null = null
export function loadModelJson(): Promise<ModelJson> {
  modelJson ??= (async () => {
    const res = await fetch(`${DATA_BASE}/ml/model.json`, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`model.json: HTTP ${res.status}`)
    const j = (await res.json()) as ModelJson
    if (JSON.stringify(j.features) !== JSON.stringify(FEATURES)) throw new Error('model.json feature list does not match this app build')
    return j
  })().catch((e) => { modelJson = null; throw e })
  return modelJson
}

export interface Agreement { n: number; r: number | null; biasPct: number | null }
export interface LabResult {
  months: number[]                 // viirs_start_m .. m_last
  observed: (number | null)[]      // MODIS-derived AFCD (meq), null where MODIS coverage is missing
  production: number[]             // calibrated VIIRS, production k × r (tile kv)
  challenger: number[]             // ML challenger mu
  fit: { production: Agreement; challenger: Agreement }      // fit window, vs MODIS
  oot: { production: Agreement; challenger: Agreement; to: number }  // fit end + 1 .. `to`, vs MODIS
  rows: number                     // cell × month × day|night rows run through the model (v > 0)
  cellMonths: number               // distinct cell × month
  provider: Provider
  fallbackReason: string | null
  adapter: string | null
  inferMs: number
  totalMs: number
  loadMs: number
}

const BATCH = 65536

function agreement(obs: (number | null)[], pred: number[], from: number, to: number): Agreement {
  const a: number[] = [], b: number[] = []
  let so = 0, sp = 0
  for (let i = from; i <= to; i++) {
    const o = obs[i]
    if (o == null) continue
    so += o; sp += pred[i]
    if (o > 0 || pred[i] > 0) { a.push(Math.log1p(pred[i])); b.push(Math.log1p(o)) }
  }
  const n = a.length
  let r: number | null = null
  if (n >= 3) {
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n
    let sab = 0, saa = 0, sbb = 0
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db }
    r = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null
  }
  return { n, r, biasPct: so > 0 ? 100 * (sp / so - 1) : null }
}

/**
 * layer: the kernel's CellLayer at L0 (sorted cell ids + AOI weights). Returns monthly AOI totals.
 * `isCurrent` lets the caller abandon a run whose area changed meanwhile.
 */
export async function runLab(meta: Meta, index: TileIndex | null, layer: CellLayer, isCurrent: () => boolean,
  ootLastM: number = meta.m_last): Promise<LabResult | null> {
  const t0 = performance.now()
  if (layer.level !== 0) throw new Error('the lab runs at full resolution (L0) only')
  const sessionP = loadSession()
  const { cells, weights } = layer
  const wOf = new Map<number, number>()
  for (let j = 0; j < cells.length; j++) wOf.set(cells[j], weights[j])
  const keys = new Set<string>()
  for (const c of cells) keys.add(`${Math.floor((c % L0_NX) / 50)}_${Math.floor(Math.floor(c / L0_NX) / 50)}`)
  const present = [...keys].filter((k) => !index || tileInfo(index, 0, k))
  const tiles: TileColumns[] = (await mapLimit(present, 4, (k) => readTile(0, k, tileInfo(index, 0, k)?.[0]).catch((e) => {
    if (!index && /HTTP 404/.test(String(e))) return null
    throw e
  }))).filter((t): t is TileColumns => t != null)
  if (!isCurrent()) return null

  const m0 = meta.viirs_start_m, m1 = meta.m_last, nm = m1 - m0 + 1
  const months = Array.from({ length: nm }, (_, i) => m0 + i)
  const obs = new Float64Array(nm), prod = new Float64Array(nm), ml = new Float64Array(nm)
  const ctx = featureContext(meta)
  // Pass 1: rows inside the AOI with VIIRS -> feature matrix; MODIS and production sums directly.
  const sel: { t: TileColumns; i: number; w: number }[] = []
  const cm = new Set<number>()
  for (const t of tiles) {
    for (let i = 0; i < t.cell.length; i++) {
      const m = t.m[i]
      if (m < m0 || m > m1) continue
      const c = t.cell[i]
      const w = wOf.get(c)
      if (!(w != null && w > 0)) continue
      obs[m - m0] += (w * t.meq[i]) / 100
      prod[m - m0] += (w * t.kv[i]) / 100
      if (t.v[i] > 0) { sel.push({ t, i, w }); cm.add(c * 400 + m) }
    }
  }
  const sess = await sessionP
  if (!isCurrent()) return null
  const x = new Float32Array(Math.min(BATCH, Math.max(1, sel.length)) * NF)
  const v = new Float32Array(Math.min(BATCH, Math.max(1, sel.length)))
  let inferMs = 0
  for (let a = 0; a < sel.length; a += BATCH) {
    const n = Math.min(BATCH, sel.length - a)
    for (let r = 0; r < n; r++) {
      const { t, i } = sel[a + r]
      writeRow(ctx, t, i, x, r)
      v[r] = t.v[i] / 100
    }
    const t1 = performance.now()
    const mu = await sess.run(x, v, n, NF)
    inferMs += performance.now() - t1
    if (!isCurrent()) return null
    for (let r = 0; r < n; r++) {
      const { t, i, w } = sel[a + r]
      ml[t.m[i] - m0] += w * mu[r]
    }
  }
  // MODIS counts as "observed" where its month coverage is >= 0.5 (the pipeline's evaluation filter;
  // below that meq is uncorrected) — null otherwise, e.g. after MODIS ends.
  const observed = months.map((m, i) => ((meta.months.cov_modis[m] ?? 0) >= 0.5 ? obs[i] : null))
  const production = Array.from(prod), challenger = Array.from(ml)
  const fe = Math.min(meta.fit_window_m[1], m1) - m0, fs = Math.max(meta.fit_window_m[0], m0) - m0
  const result: LabResult = {
    months, observed, production, challenger,
    fit: { production: agreement(observed, production, fs, fe), challenger: agreement(observed, challenger, fs, fe) },
    oot: {
      production: agreement(observed, production, fe + 1, Math.min(ootLastM, m1) - m0),
      challenger: agreement(observed, challenger, fe + 1, Math.min(ootLastM, m1) - m0),
      to: Math.min(ootLastM, m1),
    },
    rows: sel.length, cellMonths: cm.size,
    provider: sess.provider, fallbackReason: sess.fallbackReason, adapter: sess.adapter,
    inferMs, totalMs: performance.now() - t0, loadMs: sess.loadMs,
  }
  // Dev-only hook for parity checks against the Python pipeline (cells + weights + series).
  if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__harmonyMl = { result, cells: Array.from(cells), weights: Array.from(weights) }
  return result
}
