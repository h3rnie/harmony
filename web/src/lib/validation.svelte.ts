// validation.json, loaded once and shared by the "How we know" evidence and the Method section.
// Only the parts the interface reads are typed (schema/validation.md); everything is optional so an older file
// (without the harmonize.py keys) still renders the parts it has.
import { loadValidation } from './data/tileReader'

export type Pair = [number, number] // [day, night]
export interface Skill { n: number; bias_pct: number; log_rmse: number; r_log1p: number }
export interface Cov { n: number; cov80: number; cov95: number; legacy_cov80: number; legacy_cov95: number }
export interface CoverageSet { all: Record<string, Cov>; by_group: Record<string, Cov> }
export interface FusionTest {
  switch_aqua_only: { log_rmse: number }; viirs_only: { log_rmse: number }; fused: { log_rmse: number }
  equal_weights: { log_rmse: number }
  mean_aqua_weight: number; model_cov80_vs_terra_H5: number; model_cov95_vs_terra_H5: number; n: number
}
export interface DriftRow {
  sat: 'terra' | 'aqua' | 'terra_aqua'; scope: string; dn: 0 | 1; year: number; months: number
  ratio: number; lo95_total: number; hi95_total: number; placebo: boolean
}
export interface PlaceboStat { rms_log: number; max_abs_pct: number; share_ci_covers_1: number }
export interface Diurnal { beta_per_hour: number; se: number; share_post_explained: number; shift_h_latest: number }

export interface Validation {
  ratio_by_year?: { year: number; count_ratio: number; harmonized_ratio: number }[]
  loyo?: { cell1deg_month?: { overall?: Record<string, number> }; stratum_month?: { overall?: Record<string, number> } }
  loyo_naive_global_ratio?: { cell1deg_month?: { overall?: Record<string, number> }; stratum_month?: { overall?: Record<string, number> } }
  pettitt?: {
    harmonized?: { p: number; step_log: number; change_month: string }; naive?: { p: number; step_log: number; change_month: string }
    at_viirs_start?: { harmonized?: { p: number; step_log: number; change_month: string }; naive?: { p: number; step_log: number; change_month: string } }
  }
  out_of_time?: { by_year: { year: number; bias_pct: number; months?: number }[] }
  error_model?: {
    phi: Record<string, Record<string, Pair>>
    rho: Record<string, Record<string, Pair>>
    kappa: Pair
    common_mode?: { day?: { kappa_aqua_viirs: number }; night?: { kappa_aqua_viirs: number } }
  }
  fusion?: {
    non_circular_terra_reference: { years: [number, number]; cell1deg_month: FusionTest; stratum_month: FusionTest }
    modis_weight_by_era: Record<string, { cell1deg_median: number; cell1deg_activity_weighted: number }>
  }
  drift?: {
    ref_years: [number, number]
    group_names: string[]
    table: DriftRow[]
    placebo: Record<string, Record<string, { day: PlaceboStat; night: PlaceboStat }>>
    overpass: { sat: string; year: number; dn: 0 | 1; shift_h: number; n: number }[]
    diurnal_sensitivity: Record<'terra' | 'aqua', Record<string, { day: Diurnal; night: Diurnal }>>
  }
  conformal?: {
    meta: { size_edges: number[] }
    in_sample_loyo_2012_2021: CoverageSet
    out_of_time: { years: [number, number]; vs_modis_raw: CoverageSet; vs_modis_drift_corrected: CoverageSet }
  }
  noaa21_blind?: {
    by_year: {
      year: number; months: number
      vs_modis: { stratum_month: Skill }; vs_modis_drift_corrected: { stratum_month: Skill }
      vs_noaa20_calibrated: Skill; vs_snpp_calibrated: Skill
    }[]
  }
  closure?: { weighted_mean_log: number; weighted_rms_log: number; oos_2020_2021: { chain: Skill; direct: Skill } }
  power_law?: { loyo_cell1deg: { proportional: Skill; power: Skill } }
  k_refit_2012_2019?: { global_pct: number }
}

class ValidationStore {
  data = $state.raw<Validation | null>(null)
  error = $state<string | null>(null)
  private pending: Promise<void> | null = null

  load(): Promise<void> {
    this.pending ??= loadValidation()
      .then((v) => { this.data = v as Validation })
      .catch((e) => { this.error = (e as Error).message; this.pending = null })
    return this.pending
  }
}

export const validation = new ValidationStore()

/** Size classes of the conformal tables, in order, with reader-facing labels. */
export const SIZE_CLASSES: [string, string][] = [
  ['H<5', 'under 5'], ['5-20', '5–20'], ['20-100', '20–100'], ['100-1000', '100–1,000'], ['H>=1000', '1,000 +'],
]

/** "42 % low" / "35 % high" / "unchanged" for a ratio near 1 (within 3 %). */
export function ratioWords(r: number): string {
  const d = Math.round((r - 1) * 100)
  if (Math.abs(d) <= 3) return 'unchanged'
  return `about ${Math.abs(d)} % ${d < 0 ? 'low' : 'high'}`
}
export const f2 = (v: number) => v.toFixed(2)
export const pct0 = (v: number) => `${Math.round(v * 100)} %`
export const signedPct = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)} %`
