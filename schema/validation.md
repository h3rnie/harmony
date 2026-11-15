# `validation.json` (v1) — calibration validation, written by `pipeline/harmony_pipeline/calibrate.py`

Served at `/data/validation.json`. Every number is in AFCD units (active-fire cell-days). Months use
the contract's index `m = (year-2000)*12 + month-1`. Floats are rounded to 4 decimals; `null` = not computable.

## Top level
| key | type | meaning |
|---|---|---|
| `version` | 1 | |
| `scope` | `"global"` \| `"regional"` | regional runs cover only the slice countries |
| `fit_window_m` | `[m0, m1]` | VIIRS→MODIS fit window (2012-02 … 2021-12) |
| `loyo_years` | `[2012, 2021]` | years held out one at a time |
| `params` | object | `tau` (null = no cell multiplier), `tau_rmse_1deg` {tau: LOYO log1p-RMSE at 1° cell-month}, `tau_bridge`, `ci_scale` (legacy interval), `k_level_share` {fallback level: share of stratum×dn×moy factors} |
| `biomes` | {biome: name} | RESOLVE biome numbers used in `by_biome` keys |
| `loyo` | Scales | leave-one-year-out skill of the harmonized prediction `k·r·V` vs observed MODIS `M` |
| `loyo_naive_global_ratio` | Scales | same, for a naive single global ratio `ΣM/ΣV` (no strata, season, day/night or cell multiplier) |
| `interval_coverage_loyo_1deg` | {bin: Coverage} | empirical coverage of the contract interval on LOYO 1° cell-months, bins of predicted H: `H_5_20`, `H_20_100`, `H_100_inf`, `H_5_inf` |
| `ratio_by_year` | [YearRatio] | the "seam": naive count ratio vs harmonized ratio, 2012 → latest |
| `out_of_time` | {note, by_year: [OOT]} | frozen fit applied after the fit window, vs still-observed MODIS |
| `pettitt` | Pettitt | change-point tests on the deseasonalised series around the switch |
| `aqua_only_sensitivity` | object | `anomaly_corr_stratum_month`, `aqua_to_main_ratio`, `by_biome` {biome: corr} |
| `beta_loglog_1deg` | {biome: {beta, n}} | OLS slope of log M on log V at 1° cell-month in the fit window (diagnostic; 1 = proportional) |
| `k_by_biome` | {biome: {name, k_day, k_night}} | V-weighted mean VIIRS→MODIS factor |
| `noaa_scale` | [{s, dn, c20, c21, level20, level21}] | NOAA-20 / NOAA-21 → S-NPP factors per stratum × dn (`as_noaa20` = no NOAA-21 overlap, c20 reused) |

## Types
**Scales** = `{ "stratum_month": Block, "cell1deg_month": Block }`. A unit is one stratum (stratum scale) or one
1° cell (1° scale; within `by_biome`, the part of the 1° cell in that biome). Values are summed over day/night.

**Block** = `{ "overall": Metrics, "by_biome": { "<biome>": Metrics } }`

**Metrics** (computed on unit-months where prediction or observation > 0):
| key | meaning |
|---|---|
| `n` | unit-months |
| `r_log1p` | Pearson r of log1p(pred) vs log1p(obs) |
| `log_rmse` | RMSE of log1p(pred) − log1p(obs) |
| `bias_pct` | 100·(Σpred − Σobs)/Σobs |
| `slope` | OLS slope of log1p(obs) on log1p(pred) (1 = calibrated) |
| `peak_exact`, `peak_within1` | share of unit-years (Σobs ≥ 10) whose peak month matches exactly / within ±1 month |
| `n_unit_years` | unit-years in the peak statistics |
| `anomaly_sign_agree` | share of unit-months where pred and obs anomalies (vs their own month-of-year means over the LOYO years) have the same sign; obs climatology ≥ 1, ≥ 3 years |

**Coverage** = `{ n, cov80, cov95, cov80_unscaled }`: share of cell-months whose observation lies inside the
80 % / 95 % interval `H·exp(∓z·ci_scale·σ_log)`, and the 80 % share before `ci_scale`.

**YearRatio** = `{ year, nmod, nvii, count_ratio = nvii/nmod, afcd_ratio_raw = Σv/Σmeq, harmonized_ratio = Σkv/Σmeq }`
(from the tiles' own values; `count_ratio` rises from about 4 to about 7-8 in 2018-2019 as NOAA-20 joins S-NPP, `harmonized_ratio` should stay ≈ 1). The first year (2012, VIIRS starts in February) and the last year (incomplete, and in the 2026-11-15 build without VIIRS) are not comparable with the full years.

**OOT** = `{ year, pred, obs, bias_pct, r_log1p_stratum_month, months }`.

**Pettitt** = `{ window_m, switch_m, harmonized: Test, naive: Test, at_viirs_start: { window_m, harmonized, naive } }`
where the harmonized series is MODIS `meq` before the switch and `kv` after, the naive series is `nmod` then `nvii`, and
**Test** = `{ change_m, change_month, K, p, step_log }` (Pettitt 1979 on log monthly totals minus month-of-year mean;
`step_log` = mean after − mean before the detected change). A small `p` at `change_m == switch_m` means a seam.

## Chart hints
- Seam chart: `ratio_by_year[].count_ratio` vs `.harmonized_ratio` by year.
- Skill table: `loyo.*.overall` next to `loyo_naive_global_ratio.*.overall`.
- Interval calibration: `interval_coverage_loyo_1deg.*.cov80` against 0.8.
- Out-of-time: `out_of_time.by_year[].bias_pct` by year, with `out_of_time.note` as the caption.

## Keys added by `harmonize.py` (2026-11; additive, same `version`)
Written after `calibrate.py` into the same file. Pairs `[d, n]` are [day, night]. "Group" = biome group of
`conformal.meta.groups` (also `drift.group_names`); group values are weighted by Terra∪Aqua cell-days.

| key | type | meaning |
|---|---|---|
| `error_model` | object | sensor error model (docs/METHOD.md section 9): `phi.{terra_aqua, terra_bridged, terra_rescaled, aqua_rescaled, snpp, noaa20, noaa21, viirs_1sat, viirs_2sat, viirs_3sat}` and `rho.{terra_aqua, terra_bridged, viirs, terra_rescaled, aqua_rescaled, viirs_relvar_floor}` as {group \| `all`: [d, n]}; `poisson_split.{phi_terra_aqua, phi_viirs_1sat, common_dispersion_factor}` (cross-check); `phi_terra_aqua_from.{terra, aqua}`; `common_mode.{day, night}` (classic and alternative TC solutions, `kappa_aqua_viirs`, `kappa_modis_viirs`); `kappa` [d, n]; `union_vs_mean_of_two_var`; `level_share` {estimate: {stratum_dn, biome_dn, global_dn, none}}; `signal_fraction_cell`; `n_cell_months`; `assumptions` [text] |
| `drift` | object | orbit-drift fingerprint (section 10), see **Drift** below |
| `conformal` | object | `meta` (= `meta.json` `conformal`), `in_sample_loyo_2012_2021` and `out_of_time.{vs_modis_raw, vs_modis_drift_corrected}` as **CoverageSet**, `note` |
| `fusion` | object | `non_circular_terra_reference.{cell1deg_month, stratum_month}` as **FusionTest**, `modis_weight_by_era`, `pettitt_fused` |
| `noaa21_blind` | {note, by_year: [..]} | per year: `vs_modis` and `vs_modis_drift_corrected` {stratum_month, cell1deg_month: Skill}, `vs_noaa20_calibrated`, `vs_snpp_calibrated`, `noaa20_vs_modis_stratum_month` (Skill) |
| `closure` | object | NOAA-20 → MODIS chain (`c20` × S-NPP factor) vs direct: `weighted_mean_log`, `weighted_rms_log`, `by_dn`, `oos_2020_2021.{chain, direct}` (Skill) |
| `power_law` | object | `b_by_group`, `loyo_cell1deg` and `loyo_stratum_month` {proportional, power} (Skill); diagnostic only |
| `k_refit_2012_2019` | object | % change of the V-weighted VIIRS→MODIS factor when the fit ends in 2019: `global_pct`, `by_group` {group: [d, n]} |

**Skill** = `{ n, bias_pct, log_rmse, r_log1p }` on unit-months where either value is positive.

**Drift** = `{ note, ref_years, biome_names, group_names, table, biome_table, placebo, overpass, diurnal_sensitivity }`:
- `table`: [{ `sat` (terra \| aqua \| terra_aqua), `scope` (global \| north \| south \| group_<i>), `dn`, `year`, `months`,
  `ratio`, `lo95`, `hi95` (jackknife, t with 39 df), `lo95_total`, `hi95_total` (jackknife + placebo variance),
  `log_se`, `expected` (AFCD), `placebo` (true for the reference years, whose ratio uses leave-one-year-out factors) }].
  Chart: `ratio` by `year` per `sat` × `dn`, band `lo95_total`..`hi95_total`, a line at 1, the placebo years shaded.
- `biome_table`: Terra∪Aqua by biome: [{ scope `biome_<code>`, dn, year, ratio, lo95_total, hi95_total }].
- `placebo`: {sat: {scope: {day\|night: { rms_log, max_abs_pct, share_ci_covers_1 }}}} over the reference years.
- `overpass`: [{ `sat` (FIRMS satellite name), `year`, `dn`, `shift_h`, `n` }]: mean local solar time of detections
  minus the satellite's 2012-2019 mean for the same stratum × dn × month of year (hours).
- `diurnal_sensitivity`: {terra\|aqua: {group: {day\|night: { beta_per_hour, se, n_years, shift_h_latest,
  share_post_explained }}}}: slope of log ratio on overpass shift through the origin.

**CoverageSet** = `{ cell1deg, block5deg, stratum, all: {class: Cov}, by_group: {group: Cov} }` with classes
`H<5`, `5-20`, `20-100`, `100-1000`, `H>=1000` (predicted AFCD) and
**Cov** = `{ n, cov80, cov95, legacy_cov80, legacy_cov95 }` (share of unit-months whose observed Terra∪Aqua lies in
the conformal interval, and in the legacy `ci_scale` interval).

**FusionTest** = `{ switch_aqua_only, viirs_only, fused, fused_kappa0, equal_weights: {log_rmse, r_log1p, bias_pct},
by_size: {class: {n, switch_aqua_only, viirs_only, fused, equal_weights}}, fused_beats_both_share, mean_aqua_weight,
model_cov80_vs_terra_H5, model_cov95_vs_terra_H5, n }`: candidates scored against rescaled Terra, 2012-2019.

`fusion.modis_weight_by_era` = {era: { cell1deg_median, cell1deg_activity_weighted, cell1deg_median_H20, n_cell_months },
`global_by_year`: {year: weight}}. `fusion.pettitt_fused` = {viirs_start \| drift_start \| legacy_switch:
{ window_m, event_m, fused, switch, naive: Test }, `fused_to_modis_by_year`}.

More chart hints: drift fingerprint from `drift.table` (scope `global`, then `group_*`); diurnal sensitivity as
`beta_per_hour` per group with ±2 `se`; conformal coverage `conformal.out_of_time.vs_modis_raw.all.*.cov80` next to
`legacy_cov80`, with 0.8 marked; fusion skill from `fusion.non_circular_terra_reference.*.by_size`.
