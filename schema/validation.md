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
| `params` | object | `tau` (null = no cell multiplier), `tau_rmse_1deg` {tau: LOYO log1p-RMSE at 1° cell-month}, `tau_bridge`, `ci_scale`, `k_level_share` {fallback level: share of stratum×dn×moy factors} |
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
