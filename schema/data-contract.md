# Harmony data contract (v1) — frozen interface between pipeline, kernel and web app

Everything the web app reads lives under `data/dist/` and is served at `/data/`.

```
data/dist/
  meta.json
  validation.json
  tiles/index.json
  tiles/L0/{tx}_{ty}.parquet      0.05 deg cells, 2.5 deg tiles
  tiles/L1/{tx}_{ty}.parquet      0.25 deg cells, 10 deg tiles
  tiles/L2/0_0.parquet            1 deg cells, one global file
  points/index.json
  points/{px}_{py}/{year}.parquet raw hotspots, 10 deg tiles
  overview/…                      global 0.25 deg grids (see below)
```

## Grid
- Level L has cell size `c` deg and `NX = round(360/c)`, `NY = round(180/c)`.
  `ix = floor((lon + 180) / c)`, `iy = floor((lat + 90) / c)`, `cell = iy * NX + ix` (UINT32).
- Tile of size `t` deg: `tx = floor((lon + 180) / t)`, `ty = floor((lat + 90) / t)`, from the cell's SW corner.
- L0 c=0.05 t=2.5 · L1 c=0.25 t=10 · L2 c=1 t=360. Levels are exactly additive (L1 = sum of 5x5 L0 …).
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
    "cov_modis": [..], "cov_viirs": [..], // fraction of days with data (values already scaled by 1/cov)
    "provisional": [..],                  // 1 if the month contains NRT (no `type`) rows
    "viirs_sats": [..]                    // bitmask 1 S-NPP, 2 NOAA-20, 4 NOAA-21
  },
  "strata": [{ "id": 0, "biome": 7, "realm": "NT", "name": "Tropical & subtropical grasslands · Neotropic",
               "relvar": [day, night],          // Var(k)/k^2 of the VIIRS->MODIS factor (year jackknife)
               "alpha": [day, night],           // NB dispersion: var = mu + alpha mu^2 at L0 cell-month
               "relvar_bridge": [day, night],   // same for the Terra-only bridge
               "k": [[12 day], [12 night]] }],  // stratum factor by month-of-year (informational)
  "ci_scale": 1.0,                        // interval inflation tuned on leave-one-year-out coverage
  "method": { … parameters, thresholds, tau … },
  "sources": [{ "name": "FIRMS MODIS C6.1 (MCD14ML)", "years": "2000-2025", "quality": "standard" }, …]
}
```

## Interval formula (kernel)
For one month and AOI weights `w_i`, VIIRS-derived value `H = Σ w_i kv_i`:
`Var = ci_scale² · [ Σ_{s,dn} relvar_{s,dn} (Σ_{i∈s,dn} w_i kv_i)² + Σ_{s,dn} (Σ w_i kv_i + alpha_{s,dn} Σ w_i² kvsq_i) ]`;
`σ_log = sqrt(Var) / max(H, 0.5)`; bounds `H·exp(∓z σ_log)`, z = 1.2816 (80 %) and 1.96 (95 %).
Terra-bridged months use `relvar_bridge` with meq in place of kv (dispersion term omitted). Native MODIS months have no interval.

## Points archive (CSV export)
`points/{px}_{py}/{year}.parquet` with `px = floor((lon+180)/10)`, `py = floor((lat+90)/10)`; Parquet v1 ZSTD,
row groups <= 50 000 rows, sorted by (L0 cell, acq_time_utc) so row-group min/max on latitude/longitude prune well.

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
| used | BOOLEAN | passed the harmonization filters (confidence, type 0, not static-masked) |

`points/index.json`: `{ "px_py": { "2023": [bytes, rows], … }, … }`.

## Overview grids
`overview/meta.json` + little-endian Float32 rasters 1440 x 720 (row 0 = south), NaN = no data:
`clim_{01..12}.f32` median harmonized AFCD-M per 0.25 deg cell by month-of-year (baseline 2003–2022),
`latest.f32` harmonized value for the latest complete month, `latest_ratio.f32` latest / climatological median,
`annual_{yyyy}.f32` yearly totals; `monthly.u16` optional full stack for the global animation
(months m_first..m_last, Uint16 = round(10·sqrt(value)), 1440 x 720 each).
