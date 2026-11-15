# Harmony data contract (v1) — frozen interface between pipeline, kernel and web app

Everything the web app reads lives under `data/dist/` and is served at `/data/`.

```
data/dist/
  meta.json
  validation.json
  tiles/index.json
  tiles/L0/{tx}_{ty}.parquet      0.05 deg cells, 2.5 deg tiles
  tiles/L1/{tx}_{ty}.parquet      0.25 deg cells, 10 deg tiles
  tiles/L2/{tx}_{ty}.parquet      1 deg cells, 30 deg tiles (70 tiles in the 2026-11-15 build)
  points/index.json
  points/{px}_{py}/{year}.parquet raw hotspots, 10 deg tiles
  overview/…                      global 0.5 deg PNG atlases for the pulse view (see below)
```

## Grid
- Level L has cell size `c` deg and `NX = round(360/c)`, `NY = round(180/c)`.
  `ix = floor((lon + 180) / c)`, `iy = floor((lat + 90) / c)`, `cell = iy * NX + ix` (UINT32).
- Tile of size `t` deg: `tx = floor((lon + 180) / t)`, `ty = floor((lat + 90) / t)`, from the cell's SW corner.
- L0 c=0.05 t=2.5 · L1 c=0.25 t=10 · L2 c=1 t=30 (pipeline configuration, `config.LEVELS`). Readers must take the tile size from
  `meta.levels[].tile_deg`, not from this text (builds before the 2026-11-15 refresh hold L2 as one 360 deg tile `0_0`). Levels are exactly additive (L1 = sum of 5x5 L0 …).
- Month index `m = (year - 2000) * 12 + (month - 1)`; first data month is 2000-11 (m = 10).
- Active-fire cell-day (AFCD): one distinct (0.0125 deg sub-cell, local-solar date, day|night) with >= 1
  accepted detection. Local-solar date = date(UTC time + lon/15 h).

## Tile files (same schema at every level)
Parquet v1, ZSTD, sorted by (cell, stratum, m, dn). A row exists only if some value is non-zero.

| column | type | meaning |
|---|---|---|
| cell | UINT32 | cell id at this level |
| stratum | UINT16 | index into `meta.strata` (a coarse cell may have several strata rows) |
| m | UINT16 | month index |
| dn | UINT8 | 0 = day, 1 = night |
| meq | UINT32 | MODIS-derived AFCD x100. Native Terra+Aqua from 2002-07; Terra-only x bridge factor before. Already divided by MODIS month coverage. |
| kv | UINT32 | VIIRS AFCD calibrated to MODIS-equivalent, x100 (= v x k_stratum(dn, month-of-year) x cell multiplier) |
| kvsq | FLOAT | sum over the L0 cells in this row of (kv in AFCD units)^2 — for the dispersion term of the interval |
| v | UINT32 | uncalibrated VIIRS AFCD x100: per-day mean over operating VIIRS satellites (NOAA-20/21 scaled to S-NPP) |
| nmod | UINT32 | accepted MODIS detections (Terra + Aqua) — the naive "hotspot count" |
| nvii | UINT32 | accepted VIIRS detections, all satellites summed — the naive "hotspot count" |

`tiles/index.json`: `{ "L0": { "tx_ty": [bytes, rows], … }, "L1": {…}, "L2": {…} }`. Missing tile = no fire data.

## meta.json
```jsonc
{
  "version": 1,
  "generated": "2026-11-15T12:00:00Z",
  "data_through": "2025-12-31",          // last acquisition date ingested
  "m_first": 10, "m_last": 311,
  "levels": [{ "level": 0, "cell_deg": 0.05, "tile_deg": 2.5, "nx": 7200, "ny": 3600 }, …],
  "aqua_start_m": 30,                     // months before this are Terra-bridged
  "viirs_start_m": 145,                   // first month with kv
  "default_switch_m": 276,                // 2023-01
  "fit_window_m": [145, 263],
  "months": {                             // arrays indexed by m, length m_last + 1
    "cov_modis": [..], "cov_viirs": [..], // overpass coverage: cov_modis = (f_terra + f_aqua)/2 (Terra alone
                                          // before Aqua), cov_viirs = fraction of days with >= 1 VIIRS satellite
    "provisional": [..],                  // 1 if the month contains NRT (no `type`) rows
    "viirs_sats": [..],                   // bitmask 1 S-NPP, 2 NOAA-20, 4 NOAA-21
    "days_modis": [..], "days_viirs": [..] // (2026-11 review) fraction of days with >= 1 MODIS / VIIRS satellite
  },
  "complete_min_coverage": 0.9,           // (2026-11 review) a month enters statistics only when its serving
                                          // stream(s) delivered data on >= this fraction of its days (days_*);
                                          // pipeline config.COV_COMPLETE, read by the kernel, the app and watch.py
  "strata": [{ "id": 0, "biome": 7, "realm": "NT", "name": "Tropical & subtropical grasslands · Neotropic",
               "relvar": [day, night],          // Var(k)/k^2 of the VIIRS->MODIS factor (year jackknife)
               "alpha": [day, night],           // NB dispersion: var = mu + alpha mu^2 at L0 cell-month
               "relvar_bridge": [day, night],   // same for the Terra-only bridge
               "k": [[12 day], [12 night]] }],  // stratum factor by month-of-year (informational)
  "ci_scale": 1.0,                        // LEGACY: interval inflation, used only without the harmonization fields below
  "method": { … parameters, thresholds, tau … },
  "sources": [{ "name": "FIRMS MODIS C6.1 (MCD14ML)", "years": "2000-2025", "quality": "standard" }, …]
}
```

## Harmonization fields in meta.json (added 2026-11; all optional)
A reader that does not know these fields ignores them; a kernel that finds them absent falls back to the legacy
behaviour (hard switch at `switchM`, VIIRS / bridge intervals from the legacy formula below, `ci_scale`). The tile
schema is unchanged.

```jsonc
"strata": [{ …,
  "err": {                         // sensor error model, MODIS-equivalent AFCD, pairs are [day, night]
    "modis":  { "rho": [d, n], "phi": [d, n] },   // Terra∪Aqua `meq` (native, before drift correction)
    "bridge": { "rho": [d, n], "phi": [d, n] },   // Terra-only bridged `meq` (rho includes relvar_bridge)
    "viirs":  { "rho": [[d, n], [d, n], [d, n]],  // calibrated VIIRS `kv` by number of VIIRS satellites (1, 2, 3);
                "phi": [[d, n], [d, n], [d, n]] } // rho EXCLUDES relvar (the kernel adds relvar as the calibration floor)
  } }],
"fusion": { "kappa": [d, n] },     // correlation of the MODIS and VIIRS stratum-coherent (rho) error components
"drift": {                         // MODIS orbit-drift correction of `meq` (Terra∪Aqua), see validation.json `drift`
  "ref_years": [2012, 2019], "start_year": 2020, "years": [2020, …, 2026],
  "attr_frac": 0.5,                // share of |log factor| added as 1-sd attribution uncertainty
  "biome": { "<biome>": { "log_f": [[day by year], [night by year]], "log_sd": [[…], […]] }, …,
             "all": { … } }        // fallback for a biome without its own entry
},
"conformal": {                     // split-conformal multipliers on sigma_log (Mondrian: biome group x size class)
  "size_edges": [5, 20, 100, 1000],          // class c holds edges[c-1] <= H < edges[c] (class 0: H < 5)
  "groups": [{ "name": "…", "biomes": [7] }, …],
  "q80": [[per size class] per group], "q95": [[…]], "n": [[…]],
  "global": { "q80": [per size class], "q95": […], "n": […] }   // for a biome in no group
}
```
`months.viirs_sats` (bitmask 1 S-NPP, 2 NOAA-20, 4 NOAA-21) selects the VIIRS error row: number of set bits,
clamped to 1..3. `biome` of a stratum comes from `strata[].biome`.

The tiles' `meq` from 2002-07 is `m_ta` divided by a union-aware coverage per day|night,
`1 - (1 - f_aqua)(1 - t_dn) - (1 - f_terra)(1 - a_dn)` with `t_dn`, `a_dn` the shares of Terra∪Aqua cell-days seen by
Terra and by Aqua (`validation.json` `modis_union_share`), capped at x2 and applied where `cov_modis >= 0.5`
(docs/METHOD.md section 4). `cov_modis` in `meta.json` stays the overpass coverage used for the 0.5 rules.

## Completeness (2026-11 review)
A month drives statistics only when the stream(s) serving it delivered data on at least `complete_min_coverage`
(0.9) of its days: `days_modis` for MODIS (Terra or Aqua available), `days_viirs` for VIIRS; in fused mode the
larger of the used streams. Below it the month is *partial*: drawn (`Series.harmonized`, `Calendar.value`) and
flagged (`Series.partial`, `Calendar.partial`), but excluded from every baseline, ratio, percentile, level, rank,
annual total, YTD, record, analog, outlook origin, trend and the seam. When the last month of the record is partial
the analysis carries `inProgress { m, coverage, daysCovered, daysInMonth }`. Without `days_*` arrays the kernel uses
`cov_*`; without `complete_min_coverage` it uses 0.9. In the 2026-11-15 build the partial months are 2001-06
(Terra-only, 15 of 30 days), 2002-03 (Terra-only, 0.71) and 2026-11 (in progress, 15 of 30 days).

## Series formula (kernel)
Groups `g` = stratum × dn present in the AOI. Per month and group: `M_g = Σ w_i meq_i`, `V_g = Σ w_i kv_i` (AFCD).
- **MODIS stream**: bridge parameters before `aqua_start_m`, `modis` after. Drift (fused mode only), for months
  with `year >= drift.start_year` that have MODIS coverage: `f = exp(log_f[biome][dn][i])` with `i` the last listed
  year not after the month's year (the first listed year if all are later); `log_f` clamped to ±5;
  `M_g ← M_g / f`, `rho_M ← rho_M + log_sd² + (attr_frac · log f)²`.
- **VIIRS stream**: `rho_V = relvar + err.viirs.rho[n_sats]`, `phi_V = err.viirs.phi[n_sats]`.
- Stream variance at level `μ`: `Var_j(μ) = rho_j μ² + phi_j μ`; common mode
  `C(μ) = kappa sqrt(rho_M0 rho_V0) μ²` with the rho parts before drift terms and relvar, plus `relvar μ²` in
  drift-corrected months (the correction is anchored on calibrated VIIRS, so it shares its calibration error);
  `C ≤ 0.99 sqrt(Var_M Var_V)`.
- **Fused mode**: a stream is used if its coverage is > 0; if one stream is full (coverage ≥ 0.5) a partial
  one is dropped. Two streams: `μ` starts at `(M_g + V_g)/2`, then 3 times
  `w = clamp((Var_V − C) / (Var_M + Var_V − 2C), 0, 1)`, `μ = w M_g + (1 − w) V_g` (the weight is computed from
  `Var/μ`, so `μ = 0` gives the limit `phi_V / (phi_M + phi_V)` when `C = 0`).
  `H_g = μ`, `Var_g = w² Var_M + (1−w)² Var_V + 2 w (1−w) C`. One stream: that stream and its variance.
  `H = Σ H_g`, `Var = Σ Var_g` (groups independent, as in the legacy formula), MODIS weight
  `= Σ w_g H_g / Σ H_g` (null when `H = 0` or no MODIS).
- **Switch mode**: the legacy stream choice at `switchM` (no drift correction), `Var` = that stream's variance.
- **Bounds** for every covered month, on a shifted log (c = 0.5 AFCD, so a zero can be covered):
  `Var ← max(Var, Var_floor)` with `Var_floor` = the activity-weighted mean (record totals of `meq + kv` per group)
  of the groups' variance laws evaluated at `μ = c` under the month's plan (Poisson `c` when the area has no activity
  at all), so a zero month keeps an upper bound (the law alone gives `Var(0) = 0`, a 0-0 interval);
  `σ = sqrt(Var) / (H + 0.5)`, size class from `H` (MODIS units), `q = Σ_g H_g q[group(g)][class] / H` (global row
  when `H = 0`; an invalid entry falls back to the global row, then to `z · ci_scale`),
  `lo = max(0, (H + 0.5) · exp(−q σ) − 0.5)`, `hi = (H + 0.5) · exp(+q σ) − 0.5`; q80 for the 80 %, q95 for the 95 %
  bounds. With `err` but without `conformal`, `q = z · ci_scale` on the same scale (`harmonization.intervals` =
  "legacy").
- **Exactness**: in a month served by one stream without drift correction, `H` is that stream's exact total and the
  MODIS weight exactly 1 or 0, so switch mode reproduces the legacy values. Within a group the fused value lies
  between the two streams; an area total can fall slightly outside when groups disagree in direction.
- **Source code** in fused mode: 3 (VIIRS) when VIIRS is used and MODIS is not, or the MODIS weight is < 0.5;
  otherwise 1 (bridge, before `aqua_start_m`) or 2 (MODIS); 0 when no stream is used.
- **MODIS weight** (`Series.modisWeight`): null when `H = 0` or the month has no value; 1/0 in switch mode.
  `Series.modisAdj`: drift-corrected MODIS wherever MODIS has coverage in fused mode (= `modisEq` otherwise).
- **Cell layer**: `CellLayerOptions.seriesMode` (`'fused'` default | `'switch'`) fuses each tile row with its own
  stratum parameters and drift factor (`mode` there already means harmonized | ratio). The overview atlases use the
  switch rule.
- **Lens** (`unit: "viirs"`): every MODIS-equivalent value of month m (fused value, bounds, modisEq, viirsCal,
  modisAdj, calendar values, climatology, annual totals, YTD curves, current value/median/bounds, outlook levels,
  record values, analog rest totals; trend slopes keep their relative size) is divided by `f_k = Σ kv / Σ v` of
  calendar month `k` over the AOI's `fit_window_m` months (fallback: all fit-window months, then all months with
  `v > 0`, else 1; `harmonization.lensFallback` is true if any calendar month used a fallback). Season, peak month,
  percentiles, ratios, z, ranks, levels, analogs (choice, distance, ratios, skill), trend direction, p and tau, the
  outlook method and skill, the seam and `activity` are computed on the MODIS-equivalent record and do not change
  with the lens (2026-11 review; before, they were computed on the lensed record, so the season could shift).
- **Levels** (`current.level`): a label needs both rank and size, checked in this order: `extreme` percentile >= 97.5
  and ratio >= 2; `well-above` >= 90 and >= 1.5; `above` >= 75 and >= 1.2; `well-below` <= 10 and <= 1/1.5; `below`
  <= 25 and <= 1/1.2; otherwise `normal`; `undefined` when there is no baseline or the baseline median is below
  1 AFCD-M. A ratio (`current.ratio`, `calendar.ratio`, `records.topMonths.ratio`) is null when that median is below
  1 AFCD-M.
- **Activity and sparse areas** (`activity`): `meanAnnual` = sum of the 12 calendar-month baseline means (AFCD-M).
  `sparse` when `meanAnnual < 10`, or fewer than 24 baseline months have any activity, or the complete MODIS-only
  years average < 1 AFCD-M a year while the complete VIIRS years average < 20. Sparse: `trend.direction = "none"`,
  `trend.suppressed = true`, `season.defined = false`, no `analogs`, outlook method `climatology` with skill 0.
- **Analysis additions** (optional): `harmonization { mode, unit, intervals: 'conformal' | 'legacy', lensFactor,
  lensFallback }` (`mode` is the effective mode: 'switch' when meta has no error model) and `analogs`
  (`web/src/lib/kernel/types.ts`, docs/METHOD.md section 17). 2026-11 review: `activity { meanAnnual, sparse, reason?,
  nonzeroMonths, baselineMonths, modisEraMean, viirsEraMean }`, `inProgress { m, coverage, daysCovered, daysInMonth }`,
  `trend.suppressed`, `season.defined`, `calendar.partial`, and the level value `undefined`.

## Interval formula (legacy kernel, used when the fields above are absent)
For one month and AOI weights `w_i`, VIIRS-derived value `H = Σ w_i kv_i`:
`Var = ci_scale² · [ Σ_{s,dn} relvar_{s,dn} (Σ_{i∈s,dn} w_i kv_i)² + Σ_{s,dn} (Σ w_i kv_i + alpha_{s,dn} Σ w_i² kvsq_i) ]`;
`σ_log = sqrt(Var) / max(H, 0.5)`; bounds `H·exp(∓z σ_log)`, z = 1.2816 (80 %) and 1.96 (95 %).
Terra-bridged months use `relvar_bridge` with meq in place of kv (dispersion term omitted). Native MODIS months have no interval.

## Points archive (CSV export)
`points/{px}_{py}/{year}.parquet` with `px = floor((lon+180)/10)`, `py = floor((lat+90)/10)`; Parquet v1 ZSTD,
row groups <= 50 000 rows, sorted by (1 deg block = floor(lat), floor(lon); UTC month; L0 cell; acq_time_utc)
so row-group min/max statistics prune by area (latitude/longitude) and by date (acq_time_utc).

| column | type | notes |
|---|---|---|
| latitude, longitude | DOUBLE | |
| acq_time_utc | TIMESTAMP | from acq_date + acq_time |
| satellite | VARCHAR | Terra, Aqua, SNPP, NOAA20, NOAA21 |
| instrument | VARCHAR | MODIS, VIIRS |
| confidence | VARCHAR | MODIS 0-100 as text; VIIRS l/n/h |
| frp | FLOAT | MW |
| daynight | VARCHAR | D / N |
| type | TINYINT | 0 vegetation, 1 volcano, 2 static land, 3 offshore; NULL for NRT |
| quality | VARCHAR | sp / nrt |
| brightness, bright_2 | FLOAT | MODIS ch21/22 + ch31; VIIRS I4 + I5 |
| scan, track | FLOAT | km |
| version | VARCHAR | |
| used | BOOLEAN | passed the harmonization filters (confidence, type 0, not static-masked, and the land and burst screen: a row without `type` in a water cell, or a suspect row of a near-real-time burst day, is not used; docs/METHOD.md section 2) |

`points/index.json`: `{ "px_py": { "2023": [bytes, rows], … }, … }`.

## Overview grids
Small 8-bit grayscale PNGs (decoded natively by the browser) written by `overview.py` from `meta.json` and the
L1 tiles only, so they equal what the app computes. Value `x` = harmonized AFCD-M in a 0.5 deg cell for one month,
day + night, all strata: `meq` before `default_switch_m`, `kv` from it (L1 cells summed 2 x 2).

```
overview/meta.json
overview/pulse/{year}.png    2880 x 1080 atlas, 4 cols x 3 rows of months (Jan top-left, row-major)
overview/clim.png            same layout: per-cell median over 2003–2022 of each calendar month (zeros included)
overview/land.png            1440 x 720 land fraction x 255 (RESOLVE Ecoregions 2017, 2 x 2 supersampled)
overview/season.png          720 x 2520: 7 layers of 720 x 360 stacked vertically (fire clock)
overview/trend.png           720 x 1800: 5 layers of 720 x 360 stacked vertically (trend over the complete years of 2001–2025; 2003–2025 in the 2026-11-15 build)
```
- Each month is a 720 x 360 equirectangular image: row 0 = 90 N, column 0 = 180 W, 0.5 deg cells
  (`x = floor((lon + 180) / 0.5)`, `y = floor((90 - lat) / 0.5)`). Months outside `m_first..m_last` are all zero.
- Encoding `u = round(255 · min(1, sqrt(x / cap)))`, with `u >= 1` wherever `x > 0`; decode `x = cap · (u / 255)²`
  (≈1 % precision near the cap, coarser at low values: the overview is for display, the tiles are the record).
- `cap` = 99.9th percentile of the non-zero cell-months (a robust global constant).
- Signed codes (season vectors, trends): `u = 128 + round(127 · clamp(v / lim, -1, 1))`, so 1..255 with 128 = 0;
  `u = 0` is reserved for "no value" where stated. Decode `v = (u - 128) / 127 · lim`.

`season.png` (from the **mean** of each calendar month over the baseline years; layer k = rows 360k..360k+359):

| layer | content | encoding |
|---|---|---|
| 0, 1 | unit vector of the peak month, angle 2π·(month-1)/12 (cos, sin) | signed, lim 1; 128 where no fire (linear filtering stays circular) |
| 2 | concentration: resultant length of the circular mean of the 12 monthly values | 255 · R |
| 3 | mean annual activity | `round(255 · sqrt(x / season.cap))`, >= 1 where x > 0 |
| 4 | peak month | 1..12, 0 = no fire |
| 5 | second season (bimodal cells) | 1..12, 0 = none |
| 6 | season length: shortest run of consecutive months holding `season.share` (80 %) of the total | months 1..12, 0 = no fire |

`trend.png` (Theil–Sen slope of annual totals of the complete years in `trend.years`, on 3 x 3-cell = 1.5 deg moving
sums, % of the window's baseline mean per year):

| layer | content | encoding |
|---|---|---|
| 0 | trend, %/yr | signed, lim `trend.range_pct_per_yr` (10); 0 = not estimated |
| 1 | Mann–Kendall two-sided p | `1 + round(254 · (1 - p))`; 0 = not estimated |
| 2 | flag | 0 not estimated, 1 estimated, 2 significant after Benjamini–Hochberg FDR 5 % across cells |
| 3 | baseline mean annual activity of the cell | `round(255 · sqrt(x / trend.cap))` |
| 4 | same trend from the MODIS-derived stream alone (seam test) | as layer 0 |

`meta.json`:
```jsonc
{
  "version": 3, "data_through": "2026-11-05", "scope": "global" | "regional: …",
  "cap": 708.0, "cap_quantile": 99.9, "encoding": "…",
  "grid": { "cell_deg": 0.5, "width": 720, "height": 360, "row0": "north (90 N)", "col0": "180 W" },
  "atlas": { "cols": 4, "rows": 3, "order": "row-major, January top-left", "width": 2880, "height": 1080 },
  "pulse": "pulse/{year}.png", "years": [2000, 2026],
  "m_first": 10, "m_last": 322, "last_month_partial": true,
  "m_last_data": 312,                    // last month with any activity (timeline end)
  "default_switch_m": 276,
  "clim": { "file": "clim.png", "baseline": [2003, 2022], "stat": "median incl. zero months" },
  "land": { "file": "land.png", "width": 1440, "height": 720, "value": "…" },
  "season": { "file": "season.png", "baseline": [2003, 2022], "layers": 7, "cap": 1310.8, "share": 0.8,
              "bimodal": { "min_pooled_afcd_per_yr": 20, "ratio": 0.15, "dip": 0.5, "share_of_active_cells": 0.227 } },
  "trend": { "file": "trend.png", "layers": 5, "range_pct_per_yr": 10, "cap": …, "years": [2001, …, 2025],
             "years_modis_only": […], "switch_year": 2023, "min_baseline_afcd_per_yr": 10, "pooling": "…",
             "significance": "…", "share_valid_cells_sig": 0.289,
             "global": { "all_years": { "pct_per_yr", "p", "years", "n_years" }, "without_viirs_years": {…},
                         "modis_only_all_years": {…}, "annual_totals": { "2001": … }, "annual_totals_modis_only": {…},
                         "harmonized_over_modis_after_switch": { "2023": 1.015, … } },
             "vs_modis_only": { "cells", "sign_agreement", "slope_correlation" },
             "regions": [ { "code": "BONA", "name", "box": [w, s, e, n], "cell_mean_pct_per_yr", "sign",
                            "share_falling_sig", "share_rising_sig", "total_pct_per_yr", "total_p",
                            "total_pct_per_yr_modis_only", "baseline_afcd_per_yr", "vs_modis_only": {…} }, … ],
             "checks": [ { "name": "Sahel-Sudan savanna", "box", "expected_sign": -1 | 0 | 1, "source",
                           "total_pct_per_yr", "total_p", "total_pct_per_yr_without_viirs_years",
                           "total_pct_per_yr_modis_only" }, … ] },
  "global_monthly": [ … ]                // sum of x over all cells, one per month m_first..m_last
}
```
Version 3 adds `season` and `trend`; readers accept version 2 (without them). A year is complete for the trend when
every month's day coverage of the served stream (`days_modis` before the switch, `days_viirs` after, with the kernel's
fallback) is >= `complete_min_coverage` (0.9); before the 2026-11 review the rule was overpass coverage >= 0.5.
The watchlist (`data/dist/watch.json`) is described in `schema/watch.md`.
