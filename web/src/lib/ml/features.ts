// Feature rows for the ML challenger, rebuilt from L0 tile columns + meta.json.
// Must mirror pipeline/harmony_pipeline/ml_challenger.py `features()` exactly (order and formulas);
// the names are checked against model.json at load time.
import type { Meta, TileColumns } from '../kernel/types'

export const L0_NX = 7200
export const BIOMES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
export const REALMS = ['AT', 'AN', 'AA', 'IM', 'NA', 'NT', 'OC', 'PA']
export const FEATURES = [
  'log1p_v', 'log_det_per_cd', 'dn', 'sin_moy', 'cos_moy', 'lat',
  ...BIOMES.map((b) => `biome_${b}`), ...REALMS.map((r) => `realm_${r}`),
]
export const NF = FEATURES.length
const NC = 6

function popcount(x: number) {
  let n = 0
  for (let v = x | 0; v; v &= v - 1) n++
  return n
}

/** Per-stratum one-hot offsets and per-month satellite counts, computed once per meta. */
export function featureContext(meta: Meta) {
  const nsat = meta.months.viirs_sats.map((b) => Math.max(1, popcount(b)))
  const biomeCol = meta.strata.map((s) => { const j = BIOMES.indexOf(s.biome); return j < 0 ? -1 : NC + j })
  const realmCol = meta.strata.map((s) => { const j = REALMS.indexOf(s.realm); return j < 0 ? -1 : NC + BIOMES.length + j })
  return { nsat, biomeCol, realmCol }
}
export type FeatureContext = ReturnType<typeof featureContext>

/** Writes the raw (unstandardised) features of tile row `i` into x at row `r`. */
export function writeRow(ctx: FeatureContext, t: TileColumns, i: number, x: Float32Array, r: number) {
  const o = r * NF
  const v = t.v[i] / 100
  const m = t.m[i]
  const lv = Math.log1p(v)
  x.fill(0, o, o + NF)
  x[o] = lv
  x[o + 1] = Math.log1p(t.nvii[i] / (ctx.nsat[m] ?? 1)) - lv
  x[o + 2] = t.dn[i]
  const ang = (2 * Math.PI * ((m % 12) + 0.5)) / 12
  x[o + 3] = Math.sin(ang)
  x[o + 4] = Math.cos(ang)
  x[o + 5] = ((Math.floor(t.cell[i] / L0_NX) + 0.5) * 0.05 - 90) / 90
  const b = ctx.biomeCol[t.stratum[i]] ?? -1
  if (b >= 0) x[o + b] = 1
  const rl = ctx.realmCol[t.stratum[i]] ?? -1
  if (rl >= 0) x[o + rl] = 1
}
