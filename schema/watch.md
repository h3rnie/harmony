# Watchlist — `data/dist/watch.json` (v1)

"Where is fire unusual this month?" Written by `watch.py` (`uv run python -m harmony_pipeline.cli watch`, run after
`overview` in `all`) from `data/dist/meta.json` and the L1 tiles only. `watch --month YYYY-MM` analyses a past month
and writes `data/work/watch/watch-YYYY-MM.json` instead (same format; not served).

## Method

- Value: harmonized AFCD-M per 0.5 deg cell (L1 summed 2 x 2), the served stream of each month (MODIS `meq` before
  `default_switch_m`, calibrated VIIRS `kv` from it, with the kernel's fallback).
- Target: the latest month whose served-stream coverage is >= 0.5 (`windows.month`) and the three months ending
  there (`windows.three_months`, values summed).
- Baseline: the same calendar month(s) in 2003–2022, target year excluded, years with any month below 0.5 coverage
  excluded.
- A cell is a candidate when value >= 5 AFCD-M, empirical percentile among the baseline years >= 90 and value >=
  2 x max(baseline median, 1).
- Candidates form 8-connected clusters (longitude wraps at 180 deg), scored by excess = sum of (value - baseline median);
  the top 15 are listed. All cluster statistics use the cluster's own summed series for the window, over every
  covered year of the record (`record_years`).
- Clusters are chosen because their cells are unusual, so cluster ranks lean to the top; a fixed region can rank lower.

## Format

```jsonc
{
  "version": 1,
  "generated": "2026-11-15T09:30:00Z",
  "data_through": "2026-11-15",
  "month": "2026-10",                       // target month
  "unit": "harmonized AFCD-M …",
  "method": { "baseline": [2003, 2022], "coverage_min": 0.5, "cell_min_afcd": 5, "cell_min_percentile": 90,
              "cell_min_ratio": 2, "median_floor_afcd": 1, "clustering": "…", "score": "…", "top_n": 15, … },
  "caveat": "…",                            // show it with the list
  "windows": {
    "month":        { …window… },
    "three_months": { …window… }
  }
}
```

Window:

```jsonc
{
  "months": ["2026-08", "2026-10"],         // first, last month of the window
  "provisional": true,                       // any month near-real-time (meta.months.provisional)
  "coverage": [1.0, 1.0, 1.0],              // served-stream coverage per month
  "baseline_years": 20,
  "record_years": [2001, 2026],             // covered years compared for the rank
  "candidate_cells": 2026,
  "clusters_found": 611,
  "clusters": [ …cluster… ]                 // best first, at most 15
}
```

Cluster:

| field | meaning |
|---|---|
| `id` | `{month}-m{rank}` (one month) or `{month}-q{rank}` (three months) |
| `rank` | 1 = largest excess |
| `label` | broad region from a small built-in gazetteer of lat/lon boxes ("Central Siberia", "Southern Africa - miombo belt"); falls back to the GFED-style region name, then to coordinates |
| `centroid` | [lon, lat], activity-weighted |
| `bbox` | [west, south, east, north] of the cluster cells (west may be < -180 for clusters crossing the antimeridian) |
| `circle` | `{ lon, lat, km }`: centred on the centroid, enclosing every cell (radius to the farthest cell centre + half a cell diagonal) |
| `polygon` | closed lon/lat ring, convex hull of the cell corners (counter-clockwise) — hand it to the app as an area of interest |
| `cells`, `area_km2` | 0.5 deg cells and their area |
| `afcd` | cluster total in the target window |
| `normal_afcd` | median of the cluster total over the baseline years |
| `excess_afcd` | sum over cells of (value - cell baseline median), the ranking score |
| `ratio` | `afcd / max(normal_afcd, 1 x cells)`; `normal_near_zero` = true when that floor applied ("normally almost none") |
| `percentile` | empirical percentile of `afcd` among the baseline years (resolution ~5 % with 20 years: prefer the rank) |
| `baseline_years_exceeded` | number of baseline years with a smaller total |
| `record_rank`, `record_years` | rank of the target year among all covered years (1 = highest) |
| `record_max_year` | year with the highest total for this area and window |
| `biome` | dominant RESOLVE biome · realm stratum (by activity in the window), from the tiles' `stratum` |

## Caveats

Recent months are near-real-time: they may include persistent industrial or volcanic sources that the static-source
screen has not yet seen for long enough, and coverage-corrected partial data. Unusual is not the same as dangerous.
