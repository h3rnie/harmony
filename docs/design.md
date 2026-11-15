# Harmony — Harmonized MODIS + VIIRS Burning Activity Calendar

## Context
Entry for NASA Space Apps 2026 challenge "Harmonization of MODIS and VIIRS Hot Spots". MODIS
(2000→, ending ~2027, orbits drifting since 2021) and VIIRS 375 m (2012→; S-NPP data ended
2026-11-02, NOAA-20/21 continue) cannot be compared directly: VIIRS reports ~3–10× more hotspots,
varying by biome and day/night. Goal: one consistent 2000→present monthly burning-activity record
for any user-drawn area, so responders, scientists and land managers see seasonality, record
years and the current month vs the historical median — without caring which sensor detected it.
`D:\Projects\harmony` is empty (greenfield).

## Decisions
Hackathon entry, no fixed deadline · global coverage · local-first, built static so it can be
published later · **official NASA FIRMS sources only** · may install Rust/uv/DuckDB · user has
FIRMS MAP_KEY, Earthdata Login, cloud storage · AI/ML scope: calibration model, fire-season
outlook, Claude situation brief (Anthropic API key in `.env`), in-browser ML on WebGPU ·
`git init` + local commit per phase (no push).

## Approach (and what was rejected)
**Chosen: precomputed harmonized tile pyramid + all analysis client-side.** An offline pipeline
turns FIRMS files into small Parquet tiles; the browser fetches only tiles touching the area of
interest and computes everything locally. Static, cheap to host, instant interaction.
Rejected: (B) query backend (DuckDB/PostGIS server) — not static, needs always-on hosting;
(C) live FIRMS API per query — 5-day request windows make 26-year history infeasible.

Design calls: MODIS-equivalent units; lat-lon nested grid instead of H3;
Parquet tiles read with hyparquet instead of a custom format or DuckDB-WASM; Svelte 5;
Rust→WASM for the analysis kernel (TypeScript fallback if the Windows toolchain spike fails);
WebGPU confined to the stretch phase because MapLibre is WebGL2-only and deck.gl WebGPU is
experimental.

## Harmonization method ("AFCD-M": MODIS-equivalent active-fire cell-days)
1. **Filter**: MODIS confidence ≥ 30; VIIRS `n|h`; `type == 0`. Own static-source mask (fine
   cells dominated by type 1/2/3 or year-round persistent) applied to every row incl. NRT, which
   has no `type`. SP rows supersede NRT per (satellite, month). NRT months flagged *provisional*.
2. **Common support**: active-fire cell-day = distinct (0.0125° cell, local-solar date,
   day|night) with ≥ 1 detection; summed monthly into 0.05° serving cells (aligned to the MODIS
   CMG grid). Collapses VIIRS's many 375 m pixels per fire toward MODIS-like units.
3. **Streams**: `M` = Terra∪Aqua; `T` = Terra-only (bridge for 2000-11→2002-06); `V` = per-day
   mean over operating VIIRS satellites (never summed), NOAA-20/21 first scaled to S-NPP by
   per-stratum factors from their overlap years. Daily per-satellite availability table from
   global counts handles outages (Terra 2001, S-NPP 2022, 2026 gaps).
4. **Strata**: RESOLVE Ecoregions 2017 biome × realm, + cropland flag from MCD12C1 if readable
   (fallback chain stratum → biome → global).
5. **Calibration** (fit once on 2012–2021, pre-drift, then frozen): ratio model per stratum ×
   day|night × month-of-year (negative-binomial with `log V` as offset, i.e. multiplicative),
   plus per-cell empirical-Bayes gamma–Poisson shrinkage `k̂ = (ΣM + τ·k_s)/(ΣV + τ)`.
   Terra→Terra∪Aqua bridge fitted on 2003–2011. Log-log slope β reported as a diagnostic only.
6. **Final series**: scaled `T` → native `M` (2002-07→2022-12) → `k̂·V` (2023-01→). Switch year
   is a UI toggle. Provenance era is shown as a subtle marker, never as a different scale.
7. **Uncertainty**: AOI variance = Σ_s (Σ_{i∈s} V_i)²·Var(k_s) + Σ NB variance; interval width
   tuned to leave-one-year-out coverage by AOI size. 80 % / 95 % bands.
8. **Validation** (published in-app): leave-one-year-out 2012–2021 (r, log-RMSE, bias, slope,
   peak-month and anomaly-sign agreement by stratum/month); **out-of-time test 2023–2026**
   (scaled V vs still-observed M, with orbit-drift caveat); Pettitt step test at the switch;
   Aqua-only sensitivity fit.

## Data pipeline — `pipeline/` (Python 3.13 via uv, DuckDB 2.0)
| Stage | Module | Output |
|---|---|---|
| Fetch bulk | `fetch_country.py` | FIRMS country-year zips: MODIS 2000–25, S-NPP 2012–25, NOAA-20 2018–25 (~9.75 GB; unpack year-by-year, delete CSV after use) |
| Fetch recent | `fetch_api.py` | FIRMS area API with `FIRMS_MAP_KEY` (world, 5-day windows, rate-limited, resumable): 2026 for all sensors, NOAA-21 from 2024-01-17; SP where available else NRT |
| Normalize | `normalize.py`, `availability.py`, `static_mask.py` | cleaned points + flags, satellite-day availability, static mask |
| Cube | `afcd.py`, `strata.py` | monthly M/T/V per 0.05° cell × day\|night (Parquet) |
| Calibrate | `calibrate.py` | `coefficients.parquet`, `validation.json` |
| Tiles | `build_tiles.py` | pyramid: L0 0.05° in 2.5° tiles (raw streams + k̂, stratum); L1 0.25° in 10° tiles and L2 1° single file (baked harmonized H + ΣV per stratum for intervals); `index.json` |
| Points | `build_points.py` | hotspot archive partitioned by 10° tile × year, sorted, + JSON row-group index (for CSV export) |
| Overview | `overview.py` | global 0.25° grids: latest-month anomaly, climatology |
| Verify | `verify.py` | count reconciliation, known-event checks |

Tile contract frozen in `schema/tile-schema.json` before parallel work starts. All outputs under
`data/` (git-ignored); expected ≈ 350 MB tiles + ≈ 10 GB points; disk peak < 50 GB.

## Web app — `web/` (Vite 8, Svelte 5, TypeScript, static SPA)
- **Map**: MapLibre GL JS 6 + terra-draw (polygon, rectangle, circle), lat/lon + radius and bbox
  entry, GeoJSON upload, presets; cell overlay via canvas source; global anomaly overview.
- **Data**: `src/lib/data/tileReader.ts` — hyparquet range reads; picks the finest pyramid level
  under ~8 MB for the AOI; boundary cells area-weighted.
- **Kernel**: `crates/harmony-core` (Rust) → `crates/harmony-wasm` (wasm-bindgen, plain Web
  Worker, no COOP/COEP): polygon rasterisation, zonal sums, harmonization + intervals, median /
  MAD / percentile / robust z, Theil–Sen + Mann–Kendall, season start/peak/length, YTD envelope,
  outlook (seasonal cycle + AR(1) on log-anomaly, 1–3 months, hindcast skill vs climatology;
  shows climatology only if skill ≤ 0).
- **Views** (Observable Plot): KPI tiles (current month vs median: ratio, percentile, rank; YTD
  rank; peak month; trend) · **burning calendar** year × month with count / anomaly / percentile
  modes · seasonal curve with envelope · YTD cumulative vs envelope · annual totals + trend ·
  raw-vs-harmonized diagnostic with uncertainty band · outlook · method & validation page.
- **Accessibility**: cividis/viridis sequential and a colour-blind-safe diverging ramp, numbers
  in cells, data-table alternative, keyboard operable, light/dark, WCAG 2.2 AA checks.
- **Exports**: hotspot CSV for the search (hyparquet over the points archive, polygon-exact,
  includes sensor + harmonization flags), calendar CSV, chart PNG/SVG, FIRMS acknowledgement.
- **Situation brief**: dev-server route `server/brief.ts` sends only the computed stats JSON to
  Claude (`ANTHROPIC_API_KEY` from `.env`); rule-based template when no key.

## Build phases
- **P0 Setup + spikes** (parallel): `git init`, `.gitignore`, `.env.example`; install rustup +
  `wasm32-unknown-unknown` + wasm-bindgen-cli, uv, DuckDB. Spikes: uv/duckdb/statsmodels on
  Python 3.13 · DuckDB-written Parquet readable by hyparquet in browser · HTTP range on dev
  server · MapLibre 6 + terra-draw · RESOLVE rasterised to 0.05° · Rust host linker +
  wasm-bindgen hello-world · FIRMS API with real key (history depth, transaction cost, CORS).
  Freeze tile schema. *Exit: each spike green or its fallback adopted.*
- **P1 Regional data slice** (serial): per-country files for Argentina/Bolivia/Paraguay and
  Zambia/Angola through the full pipeline. *Exit: cell-day totals reconcile with raw counts.*
- **P2 Calibration v0** (serial after P1). *Exit: `validation.json` with LOYO + out-of-time.*
- **P3 Vertical slice** (parallel with P1–P2 on mock tiles, then joined). *Exit: draw a polygon
  → calendar + raw/harmonized band from real regional tiles.*
- **P4 Global + features**: full download and API backfill, global tiles/points/overview
  (serial); in parallel: stats + outlook, CSV export, brief, charts/accessibility, method page.
  *Exit: any AOI on Earth answers; continent-scale AOI loads < 8 MB.*
- **P5 Forefront stretch**: small MLP challenger calibration trained in the pipeline, exported
  to ONNX, run in-browser on onnxruntime-web WebGPU (WASM fallback) and compared with the
  baseline in a Method Lab panel; optional WebGPU global time animation.
- **P6 Publish** — only on an explicit go-ahead (data to object storage, app to a static host).

Each phase starts by expanding its tasks; this plan is saved as `docs/design.md` in P0.

## Prerequisites
`.env` in the project root with `FIRMS_MAP_KEY=` and `ANTHROPIC_API_KEY=` (not pasted in chat).
If the FIRMS API cannot backfill NOAA-21/2026, a one-off request through the FIRMS Archive
Download tool with your Earthdata Login (NOAA-20 alone still carries the record meanwhile).

## Known caveats to publish
Counts measure detections, not burned area; cloud and overpass sampling are not corrected;
country files are clipped to land borders while API pulls are global; VIIRS `type` labelling had
a known bug (mitigated by the static mask); 2023+ MODIS comparison is affected by orbit drift;
new fire areas with no MODIS history are shrunk toward their stratum.

## Verification
- Pipeline: `verify.py` — raw vs normalized row counts per sensor-year; SP/NRT overlap = 0;
  official per-country CSV totals match the archive for sample country-years; known events rank
  as top anomalies (Amazon Aug 2019, SE Australia Dec 2019–Jan 2020, Canada Jun 2023).
- Method: `validation.json` reviewed; no significant step at the switch; interval coverage
  near nominal.
- Kernel: `cargo test` on small fixtures (polygon mask, zonal sum equals brute force,
  Theil–Sen/percentiles against known values).
- App (browser automation): draw polygon / enter lat-lon → calendar renders; raw vs harmonized
  toggle; exported CSV row count equals a direct DuckDB query for the same AOI and dates; L0 vs
  L1 totals agree for a mid-size AOI; colour-blind simulation and keyboard pass; no console errors.

## Addendum 2026-11-15 — judging alignment 
Priorities: convincing demo, clear method story, wow-factor as a key objective, forefront tech,
presentation quality — with correctness, data freshness and maintainability still required.
Deliverable added: **7-slide presentation** (incl. title and intro slides), built last from real
screenshots and validation numbers.

| Criterion | What earns the score in this build |
|---|---|
| Impact | Any-area fire history in seconds for responders; current month vs median, YTD vs envelope, outlook, plain-language brief; small static tiles work on poor connections; open exports |
| Creativity | AFCD-M unit + frozen cross-calibration with published uncertainty; "seam" toggle that shows the 2012 VIIRS jump vanish; harmonization applied live in a Rust/WASM kernel; in-browser ML challenger on WebGPU; global fire-pulse animation |
| Validity | Leave-one-year-out + 2023–26 out-of-time test shown in-app; caveats published; count reconciliation against official FIRMS files; accessible, keyboard-operable UI |
| Relevance | Official NASA FIRMS (MODIS C6.1, VIIRS C2 S-NPP/NOAA-20/21) is the whole dataset; NASA MCD12C1 land cover for strata; "data through" freshness badge + daily FIRMS top-up command |
| Presentation | Story presets (Amazon 2019, SE Australia 2019–20, Canada 2023, Gran Chaco); method page; 7-slide deck |

Plan changes: P5 items (WebGPU global fire-pulse view, in-browser ML challenger) are committed,
not optional. New **P5b**: story presets, freshness badge + `harmony update` top-up, and the deck.
