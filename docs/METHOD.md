# Method

How Harmony turns MODIS and VIIRS active-fire detections into one record, how that record is checked, and where it is weak. Written for a reader who knows fire remote sensing. The code is the reference: `pipeline/harmony_pipeline/` (parameters in `config.py`) and `crates/harmony-core/src/` (kernel). Every measured number is in the section [Measured values](#measured-values-as-of-the-2026-11-15-build); the rest of the text refers to those tables by name, so a data refresh only changes that section.

Contents: [1 Problem](#1-problem) · [2 Filters](#2-filters) · [3 Unit](#3-the-unit-afcd-m) · [4 Availability and coverage](#4-satellite-availability-and-coverage-correction) · [5 Static sources](#5-static-source-mask) · [6 Strata](#6-strata) · [7 Calibration](#7-calibration-model) · [8 Terra bridge](#8-terra-bridge) · [9 Final series](#9-the-final-series-and-the-switch) · [10 Uncertainty](#10-uncertainty) · [11 Validation](#11-validation) · [12 ML challenger](#12-ml-challenger) · [13 Live pace](#13-live-now-versus-normal-pace) · [14 Outlook](#14-outlook) · [15 Statistics](#15-statistics-in-the-interface) · [16 Limits](#16-known-limitations-and-what-would-improve-it) · [Measured values](#measured-values-as-of-the-2026-11-15-build) · [References](#references)

## 1. Problem

MODIS (Terra from 2000-11, Aqua from 2002-07; 1 km pixels) is ending, probably around 2027, and its orbits have drifted since about 2021. VIIRS 375 m (S-NPP from 2012-01, NOAA-20 from 2018, NOAA-21 from 2023-03) is its successor. VIIRS detects smaller and cooler fires and reports many more pixels, so a count of detections is not comparable across the two. Table M1 gives the measured ratio of VIIRS to MODIS detections by year. It is about 4 while only S-NPP flies, jumps in 2018 when NOAA-20 joins (each satellite adds its own detections of the same fires), and then stays near 8 to 9. A time series of raw counts therefore has two artificial steps, in 2012 and in 2018, that are larger than most real year-to-year changes. Table M4 shows what a change-point test finds in the raw series at the sensor switch, and in the harmonized one.

The aim is a record whose unit means the same thing in 2003 and in 2025, so that "this month against the median of the same month" is a valid statement for any area.

## 2. Filters

Source: standard-quality FIRMS country-year files and the FIRMS area API (see [README](../README.md#nasa-data-used)). Defined in `normalize.py`, `static_mask.py`.

- MODIS: `confidence >= 30` (`MODIS_MIN_CONFIDENCE`).
- VIIRS: confidence `n` or `h` (nominal or high); `l` is dropped.
- `type == 0` (presumed vegetation fire) when `type` exists. Rows from the near-real-time API have no `type`.
- The static-source mask (section 5) is applied to every row, including near-real-time rows.
- Exact duplicates on (satellite, UTC time, latitude, longitude) are dropped. These arise where country files overlap at borders. Standard-quality rows replace near-real-time rows per (satellite, UTC month): if a month has any standard row for a satellite, that satellite's near-real-time rows for the month are dropped.

A detection that passes these filters is called *accepted* or *used*. The counts of accepted detections (`nmod`, `nvii`) are carried in the tiles as the naive "hotspot count".

## 3. The unit: AFCD-M

An active-fire cell-day (AFCD) is one distinct triple

```
(0.0125 deg sub-cell, local-solar date, day|night)   with >= 1 accepted detection
```

Sub-cells nest exactly in the 0.05° serving cell (4 x 4). The local-solar date is the date of `UTC time + longitude / 15 h`, so a night overpass belongs to one calendar day wherever it is. Day and night follow FIRMS `daynight`. Cell-days are summed per 0.05° cell, month and day|night. The same definition is used for both sensors, and `AFCD-M` means an AFCD after calibration to the MODIS scale.

What the unit fixes. Several VIIRS pixels on one fire, and several overpasses of one sensor pair on the same sub-cell and day and period, count once. This removes most of the difference in pixel count that comes from VIIRS's finer pixel, and makes counts additive over time and area.

What it does not fix. It is not burned area, fire radiative power or fire size. It does not correct for clouds, smoke or overpass time, and it leaves a residual ratio between sensors (about 2.4 to 3 in Table M1) that depends on land cover and time of day. That residual is what the calibration in section 7 estimates.

## 4. Satellite availability and coverage correction

Code: `availability.py`.

A satellite-day is *available* if its global detection count exceeds 5 % of the centred 31-day rolling median of that satellite's daily counts (zero-filled within its operating period), and an input file covers the date. This finds outages and partial days without a hand-kept list. Table M5 lists the unavailable days it found; they include the Terra power anomaly of 2001, the Terra safe-hold of 2016 and the S-NPP safe mode of 2022. A regional run cannot use the count rule (quiet regions legitimately have zero counts) and uses the nominal operating period minus known outages instead.

Monthly coverage:

```
cov_terra = fraction of days Terra is available
cov_modis = cov_terra                       before 2002-07
          = (f_terra + f_aqua) / 2          from 2002-07
cov_viirs = fraction of days with >= 1 VIIRS satellite available
```

A stream is divided by its coverage, `x / cov`, when `cov >= 0.5`, with the factor capped at 2 (`COV_MIN`, `COV_MAX_CORR`). Below 0.5 the value is left uncorrected (and such months are excluded from the calibration fit); the coverage arrays in `meta.json` record the fraction, and the kernel falls back to the other stream only when a stream's coverage is exactly zero. A month with coverage between 0 and 0.5 is therefore shown uncorrected, which understates it.

The VIIRS stream is a per-day mean over the VIIRS satellites available on that day, never a sum. Each satellite's sub-cell-day carries weight `1 / n`, where `n` is the number of VIIRS satellites available that UTC date, and weight 0 on days the satellite is flagged unavailable. NOAA-20 and NOAA-21 are first scaled to S-NPP units by a factor `c20`, `c21` per stratum and day|night, estimated as `sum(S-NPP) / sum(NOAA-x)` over months where both satellites were available every day. If either sum is below 200 cell-days (`K_MIN_SUM`) the factor falls back to the biome, then the global value; without NOAA-21 overlap, `c21 = c20`. With these, the per-cell-month VIIRS value is

```
V = ws + c20 * w20 + c21 * w21        (all coverage-corrected by cov_viirs)
```

where `ws`, `w20`, `w21` are the weighted sub-cell-day sums per satellite. Because `V` is a mean over operating satellites, adding NOAA-20 in 2018 does not double it. Table M3 gives the NOAA-20 factors.

## 5. Static-source mask

Gas flares, industrial heat, kilns, volcanoes and similar sources are detected every day and would be counted as fire. `static_mask.py` masks a 0.0125° sub-cell, over all sensors and years, if

1. it has 5 or more detections labelled `type` 1, 2 or 3 (`MASK_TYPED_MIN`); or
2. type 1, 2 or 3 is more than half of its typed detections, with at least 3 typed; or
3. it is persistent: accepted VIIRS detections in at least 10 distinct months of a calendar year, in at least 3 different years.

The set is dilated by one sub-cell in all eight directions to absorb geolocation jitter. The `type` field is absent from near-real-time data, so the mask is the only static-source filter that near-real-time rows receive in the pipeline. The live view (section 13) does not apply it. Table M5 gives the size of the mask.

## 6. Strata

Code: `strata.py`. The calibration ratio differs by land cover (different fire sizes, temperatures, durations), so it is fitted per stratum: RESOLVE Ecoregions 2017 **biome x realm** (14 biomes x 8 realms), plus one "unclassified" stratum. A 0.05° cell takes the stratum of its centre; if the centre falls outside every ecoregion (coasts, lakes, rock and ice) it takes the nearest ecoregion within 0.25°, else "unclassified". Table M5 gives the counts.

The original plan also used a cropland flag from MODIS land cover (MCD12C1). It was not implemented; see section 16.

## 7. Calibration model

Code: `calibrate.py`. Notation: `M` is the MODIS stream (Terra or Aqua cell-days, `m_ta`) divided by `cov_modis`; `V` is the VIIRS stream above; `s` is a stratum, `d` day or night, `k` month of the year.

**Model.** For an L0 cell `i` (0.05°), month `t`:

```
E[M_it] = k[s(i), d, moy(t)] * r[i, d] * V_it
```

with a log link and `log V` as offset, fitted by quasi-Poisson maximum likelihood. For the stratum factor the estimate is the ratio of sums over the fit window:

```
k[s, d, k] = sum(M) / sum(V)       over 2012-02 .. 2021-12, months with cov_modis, cov_viirs, f_aqua >= 0.5
```

**Why this window.** It is the period in which MODIS and VIIRS both operate, before the MODIS orbital drift. The coefficients are applied unchanged to every later month, so a drift in MODIS after 2021 shows up as a drift in the out-of-time check and is not absorbed into the calibration.

**Fallback levels.** A ratio is accepted at a level only if `sum(M) >= 200`. The order is

```
stratum x dn x month-of-year  ->  stratum x dn  ->  biome x dn  ->  global x dn
```

Table M3 gives the share of the factors that end up at each level.

**Per-cell multiplier.** A cell can have a persistent offset from its stratum (land use, a fire regime the stratum average does not capture). It is estimated by empirical-Bayes shrinkage towards 1 (a gamma-Poisson posterior mean):

```
r[i, d] = (sum_t M_it + tau) / (sum_t k * V_it + tau)
```

`tau` is chosen from {5, 10, 20, 50, infinity} by leave-one-year-out RMSE of `log1p` at 1° cell-month scale (infinity means no multiplier). Table M3 shows the RMSE by `tau`; a small `tau` wins, so the data support a strong cell effect. A new fire area with no MODIS history has `r = 1` and takes its stratum's factor.

**Calibrated VIIRS** (what the tiles carry as `kv`):

```
kv = V * k[s, d, moy] * r[i, d]
```

## 8. Terra bridge

Aqua starts in 2002-07, so MODIS before that is Terra alone, with about half the overpasses. A second model of the same form maps Terra-only cell-days `m_t` to Terra+Aqua `m_ta`: ratio per stratum x dn x month-of-year (`kb`) and per-cell multiplier (`rb`), fitted on 2003-01 to 2011-12, when both fly and neither has drifted, with `tau` chosen the same way (Table M3).

```
meq(t) = m_t * kb * rb / cov_terra       for 2000-11 .. 2002-06
meq(t) = m_ta / cov_modis                from 2002-07
```

The bridge is a coarser tool than the VIIRS calibration (its leave-one-year-out RMSE is larger, Table M3) and its months carry the Terra bridge source code in the app.

## 9. The final series and the switch

For month `t` and area weights `w_i` (fraction of cell `i` inside the area):

```
H(t) = sum_i w_i * meq_it     if t < switch   (Terra bridge before 2002-07, native MODIS after)
H(t) = sum_i w_i * kv_it      if t >= switch  (calibrated VIIRS)
```

The default switch is 2023-01 (`default_switch_m = 276`), and the user can move it anywhere in the record from the interface. Each stream falls back to the other if it has no coverage in a month (`series.rs`, `source_for`). The source of every month (none, bridge, MODIS, VIIRS) and a provisional flag travel with the series, and the interface shows the source as a marker, never as a different scale.

MODIS is used up to the switch because it is the longer, independently validated record, and because both streams exist in the overlap, so the seam can be checked directly (section 11). The switch is late (2023) so that the 2012-2022 overlap, in which the calibration is fitted, is mostly shown from observation.

## 10. Uncertainty

Variance of the VIIRS-derived value `H = sum w_i kv_i` for one month (`series.rs`, the same formula as in [the contract](../schema/data-contract.md)):

```
Var = ci_scale^2 * sum over (stratum s, dn d) of [ relvar[s,d] * S^2  +  S  +  alpha[s,d] * Q ]
S   = sum_{i in s,d} w_i * kv_i               (AFCD units)
Q   = sum_{i in s,d} w_i^2 * kvsq_i           kvsq_i = kv_i^2 at L0, summed upward
sigma_log = sqrt(Var) / max(H, 0.5)
bounds    = H * exp(-/+ z * sigma_log),       z = 1.2816 (80 %) and 1.96 (95 %)
```

- `relvar[s,d]` is the relative variance of `k`: the year-jackknife variance of the fitted factor, divided by `k^2`, weighted by `V` over months of the year. It represents estimation error of the calibration and is fully correlated within a stratum (it multiplies `S^2`).
- `S` is the Poisson part and `alpha * Q` the over-dispersion part: negative-binomial variance `mu + alpha mu^2` at L0 cell-month, `alpha` by method of moments on in-sample residuals (global value per day|night where a stratum has under 200 cell-days).
- Terra-bridge months use `relvar_bridge` and `meq` in place of `kv`, with no dispersion term. Native MODIS months have no interval.
- `ci_scale` is the factor on `sigma_log` that makes the 80 % interval cover 80 % of leave-one-year-out 1° cell-months whose predicted value is at least 5 AFCD. Table M3 gives it, and the coverage by size class.

Reading the result. A scale factor well above 1 means the model terms above leave out a large part of the real error, mainly the year-to-year variability of the true VIIRS-to-MODIS ratio (a given year can be above or below the fitted mean, and `relvar` only measures how well the mean is known). The factor is a calibration of the interval to the held-out data, not a derived quantity. The 80 % level is exact by construction on the tuning set; the 95 % level is not (Table M3), and coverage falls for the largest cells. The interval was validated on 1° cell-months, not on the area sums the app shows, so it is least tested for very large areas.

## 11. Validation

All tests below are in `calibrate.py` and stored in `data/dist/validation.json`, which the app reads and shows ([schema](../schema/validation.md)). Results: Tables M2 to M4.

**Leave-one-year-out (LOYO), 2012-2021.** For each year `y`, `k` and `r` are refitted on the other nine years (with the same `tau`) and used to predict `y` from VIIRS; the prediction is compared with observed MODIS. Scored at two scales: stratum x month (a unit is a whole stratum) and 1° cell x month. Metrics per unit-month where either value is positive: Pearson `r` and RMSE of `log1p`, percentage bias, slope of observed on predicted `log1p`, the share of unit-years whose peak month is matched exactly or within one month, and the share of unit-months whose anomaly (against the unit's own month-of-year mean over the LOYO years) has the same sign in prediction and observation.

`tau` itself is not refitted per fold: it is the value of {5, 10, 20, 50, infinity} that minimises these same leave-one-year-out 1° errors, so the scores reported here carry some selection optimism from that five-way choice (expected to be small with five candidates and close to a million cell-months, but not measured separately). Within every fold, `k` and the per-cell multiplier `r` are refitted without the held-out year, so they never see the year they predict.

**Naive baseline.** One global ratio `sum(M)/sum(V)` fitted leave-one-year-out, with no strata, season, day|night or cell multiplier, scored the same way. It is the right yardstick for what the structure of the model adds. Table M2 shows the result: the structure reduces log-RMSE clearly at both scales and improves peak timing, but it does not improve the sign of anomalies at stratum scale, where the global ratio is slightly better. The honest reading is that most of the anomaly information is in `V` itself and the calibration mainly corrects level and seasonality.

**Out-of-time, 2022 onward.** The frozen fit is applied after the fit window and compared with MODIS, which still operates, by year (Table M2). Terra and Aqua drift changes the sampled time of day, so some of the bias is MODIS behaviour rather than calibration error; the data cannot separate the two. The bias in the latest full year is the largest.

**Change-point test at the switch and at VIIRS start.** Pettitt's (1979) non-parametric test on the log monthly global total minus its month-of-year mean, in a 72-month window around the event, on two series: harmonized (`meq` before, `kv` after) and naive (`nmod` before, `nvii` after). A significant change at the event month means a seam. Table M4: the naive series has an overwhelmingly significant step of the size of the sensor ratio; the harmonized one has none at the 5 % level. The harmonized test places its (insignificant) change month near 2022-10, which is the month Terra lost data for 13 days; this coincidence was not tested.

**Aqua-only sensitivity.** `k` is refitted against Aqua alone (without the cell multiplier) and the log anomalies of the stratum-month series are correlated with those of the production series. The anomaly series does not depend materially on which MODIS satellite is the reference (Table M2). Aqua's absolute level is about two thirds of Terra+Aqua, as expected from half the overpasses.

**Log-log slope diagnostic.** The ratio model is proportional (`M = kV`). The OLS slope of `log M` on `log V` at 1° cell-month, by biome, tests this. Slopes are below 1 in every biome (Table M2): at fine scales MODIS grows more slowly than VIIRS as fire density rises, which a proportional model cannot represent. It is reported as a diagnostic and is not corrected. It is one reason the model is weaker for the most active cells and for the extremes.

**Reconciliation.** `verify.py` checks that rows are conserved through the pipeline, that standard and near-real-time never overlap, that tile totals equal the count of accepted detections at every level, that levels add exactly, that the points archive holds every normalized row, that sampled official country files have the same row count as the zips, and prints the top anomaly months per realm. See the [README](../README.md#tests-and-checks) for its status.

## 12. ML challenger

Code: `ml_challenger.py`; schema [ml.md](../schema/ml.md). A cross-check on the production ratio method, not a replacement. It never feeds the served record.

- Form: `mu = v * exp(f(x))`, with `f` a 28-64-64-32-1 ReLU network (8,129 parameters), output clipped to [-8, 4]. The multiplicative form matches the production model, gives zero for zero VIIRS and sums sensibly over cells and months. With a Poisson loss the ratio method is the special case `f = log k[stratum, dn, moy]`, so any gain comes from the extra smooth inputs.
- Inputs: `log1p(v)`, detections per cell-day (a fire-size proxy), day|night, sine and cosine of month of year, latitude, biome and realm one-hot. All can be rebuilt in the browser from tile columns and `meta.json`.
- Loss and training: Poisson deviance on L0 cell-month-dn rows with `v > 0`; hand-written numpy forward and backward passes with Adam, 8 epochs, 4 million sampled rows, fixed seed; then one global mass-balance scalar so that the model also accounts for MODIS cell-days in cell-months without any VIIRS, which a row-level `v * exp(f)` cannot (the ratio of sums absorbs them).
- Protocol: fitted on 2012-02 to 2018-12 and scored on 2019-2021 (a fixed temporal split, not LOYO) against the naive ratio, the stratum ratio, the production ratio with cell multiplier, and the challenger with and without that multiplier. Out of time: fitted on the full window and applied to 2022-2025.
- Result (Table M6): on the held-out years the challenger lowers log-RMSE against the production method at both scales, with similar overall bias, but its worst biome bias is larger, and out of time it is no more stable than the ratio method. The ratio method stays in production because it is transparent, has per-stratum mass balance and cannot fail on unseen strata; the challenger is offered in the Method lab as a cross-check on the selected area, run on WebGPU where available and WASM otherwise, only at the finest tile level.
- Parity: the ONNX graph agrees with the training forward pass to about 1e-6 relative (`data/work/ml/run.log`).

## 13. Live now-versus-normal pace

Code: `web/src/lib/live/pace.ts`, `web/server/liveCore.ts`. Question: is the last week unusual for this area and month? It is a different, deliberately simpler computation than the monthly record, because near-real-time data are unscreened and there is no month to calibrate yet.

1. Rows: near-real-time detections from NOAA-20 and NOAA-21 inside the area polygon, confidence nominal or high, filtered by the day|night option. MODIS near-real-time rows are shown and counted but not used for the pace, because the recent record is calibrated VIIRS. S-NPP is not requested.
2. Cell-days: distinct (0.0125° sub-cell, local-solar date, day|night), per satellite.
3. Per local-solar day, the mean over the satellites that reported (never the sum). A satellite with no rows anywhere in the fetched box on a day when the other has 20 or more is treated as not reporting.
4. Conversion: `AFCD-M = VIIRS cell-days * k_eff(calendar month)`, with `k_eff = sum(kv) / sum(v)` over that calendar month in the area's own monthly series (fallback: all months; if neither exists, no conversion and the result is labelled raw VIIRS cell-days).
5. Normal daily pace: the climatological median of the calendar month divided by its number of days; the bands use the 10th, 25th, 75th and 90th percentiles and the maximum of the baseline. The level label is extreme above the maximum, well-above above the 90th percentile, above the 75th, below the 25th, well-below under the 10th, else normal.
6. Only complete local-solar days (inside the fetched window and more than 3 hours old) enter the pace; the current day is shown, not averaged.

Approximations. The normal pace spreads a monthly median evenly over the days of the month, so it ignores within-month shape. `k_eff` is an average over months and stratum mixtures in the area, not the per-stratum, per-cell calibration. Near-real-time rows have no static-source screening and lower quality than standard rows. The window is at most 7 days, and the box is snapped outward to 0.5°, so rows are filtered to the polygon in the browser. The result is a pace indicator, not a monthly value, and it is not mixed into the record.

## 14. Outlook

Code: `outlook.rs`. A 1 to 3 month look-ahead for the area, on the harmonized series. With `x = log1p(H)`, climatology `mu_k` the mean of `x` for calendar month `k` over the baseline years, and anomaly `a = x - mu_k`:

```
rho_h  = lag-h autocorrelation of the anomalies (h = 1..3), set to 0 unless it exceeds 1.96/sqrt(n), clipped to [0, 0.95]
x_hat  = mu_k + rho_h * a_latest
80 % band: x_hat plus the 10th and 90th percentiles of the in-sample residuals a(t+h) - rho_h * a(t)
skill  = 1 - MSE_model / MSE_climatology,   leave-one-year-out lead-1 hindcast on the log scale (mu and rho re-estimated without the target year)
```

If skill is 0 or below the outlook is the baseline climatology itself (median and 10th to 90th percentile range), and the interface says so. Skill is computed per area when it is drawn; no global skill figure is stored. It needs at least 24 anomaly pairs. The model is deliberately simple; it extends the seasonal cycle by the persistence of this year's departure and does not use weather, fuel or climate indices.

## 15. Statistics in the interface

Computed by the kernel on the harmonized monthly series of the area (`stats.rs`, `trend.rs`, `season.rs`).

- **Baseline** for a calendar month: the harmonized values of that month in the chosen baseline years (default 2003-2022); months without coverage are left out and true zeros are kept. Quantiles use the type-7 definition.
- **Ratio, percentile, rank, robust z** of a month against its baseline: ratio to the median, percentile rank among the baseline values, rank among all years, and `(x - median) / max(1.4826 MAD, max(sqrt(median), 0.5))` (the floor, the Poisson standard deviation of a count of that size, keeps quiet months from producing huge scores). Level labels from the percentile: at or below 10 well below, up to 25 below, below 75 normal, below 90 above, below 97.5 well above, else extreme.
- **Year to date** against the envelope of past years built from years with complete data through each month.
- **Trend.** Theil-Sen slope of the annual totals of complete years with Sen's 95 % interval, and the Mann-Kendall test for significance.
- **Season.** Peak month, the shortest circular window holding 80 % of the annual median profile, and a second peak if a local maximum above half the main peak lies more than two months away.
- **Seam** (per area). Over months where both streams exist, the raw VIIRS-to-MODIS ratio, the harmonized ratio and their correlation.

## 16. Known limitations and what would improve it

| Limitation | Effect | Improvement |
| --- | --- | --- |
| No cropland stratum | Agricultural burning (short, small, often at fixed overpass hours) is pooled with the biome. The cell multiplier absorbs part of it. | Add a cropland flag from a land-cover product (MODIS MCD12C1 was planned) as a third stratum dimension. |
| Interval inflated by a factor rather than modelled | The factor `ci_scale` hides a missing variance component (between-year variability of the ratio). The interval is validated on 1° cell-months, not on large area sums. | Model the between-year variance of `k` per stratum directly (a random year effect) and validate on area sums. |
| Sub-linear relation between `V` and `M` at fine scale | Proportional ratio overstates the benefit of high VIIRS counts in the busiest cells. | A concave link (power of `V`) per biome, or the ML model as production if its biome bias can be controlled. |
| MODIS drift and ending | The reference sensor drifts after 2021 and stops about 2027; the out-of-time check cannot separate drift from calibration error. | Use VIIRS 750 m M-band active fire as an alternative bridge, or an independent reference. |
| Detections are not burned area | Counts do not give area burned. | Cross-check against a burned-area product, for example GFED5 (Chen et al. 2023) or the FIRMS burned-area layers, as an external validation of the monthly ranks. |
| Persistent sources missed by the mask | A source that FIRMS does not label and that is active for less than 10 months a year is counted. | Tune the persistence rule against known flare locations. |
| Count-based availability | A genuine regional quiet period is not confused with an outage because counts are global, but a small partial outage of one satellite may not be flagged. | Use the satellites' own granule metadata. |
| Coefficients are refitted at every rebuild | They are *frozen* in the sense of a fixed fit window and are not stored between builds, so a rebuild can move them slightly (the mask and the availability table are recomputed over all data). | Store the coefficient files with the release and make the build read them. |
| Daily time zones | Local-solar date uses longitude / 15 h, not civil time zones. | Intentional; documented here so that day boundaries are not mistaken for civil days. |

## Measured values (as of the 2026-11-15 build)

Update this section from the files named in each caption after a refresh; nothing else in this document contains data-dependent numbers. The build has global scope. It contains no 2026 VIIRS data and NOAA-21 only for 2023-03 to 2023-05, so the 2026 row of `ratio_by_year` is not meaningful and is omitted.

**Table M1. Raw and harmonized VIIRS-to-MODIS ratios by year** (`validation.json`, `ratio_by_year`). Count ratio = VIIRS detections / MODIS detections; AFCD ratio = sum of uncalibrated `v` / sum of `meq`; harmonized ratio = sum of `kv` / sum of `meq`. 2012 starts in February for VIIRS, so its ratios are not comparable.

| Year | MODIS detections | VIIRS detections | Count ratio | AFCD ratio (raw) | Harmonized ratio |
| --- | --- | --- | --- | --- | --- |
| 2012 | 4,517,497 | 17,026,686 | 3.77 | 2.41 | 0.89 |
| 2013 | 3,829,553 | 15,345,242 | 4.01 | 2.78 | 1.00 |
| 2014 | 3,998,116 | 16,080,781 | 4.02 | 2.78 | 1.00 |
| 2015 | 4,286,105 | 17,125,903 | 4.00 | 2.74 | 0.99 |
| 2016 | 3,993,330 | 16,229,159 | 4.06 | 2.79 | 0.98 |
| 2017 | 4,019,931 | 15,876,344 | 3.95 | 2.68 | 0.98 |
| 2018 | 3,750,479 | 26,547,649 | 7.08 | 2.75 | 1.00 |
| 2019 | 4,108,490 | 33,412,001 | 8.13 | 2.76 | 1.00 |
| 2020 | 4,005,570 | 33,066,747 | 8.26 | 2.84 | 1.02 |
| 2021 | 3,934,529 | 32,170,091 | 8.18 | 2.76 | 1.01 |
| 2022 | 3,397,973 | 27,776,195 | 8.17 | 2.81 | 1.03 |
| 2023 | 4,174,009 | 36,857,738 | 8.83 | 2.76 | 1.02 |
| 2024 | 4,357,490 | 34,967,174 | 8.02 | 2.76 | 1.00 |
| 2025 | 3,273,755 | 28,705,568 | 8.77 | 2.98 | 1.07 |

**Table M2. Validation** (`validation.json`: `loyo`, `loyo_naive_global_ratio`, `out_of_time`, `aqua_only_sensitivity`, `beta_loglog_1deg`).

| Test | Measure | Production | Naive global ratio |
| --- | --- | --- | --- |
| LOYO stratum-month (7,272 unit-months) | r of log1p | 0.9883 | 0.9806 |
| | log-RMSE | 0.4585 | 0.6106 |
| | bias | +0.06 % | +0.00 % |
| | slope | 1.040 | 1.062 |
| | peak month exact / within one month | 0.857 / 0.938 | 0.813 / 0.918 |
| | anomaly sign agreement | 0.893 | 0.899 |
| LOYO 1-degree cell-month (939,089 unit-months) | r of log1p | 0.9439 | 0.9278 |
| | log-RMSE | 0.6005 | 0.6805 |
| | slope | 1.006 | 0.999 |
| | peak month exact / within one month | 0.777 / 0.891 | 0.770 / 0.885 |
| | anomaly sign agreement | 0.843 | 0.844 |
| Out-of-time bias (stratum-month r) | 2022 | +1.19 % (0.984) | not computed |
| | 2023 | +1.51 % (0.988) | |
| | 2024 | -0.04 % (0.987) | |
| | 2025 | +7.28 % (0.984) | |
| Aqua-only sensitivity | correlation of log anomalies, production vs Aqua-only reference | 0.982 (lowest by biome: unclassified 0.857, tundra 0.951, tropical grasslands 0.963; others 0.98-0.995) | |
| Log-log slope, 1-degree, by biome | OLS slope of log M on log V | 0.66 (mangroves) to 0.94 (tropical and subtropical grasslands); all below 1 | |

Stratum-month log-RMSE by biome ranges from 0.17 (deserts) to 0.41 (flooded grasslands) for most biomes; it is 1.20 for boreal forest, 1.36 for tundra and 0.67 for the unclassified stratum (`loyo.stratum_month.by_biome`).

**Table M3. Calibration parameters and interval** (`validation.json`, `params`, `interval_coverage_loyo_1deg`, `noaa_scale`, `meta.json`).

| Item | Value |
| --- | --- |
| Strata | 64 (63 biome x realm, 1 unclassified) |
| `tau` (VIIRS calibration); 1-degree LOYO RMSE for tau = 5 / 10 / 20 / 50 / none | 5; 0.6005 / 0.6091 / 0.6182 / 0.6290 / 0.6453 |
| `tau_bridge` | 20 |
| Share of the 1,536 factors (64 strata x 2 x 12 months) by fallback level: stratum x dn x month / stratum x dn / biome x dn / global x dn | 66.9 % / 23.0 % / 8.6 % / 1.6 % |
| NOAA-20 to S-NPP factor `c20`: median, range across strata and day|night | 0.978; 0.871 to 1.112 |
| V-weighted `k` by biome (VIIRS to MODIS-equivalent), day | 0.29 (mangroves) to 0.60 (temperate conifer forests) |
| V-weighted `k` by biome, night | 0.14 (montane grasslands) to 0.36 (tundra) |
| Bridge LOYO RMSE at tau_bridge (1-degree) | 0.8223 |
| `ci_scale` | 2.2368 |
| 80 % interval coverage, unscaled | 0.481 |
| 80 % / 95 % coverage after scaling, all cells with H >= 5 (373,041 cell-months) | 0.800 / 0.915 |
| Same by predicted H: 5-20 (177,555), 20-100 (122,669), 100 and above (72,817) | 80 %: 0.822, 0.808, 0.734; 95 %: 0.919, 0.924, 0.889 |

**Table M4. Change-point tests** (`validation.json`, `pettitt`). Step is in natural-log units of the monthly total after removing the month-of-year mean.

| Event | Window | Series | Detected change month | p | Step |
| --- | --- | --- | --- | --- | --- |
| Switch to VIIRS, 2023-01 | 2020-01 to 2025-12 | naive counts | 2023-01 | below 0.0001 | +2.189 |
| | | harmonized | 2022-10 | 0.18 | +0.065 |
| VIIRS start, 2012-02 | 2009-02 to 2015-01 | naive counts | 2012-02 | below 0.0001 | +1.367 |
| | | harmonized | 2013-03 | 0.14 | -0.069 |

**Table M5. Availability, mask and strata** (`data/work/global_run.log`, `availability.parquet`, `static_mask.parquet`).

| Item | Value |
| --- | --- |
| Unavailable satellite-days: Terra / Aqua / S-NPP / NOAA-20 / NOAA-21 (of days in operating period) | 63 of 9,511 / 28 of 8,901 / 36 of 5,095 / 6 of 2,832 / 0 of 71 |
| Largest unavailable runs | Terra 2001-06-16 to 07-02, 2016-02-19 to 02-27, 2022-10-11 to 10-23; S-NPP 2022-07-27 to 08-10; Aqua 2022-04-01 to 04-16 |
| Masked sub-cells | 124,234 core (typed or persistent) plus 488,664 by dilation, 612,898 in all (0.15 % of the 414.7 million sub-cells) |
| Fire-active 0.05 degree cells and stratum assignment | 2,927,602; 2,904,016 inside an ecoregion, 22,659 nearest within 0.25 degrees, 927 unclassified |

**Table M6. ML challenger** (`data/dist/ml/model.json`). Fixed split: fit 2012-02 to 2018-12, test 2019-2021. Unit-months: 298,217 at 1 degree, 2,215 at stratum scale.

| Method | 1-degree r | 1-degree log-RMSE | Stratum r | Stratum log-RMSE | Bias |
| --- | --- | --- | --- | --- | --- |
| Naive global ratio | 0.930 | 0.667 | 0.980 | 0.626 | +1.79 % |
| Ratio, stratum x dn x month | 0.938 | 0.631 | 0.985 | 0.523 | +1.15 % |
| Production (ratio x cell multiplier) | 0.945 | 0.593 | 0.987 | 0.492 | +1.47 % |
| Challenger (mass-balanced) | 0.948 | 0.550 | 0.989 | 0.429 | +1.64 % |
| Challenger x cell multiplier | 0.952 | 0.527 | 0.991 | 0.395 | +1.23 % |

Out-of-time bias, 2022 / 2023 / 2024 / 2025: production +1.2 / +1.5 / 0.0 / +7.3 %; challenger -2.3 / -2.4 / -2.2 / +5.9 %; naive +0.6 / +0.4 / +0.4 / +8.4 %. Worst biome bias on the test years: challenger -15.7 %, production -9.0 %. Mass-balance factor of the shipped model: 1.0895. The `verdict` text in `model.json` is generated from the same table.

## References

- Giglio, L., Schroeder, W., Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment* 178, 31-41. doi:10.1016/j.rse.2016.02.054
- Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. *Remote Sensing of Environment* 143, 85-96. doi:10.1016/j.rse.2013.12.008
- Dinerstein, E., Olson, D., Joshi, A., et al. (2017). An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm. *BioScience* 67(6), 534-545. doi:10.1093/biosci/bix014
- Chen, Y., Hall, J., van Wees, D., et al. (2023). Multi-decadal trends and variability in burned area from the fifth version of the Global Fire Emissions Database (GFED5). *Earth System Science Data* 15(11), 5227-5259. doi:10.5194/essd-15-5227-2023
- Pettitt, A. N. (1979). A non-parametric approach to the change-point problem. *Applied Statistics* 28(2), 126-135. doi:10.2307/2346729

Bibliographic details were checked against Crossref. Sen's slope estimator and the Mann-Kendall test are standard methods (Sen 1968; Mann 1945; Kendall 1975) and are not cited with details here.
