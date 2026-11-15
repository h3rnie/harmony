# Architecture

How the repository is laid out, how data gets from FIRMS files to pixels, and what a deployment needs. For the science see [METHOD.md](METHOD.md); for running things see [OPERATIONS.md](OPERATIONS.md). [design.md](design.md) is the original plan; where it differs from this file or from the code, the code is right (differences are listed at the end).

## Repository map

```
README.md                  entry point
Cargo.toml                 Rust workspace: crates/harmony-core, crates/harmony-wasm
crates/harmony-core/src/   analysis kernel, pure Rust, no I/O
  geom.rs                  polygon cleaning, spherical area, per-cell coverage weights, tile keys
  store.rs                 columnar store of the tile rows inside the area
  series.rs                monthly zonal sums, source per month, harmonized series, interval
  stats.rs                 baseline, climatology, calendar, annual, year to date, current, records, seam
  trend.rs  season.rs  outlook.rs  robust.rs  cells.rs  meta.rs  engine.rs
crates/harmony-wasm/src/   wasm-bindgen wrapper (Kernel class)
pipeline/                  Python 3.13 (uv), DuckDB; harmony_pipeline/*.py, one module per stage
schema/                    data-contract.md, validation.md, ml.md (frozen interfaces)
web/                       Vite 8 + Svelte 5 + TypeScript single-page app
  src/lib/session.svelte.ts    area -> tiles -> kernel -> analysis state machine
  src/lib/data/tileReader.ts   Parquet tiles over HTTP into typed arrays
  src/lib/kernel/              main-thread client, Web Worker, WASM bindings (pkg/ is generated)
  src/lib/live/  brief/  ml/  pulse/  export/  map/  brand/  components/
  server/liveCore.ts, livePlugin.ts   /api/live
  server/ai/                          /api/brief, /api/ask
scripts/                   build-wasm.sh and four smoke/test scripts (see README)
docs/                      this file, METHOD.md, OPERATIONS.md, design.md, brand/
data/                      git-ignored: raw/ (downloads), work/ (intermediate), dist/ (served)
```

Generated and git-ignored: `data/`, `target/`, `node_modules/`, `web/dist/`, `web/src/lib/kernel/pkg/`, `.env.local`.

## Data flow: FIRMS files to pixels

```mermaid
flowchart TD
  Z[FIRMS country-year zips<br/>MODIS, S-NPP, NOAA-20] --> N[normalize<br/>dedupe, SP over NRT, grid, local-solar date]
  A[FIRMS area API<br/>2026, NOAA-21] --> N
  N --> PT[(work/points/sensor/year.parquet)]
  PT --> AV[availability<br/>satellite-day and monthly coverage]
  PT --> SM[static_mask<br/>0.0125 deg sub-cells]
  PT --> CU[afcd cube<br/>cell x month x dn]
  AV --> CU
  SM --> CU
  R[RESOLVE Ecoregions 2017] --> ST[strata]
  CU --> ST
  CU --> CA[calibrate<br/>k, r, bridge, relvar, alpha, ci_scale<br/>validation.json]
  ST --> CA
  CA --> T[build_tiles<br/>L0 L1 L2 Parquet, meta.json]
  PT --> PO[build_points<br/>hotspot archive]
  T --> OV[overview<br/>PNG atlases]
  T --> V[verify]
  T --> D[(data/dist)]
  PO --> D
  OV --> D
  D -->|HTTP range| TR[tileReader.ts<br/>hyparquet]
  TR --> K[Web Worker<br/>WASM kernel]
  K --> UI[Svelte views]
  D --> PU[Pulse: PNG atlases to WebGPU]
  D --> ML[Method lab: ONNX]
```

1. **Normalize** (`normalize.py`) reads each sensor-year from its country zip and from API files, maps columns to one schema, drops duplicates, lets standard-quality rows replace near-real-time rows per satellite and UTC month, computes the sub-cell, the L0 cell, the local-solar date and the month index, and writes `work/points/{sensor}/{year}.parquet`. Per-file statistics go to `work/normalize_stats/`.
2. **Availability, static mask, cube** compute satellite-day availability, the mask, and the cell-day cube (`afcd.py`) one local-solar year at a time to bound memory.
3. **Strata and calibration** assign each fire-active cell a stratum and fit the coefficients (`strata.py`, `calibrate.py`), writing `work/coefficients/` and `dist/validation.json`.
4. **Tiles** (`build_tiles.py`) apply the coefficients to the cube, scale by 100, round to integers at L0 and sum upward, so L1 and L2 are exact sums of L0. `meta.json` carries the coefficients the kernel needs for intervals.
5. **Points, overview, verify** write the hotspot archive, the global PNG atlases and the reconciliation report. The ML model is a separate stage (`ml`).
6. **Browser.** The tile reader fetches the tiles for an area, the worker's kernel turns rows into the analysis, and Svelte renders it.

## The data contract in brief

Full text: [schema/data-contract.md](../schema/data-contract.md). Everything the app reads is under `data/dist/` and is served at `/data/` (base set by `VITE_DATA_BASE`).

| Path | Content |
| --- | --- |
| `meta.json` | Version, `data_through`, month bounds, levels, per-month coverage, provisional and VIIRS-satellite masks, 64 strata with `relvar`, `alpha`, `relvar_bridge` and `k`, `ci_scale`, method parameters, sources |
| `tiles/index.json` | `{ "L0": { "tx_ty": [bytes, rows] } ... }`; a tile missing from the index has no fire data |
| `tiles/L{0,1,2}/{tx}_{ty}.parquet` | Rows `(cell, stratum, m, dn)` with `meq`, `kv`, `kvsq`, `v`, `nmod`, `nvii`; integers x100; sorted by cell, stratum, month, dn |
| `points/{px}_{py}/{year}.parquet`, `points/index.json` | Raw accepted and rejected detections in 10-degree tiles, row groups of at most 50,000 rows, sorted so that statistics prune by area and date |
| `overview/` | 0.5-degree PNG atlases for the pulse (one per year), climatology, land mask, `meta.json` |
| `validation.json` | Calibration validation, shown in the app ([schema](../schema/validation.md)) |
| `ml/model.onnx`, `ml/model.json` | ML challenger ([schema](../schema/ml.md)) |

Grid: level `L` has cell size `c`; `cell = floor((lat+90)/c) * NX + floor((lon+180)/c)` with `NX = 360/c`; month index `m = (year-2000)*12 + month-1`, first data month 2000-11 (`m = 10`). Levels are additive.

Table A1 gives the size of the current build.

## Kernel API

The kernel (`harmony-core`) is stateful per area and has no I/O. `harmony-wasm` exposes it as the `Kernel` class; `web/src/lib/kernel/worker.ts` hosts it in a plain module Web Worker (no SharedArrayBuffer, so no COOP/COEP headers are needed) and handles requests strictly in arrival order; `client.ts` is the main-thread side. A trapped WASM instance is detected and the worker is replaced.

| Call | Purpose |
| --- | --- |
| `new Kernel(meta_json)` | Parse `meta.json` (only the fields the kernel needs) |
| `set_aoi(flat_coords, ring_offsets)` | Take polygon rings (lon/lat; first ring outer, others holes; even-odd rule); returns area, bbox, centroid |
| `tiles_for(level)` | Tile keys `tx_ty` that hold cells of the area at that level |
| `begin(level)` | Fix the working level, compute per-cell coverage weights, clear the store |
| `ingest_tile(cell, stratum, m, dn, meq, kv, kvsq, v, nmod, nvii)` | Add a tile's columns; keeps rows whose cell is in the area with its weight; returns the count kept |
| `analyze(options_json)` | `{switchM, baseline, dn, range}` returns the whole analysis as JSON: series with bands, calendar, climatology, annual, year to date, current month, trend, season, outlook, seam, records |
| `cell_layer(options_json)` | Per-cell values (or ratio to the cell's own baseline) for a month window, for the map overlay |

Coverage weights come from a scanline rasteriser: each cell row is cut by 16 horizontal sub-lines and the inside spans are clipped exactly to the cells, so interior cells weigh exactly 1 and boundary cells are exact horizontally and 16-fold supersampled vertically. Edges are straight lines in longitude and latitude, the space the grid lives in. Output shapes are mirrored in `web/src/lib/kernel/types.ts`. The Method lab, the hotspot export and the live pace run in the main thread or their own modules and do not go through the kernel.

## Choosing the level for an area

`session.svelte.ts`, `pickLevel`: levels are tried from finest (L0, 0.05 degree) to coarsest (L2, 1 degree). For each, the kernel lists the tiles the area touches and the sizes come from `tiles/index.json`. The first level whose tiles total at most `MAX_AOI_BYTES` (16 MiB, `config.ts`) is used. If none fits, the coarsest level is used anyway; the app does not refuse. Without an index (demo mode) the cell count is capped at 60,000 instead. Tiles are fetched four at a time, decoded by hyparquet into typed arrays, cached (up to 400 tiles) and passed to the kernel in order. A change of options (baseline, switch year, day or night, range) re-runs only `analyze`; a new area re-runs the whole chain, and a newer request aborts an older one.

Parquet reading (`tileReader.ts`): files up to 2 MiB are fetched whole in one request; larger files use HTTP range requests through hyparquet (footer, then column chunks). All ten columns are read, so range requests save bytes only by skipping row groups that are not needed.

## Server routes and their security model

Three routes exist because they need secrets. In development they are Vite plugins (`vite dev` and `vite preview`); their cores are written without Vite, Node HTTP or Svelte imports so that a serverless handler can call them with the environment passed in.

| Route | Purpose | Core |
| --- | --- | --- |
| `GET /api/live?bbox=w,s,e,n&days=N`, `GET /api/live/status` | FIRMS near-real-time proxy: NOAA-20, NOAA-21 and MODIS near-real-time rows for a box, as columnar JSON | `web/server/liveCore.ts` `getLive`, `liveStatus` |
| `GET /api/brief` (status), `POST /api/brief` | Structured situation brief for an area, streamed as NDJSON | `web/server/ai/core.ts` `getBrief`, `getStatus` |
| `POST /api/ask` | Follow-up questions on the same area, streamed | `getAnswer` |

**Keys stay on the server.** `FIRMS_MAP_KEY`, `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` are read on each request from `.env.local`, then `.env`, then the process environment, and only the variables a route needs are picked out. They are passed to the upstream call and nowhere else. Upstream-derived strings go through a redaction step that removes the key and any key-shaped URL segment before they are logged or returned; the unit tests check that a key never appears in a response. The AI adapter constructs the SDK client with the key and does not store it.

**Validation.**
- Live: unknown parameters, malformed numbers, boxes outside the world or crossing the antimeridian, and more than 7 days are rejected with 400. The box is snapped outward to 0.5 degrees and refused above 900 square degrees after snapping.
- AI: the body must be `application/json` (this forces a cross-origin preflight that the server never approves, so another website cannot make a visitor's browser spend the server's credits). Size is capped (the dossier at 16 KiB; Ask adds at most 8 turns of 500-character questions). The dossier is rebuilt field by field in a fixed key order from a known shape; unknown keys, non-finite numbers and out-of-range values are rejected; the area label is reduced to a name-like character set of at most 80 characters because it enters the prompt. The prompt tells the model to treat the label and the questions as data.
- Output: the brief is validated for structure and length and every figure in it must match the statistics sent (one corrective retry, then the rule-based brief is used); Ask answers stream and cannot be retracted, so ungrounded figures come back as a warning.

**Rate limits and caches** (per server process, in memory):

| | Live | Brief | Ask |
| --- | --- | --- | --- |
| Request limit | 12 upstream batches per minute (cache hits are free) | 10 per minute | 20 per minute |
| Cache | 48 boxes, 10 minutes (2 minutes if a source failed); expired entries kept up to 6 hours as a fallback | 200 responses, 1 hour | same cache |
| Other protection | Shares one upstream job between concurrent identical requests; checks the key's transaction usage and answers 503 `busy` above 90 % of the 10-minute budget | Retry once on transient errors, then optional fallback provider; no retry on 4xx or refusals | same |

The limits are global to a process, not per client, so one heavy client can use up the shared allowance for everyone; and because they are per instance, a serverless deployment multiplies them. A shared store would fix both (below).

## Performance

Numbers that exist in the repository's own test outputs, measured on the development machine (Windows 11, Node 26 for the script, Rust 1.100 for the tests). They are timings on synthetic data and do not include network or Parquet decoding.

| Measure | Value | Source |
| --- | --- | --- |
| Kernel unit tests | 28 pass in 0.76 s (debug build) | `cargo test --workspace` |
| Analysis of a small area (300 cells, 2025 record), WASM in Node | 4.8 ms, 27 KB of JSON | `scripts/kernel-smoke.mjs` |
| Large area: rasterise and list tiles | 7.2 ms for 167 tiles | same |
| Large area: ingest 2,114,000 rows | 48 ms | same |
| Large area: analysis of those rows | 10.8 ms | same |
| WASM binary | 256,626 bytes | `web/src/lib/kernel/pkg/` |
| Test guards | rasterising a 4,000-vertex polygon of about 40 x 35 degrees at 0.05 degrees, and analysing 2.1 million rows, each have a timing assertion | `geom.rs`, `engine.rs` tests |

Page weight is dominated by lazily loaded ONNX Runtime assets (two WASM files of 14.8 and 28.7 MB, fetched only when the Method lab opens); the main script is 1.7 MB (`web/dist/assets`). Tile sizes are in Table A1.

## Table A1. Data build size (as of the 2026-11-15 build)

Update from `data/dist/tiles/index.json`, `meta.json` and `du` after a refresh.

| Item | Value |
| --- | --- |
| L0 (0.05 degree, 2.5-degree tiles) | 3,724 tiles, 383.8 MB, 70,956,783 rows; largest tile 1.77 MB |
| L1 (0.25 degree, 10-degree tiles) | 410 tiles, 119.0 MB, 16,507,499 rows; largest tile 3.33 MB |
| L2 (1 degree) | 1 tile (one 360-degree tile in this build), 31.6 MB, 3,826,586 rows |
| Overview | 788 KB (27 yearly atlases, climatology, land mask) |
| ML model | 33,408 bytes ONNX, 42 KB of JSON |
| `meta.json`, `validation.json` | 58 KB, 44 KB |
| Hotspot archive | 7.5 GB written when measured; the points stage was still running |
| Normalized rows | 554,769,047 |
| Strata | 64 |

## What a production deployment needs

Nothing about the analysis needs a server. A deployment is:

1. **Static hosting for `web/dist`** (output of `pnpm --dir web build`).
2. **Object storage or a static host for `data/dist`** that supports HTTP `Range` requests and `Accept-Ranges`, serves `.parquet` with a binary content type and `.json` as JSON, and sends `Access-Control-Allow-Origin` if it is on another origin. Set `VITE_DATA_BASE` at build time to its URL. Tiles are immutable per release, so long cache lifetimes with a versioned path are safe; `meta.json` and the indexes should not be cached long.
3. **Up to three serverless functions** wrapping `getLive`/`liveStatus`, `getBrief`/`getStatus` and `getAnswer`, with the keys in the platform's secret store. They must be reachable at the same origin as the app: the live client uses the fixed path `/api/live`, and the AI client uses `/api/brief` and `/api/ask` unless `VITE_BRIEF_API` and `VITE_ASK_API` are set (`VITE_BRIEF_API=off` skips the probe for a site without AI). Without them the app still works; the live view and the AI features report themselves as unavailable.
4. **A shared cache and rate limiter** (a key-value store or the platform's edge rate limiting) in place of the in-memory maps, with per-client limits.

No COOP/COEP headers are needed. The data is rebuilt offline ([OPERATIONS.md](OPERATIONS.md)) and published as a new release of `data/dist`.

## Differences from design.md

- NOAA-21 enters from 2023-03 (standard-quality, via the API), not 2024-01-17; near-real-time NOAA-21 starts 2024-01-17.
- Strata are biome x realm only; the MCD12C1 cropland flag was not implemented.
- The per-AOI byte budget is 16 MiB, not 8 MB; L2 is configured as 30-degree tiles (the 2026-11-15 build predates that and holds a single tile; the reader takes tile size from `meta.json`).
- The calibration is a ratio of sums (the quasi-Poisson maximum-likelihood estimate), not a statsmodels negative-binomial fit; `statsmodels`, `scipy`, `pyarrow`, `httpx` and `python-dotenv` are declared in `pyproject.toml` but not imported by the pipeline code.
- There is no `harmony update` command and no `schema/tile-schema.json`; the top-up is `fetch-api` then `all`, and the schema is `schema/data-contract.md`.
- AI: a provider-agnostic layer (Anthropic primary, OpenRouter adapter), an Ask feature and a live view were added after the plan; the brief is not limited to one dev-server route.
- The overview atlases are built from the L1 tiles with `kv` only after the switch, whereas the kernel falls back to MODIS when VIIRS has no coverage. The two agree wherever both streams exist; they differ for months without VIIRS coverage, such as 2026 in the current build.
