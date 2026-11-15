# Operations

How to keep the record fresh, manage keys, switch the AI provider, rebuild the ML model and fix the usual problems. Commands were checked against the code (`pipeline/harmony_pipeline/cli.py`, `fetch_api.py`, `scripts/`); timings come from the global build of 2026-11-15. For what the stages compute see [METHOD.md](METHOD.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

All pipeline commands run from `pipeline/` and use `uv run python -m harmony_pipeline.cli ...`. Output goes to `data/` (git-ignored): `raw/` downloads, `work/` intermediate files, `dist/` what the app serves.

## Stages

`all` runs these in order (`cli.py`, `STAGES`); a stage skips its work when its outputs are newer than its inputs unless `--force`.

| Stage | Name on the command line | Writes |
| --- | --- | --- |
| 1 | `normalize` | `work/points/{sensor}/{year}.parquet`, `work/normalize_stats/` |
| 2 | `availability` | `work/availability.parquet`, `availability_monthly.parquet` |
| 3 | `static_mask` (aliases `static-mask`, `mask`) | `work/static_mask.parquet` |
| 4 | `screen` | `work/land_l0.npy` (cached land raster), `work/screen_water.parquet`, `work/screen_excluded.parquet`, `work/screen.json` (land rule for near-real-time rows and the burst screen; METHOD.md section 2) |
| 5 | `afcd` (alias `cube`) | `work/cube/`, `work/cube.parquet` |
| 6 | `strata` | `work/strata*.parquet` |
| 7 | `calibrate` | `work/coefficients/`, `dist/validation.json` (with `land_screen`, `bursts`, `modis_union_share`) |
| 8 | `harmonize` | `work/coefficients/harmonize.json`, adds the error-model, drift, conformal and fusion tables to `dist/validation.json` |
| 9 | `build_tiles` (alias `tiles`) | `dist/tiles/`, `dist/meta.json` |
| 10 | `build_points` (alias `points`; `points --years 2026` rebuilds only those UTC years) | `dist/points/` |
| 11 | `overview` | `dist/overview/` |
| 12 | `watch` | `dist/watch.json` |
| 13 | `verify` | `work/verify.json` |

Not part of `all`: `fetch-country`, `fetch-api` (downloads) and `ml` (the ML challenger). `watch --month YYYY-MM` analyses a past month and writes `work/watch/watch-YYYY-MM.json` instead of `dist/watch.json`.

## Table O1. Measured figures (as of the 2026-11-15 build)

Update from `data/work/refresh_run.log`, `data/work/global_run.log`, the logs in `data/work/logs/` (the fix rebuild: `fix_normalize.log`, `fix_all.log`) and file sizes after a refresh. Seconds are summed over years.

| Item | First full run (all years) | Refresh run (2026 and NOAA-21 added) | Fix rebuild (2026 re-normalized, then `all --from availability --force`) | Review rebuild (stages by name with `--force`; points for 2026 only) |
| --- | --- | --- | --- | --- |
| normalize | 4,933 s | 295 s (only changed sensor-years re-read) | 96 s (four product streams, 2026 only) | not re-run |
| availability / static_mask / afcd | 8 s / 111 s / 764 s | 3 s / 24 s / 217 s | 2 s / 25 s / 239 s | 3 s / not re-run / 218 s |
| screen | not in that run | not in that run | not in that run | 385 s (land raster 49 s, cached afterwards) |
| strata / calibrate | 268 s / 104 s | 45 s / 87 s | 119 s / 83 s | 46 s / 72 s |
| harmonize | not in that run | 29 s | 47 s | 24 s |
| tiles | 422 s | 69 s | 149 s | 56 s |
| points archive | 3,286 s | 1,701 s | 2,244 s | 34 s (`points --years 2026`) |
| overview / watch | 0 s / not in that run | 10 s / 2 s | 11 s / 2 s | 11 s / 2 s |
| verify | 137 s | 10 s | 16 s | 16 s |
| ML stage | 207 s | not re-run | not re-run | 229 s (new snapshot) |

| Item | Value |
| --- | --- |
| Raw downloads | 19.4 GB: country zips 9.8 GB (48 files), API CSVs 8.9 GB (498 files), RESOLVE 0.4 GB, per-country CSVs 0.4 GB |
| Normalized points (`work/points`) | 14.7 GB |
| Cube | 0.7 GB (`work/cube` and `work/cube.parquet`) |
| Output | tiles 0.58 GB, points archive 11.37 GB, overview 7 MB |
| FIRMS standard (SP) data available through, on 2026-11-15 | MODIS 2026-08-31; VIIRS S-NPP, NOAA-20, NOAA-21 2026-07-31 |
| FIRMS near-real-time data available through | MODIS, NOAA-20 and NOAA-21 2026-11-15; S-NPP 2026-11-02 (its last) |
| NOAA-21 near-real-time starts / standard starts | 2024-01-17 / 2023-03-01 |

The DuckDB connection is set to 12 threads and a 12 GB memory limit (`common.connect`); lower them on a smaller machine. Plan for 60 GB free in `data/`.

## Keeping the record fresh

### The top-up routine

Needs `FIRMS_MAP_KEY` ([keys](#key-management)).

```bash
cd pipeline
uv run python -m harmony_pipeline.cli fetch-api --dry-run   # print the windows that would be fetched
uv run python -m harmony_pipeline.cli fetch-api             # download them
uv run python -m harmony_pipeline.cli all                   # rebuild everything downstream
uv run python -m harmony_pipeline.cli ml --force            # optional; takes a new snapshot when the cube is newer
```

`fetch-api` options: `--sensors` (any of `modis viirs-snpp viirs-noaa20 viirs-noaa21`), `--from` and `--to` (dates), `--limit N` (testing), `--bbox w,s,e,n` (writes to `data/raw/api_bbox/`, which the pipeline does not read), `--dry-run`.

What `fetch-api` does:

- It asks FIRMS which dates each source covers (`data_availability`) and plans calendar months from 2026-01-01 (or 2023-03-01 for NOAA-21, and up to 2026-11-02 for S-NPP). For each month it uses the standard-quality (SP) source if SP covers the whole month, otherwise the near-real-time (NRT) source.
- It fetches in windows of at most 5 days, world coverage, into `data/raw/api/{SOURCE}/{start}_{days}.csv`. Existing valid files are skipped, except windows touching the last 3 days of a source's availability (NRT is still filling), which are fetched again. Interrupt and re-run at any time.
- A response is accepted only if its header starts with `latitude,`; an HTTP 200 can carry an error text.

What `all` does after a top-up: `normalize` re-reads only the sensor-years whose API files changed, then every later stage runs again, because each stage skips work only when its outputs are newer than its inputs and the new points make them all older. Expect about 40 minutes (Table O1, refresh run), most of it the points archive. To skip that stage and refresh only the tiles, overview and watchlist, run the stages by name in order, but note that the hotspot CSV export then lacks the new detections:

```bash
uv run python -m harmony_pipeline.cli normalize
uv run python -m harmony_pipeline.cli availability
uv run python -m harmony_pipeline.cli static_mask
uv run python -m harmony_pipeline.cli afcd
uv run python -m harmony_pipeline.cli strata
uv run python -m harmony_pipeline.cli calibrate
uv run python -m harmony_pipeline.cli harmonize
uv run python -m harmony_pipeline.cli tiles
uv run python -m harmony_pipeline.cli overview
uv run python -m harmony_pipeline.cli watch
uv run python -m harmony_pipeline.cli verify
```

`all --from <stage>` starts at a later stage; `--force` recomputes a stage even when it looks up to date; `normalize` accepts `--sensors` and `--years` to restrict what it re-reads. `calibrate` rewrites `validation.json`, so always run `harmonize` after it (it is in `all`), otherwise the file lacks the harmonization tables and `meta.json` lacks the error model.

After the run, check `data/work/verify.json` (`ok` true for every check), `data/dist/meta.json` (`data_through`, `generated`, the `provisional` array and the last values of `cov_modis` and `cov_viirs`) and `data/dist/watch.json` (`month`: the latest month with at least 0.9 day coverage, so the month in progress is skipped), and `data/work/screen.json` (`bursts.flagged`: near-real-time burst days that were excluded, with their counts; `bursts.standard_quality_top`: the highest standard-quality satellite-days, reported only). Two checks are worth doing by hand after a top-up that adds near-real-time data: that the newest months have VIIRS coverage (a month with `cov_viirs` near 0 means rows were dropped; see Troubleshooting) and that `normalize_stats/*.json` `nrt_superseded` is plausible for the sensor-years touched. The web app reads the new files directly; `Cache-Control: no-cache` is set for `/data` in the dev server, and a static host should do the same for `meta.json`, `watch.json` and the indexes.

The calibration is refitted at every rebuild on the fixed 2012-02 to 2021-12 window, and `harmonize` re-estimates the error model, the drift ratios and the conformal multipliers. New data does not enter the calibration fit, but the static mask and the availability table are recomputed over all data, so coefficients can move slightly between builds. Compare `data/dist/validation.json` before and after a refresh.

### What "provisional" means, and when a month becomes final

A month is flagged provisional (`meta.months.provisional`, and a marker in the app) if any NRT row remains in it after standard rows have replaced NRT rows. The month is the local-solar month, so a UTC date at the start of a month can flag the month before it for western longitudes (in the 2026-11-15 build July 2026 is flagged although its VIIRS rows are all standard; inferred from the month definition, not separately tested). The replacement rule is per satellite and UTC month: once FIRMS publishes standard data for a whole satellite-month, `fetch-api` fetches that month from the SP source on its next run and `normalize` drops the NRT rows for that satellite-month. A month is final when all its satellites are standard.

A row counts as standard only if its FIRMS `version` is purely numeric (`2`, `61.03`); any suffix (`NRT`, `URT` for the ultra-real-time first pass of the newest granules, `RT`) makes it NRT. A `URT` row is dropped when an `NRT` row of the same satellite has the same acquisition time (the reprocessed granule), and standard rows replace NRT rows only on days a standard input covers (`normalize_stats/*.json`, `supersession`, lists every satellite-month that lost rows and whether standard data cover the whole month). `verify` fails if a satellite-month loses more than 2 % of its rows without whole-month standard coverage, or if an NRT-type version is labelled standard.

Standard data lag the present by months (Table O1: on 2026-11-15, about 2.5 months for MODIS and 3.5 for VIIRS), so the latest three to four months stay provisional. Standard processing also adds the `type` field that NRT lacks; NRT rows get the static mask, the land rule (no NRT row in a 0.05° cell more than one cell from mapped land) and the burst screen instead (`screen.py`, METHOD.md section 2).

### At the turn of a year, and when a satellite or sensor ends

- When FIRMS publishes the bulk country files for a new year, run `fetch-country` (it downloads every file in the FIRMS index with the configured prefixes), then raise the last bulk year of each sensor in `config.SENSORS` (the fourth field; 2025 today). `normalize` reads bulk years from those ranges, and `fetch-api` starts at the year after. This is a code edit.
- S-NPP stopped on 2026-11-02 (`config.OPERATING`, and an end date in `fetch_api.END`). MODIS is expected to end around 2027: nothing needs to change at the end, because availability is detected from the daily counts (days with no data are marked unavailable), but then set the end date of Terra and Aqua in `config.OPERATING`. The kernel's fusion falls back to VIIRS when MODIS has no coverage, so after MODIS ends the record is VIIRS alone with the two-satellite error row; check the MODIS weight chart and the drift table in the app. NOAA-20 and NOAA-21 then carry the record.

### Regional runs

For tests and for fast iteration: `all --countries Argentina Bolivia Paraguay` runs only the named FIRMS countries (names as in FIRMS file names) and writes the run manifest `data/work/run.json`. Changing the country set rebuilds the points. Regional runs use the nominal operating period minus a list of known outages for availability, and write `validation.json` with `scope: regional`; the error-model, drift and conformal estimates are fitted on the cube of the run, so on a regional run they rest on the regional cells only. Run without `--countries` for the global record.

## Key management

| Variable | Used by | Where to get it |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | `fetch-api`; the live route `/api/live` | https://firms.modaps.eosdis.nasa.gov/api/map_key/ (free) |
| `ANTHROPIC_API_KEY` | AI routes, primary provider | Anthropic console |
| `OPENROUTER_API_KEY` | AI routes, optional second provider | https://openrouter.ai/keys |

- Put them in `.env.local` at the repository root (copy `.env.example`). `.gitignore` excludes `.env` and `.env.*` except `.env.example`, so keys are never committed. Do not paste keys into issues, logs or chat.
- The pipeline reads `FIRMS_MAP_KEY` from `.env.local`, then `.env`, then the environment. The Vite routes read keys from the same places on each request, so a replaced key should take effect without a restart (not tested).
- To rotate a key, make a new one at the provider, replace the line, and check the route status (below). The key is redacted from every log line and error the code produces; if a key leaks anyway, revoke it at the provider.
- Each key is used only server-side. The browser never receives one. The three routes refuse requests that the browser marks as cross-site (403), so a key cannot be spent from another website.

### FIRMS rate limits

A map key has a budget of 5,000 transactions per 10 minutes, and large requests cost more than one transaction (`fetch_api.py`). The pipeline checks `mapserver/mapkey_status` before every request, sleeps while usage is above 80 %, and backs off exponentially (30 seconds up to 10 minutes) on failures. The live route refuses new upstream work with 503 `busy` above 90 %, serves a cached copy if it has one, and limits itself to 12 upstream batches a minute. If the pipeline and the live view share a key, run the top-up when the app is idle, or use a second key. `GET /api/live/status` reports whether the route has a key (`available`) and how many upstream requests it has made.

## AI provider and profile

Set in `.env.local`; defaults apply when empty. Source: `web/server/ai/config.ts`, `.env.example`.

| Variable | Values | Effect |
| --- | --- | --- |
| `AI_PROVIDER` | `anthropic` (default), `openrouter` | Primary provider. Needs its key. |
| `AI_PROFILE` | `sonnet-high` (default), `opus-medium` | `sonnet-high` is `claude-sonnet-5-5` at high effort; `opus-medium` is `claude-opus-5-5` at medium effort. On OpenRouter these map to `anthropic/claude-sonnet-5.5` and `anthropic/claude-opus-5.5`. |
| `AI_MODEL` (alias `BRIEF_MODEL`) | a model id | Overrides the model for the primary provider; must match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}`. |
| `AI_FALLBACK`, `AI_FALLBACK_MODEL` | `openrouter` or `anthropic`; a model id | Used only after an outage, a 5xx or a 429 and one retry on the primary (a stream cut before its stop reason counts as transient); must be a different, configured provider. |
| `AI_CACHE_TTL` | `5m` (default), `1h` | Lifetime of the prompt-cache breakpoints. |
| `OPENROUTER_REFERER`, `OPENROUTER_BASE_URL` | URL | Optional; the second is a test hook for a mock server and is ignored in production. |

Check what the server resolved: `curl http://localhost:5173/api/brief` returns `available`, `ask`, `provider`, `model`, `profile` and `capReached`; effort, fallback and the token and cache counters go to the server log only (a `curl` call has no `Origin` header, so it passes the same-origin check; a call from a browser page on another site gets 403). With no key the answer is `available: false`; the app then shows the rule-based brief and hides Ask Harmony. Restart is not needed for an environment change, but the status call is the way to confirm it.

Tests: `node scripts/brief-smoke.mjs --offline` (no network, no spend; 118 checks on 2026-11-15) covers request shapes, retry, fallback, output validation and numeric grounding, truncated streams, rate limits and origin checks against mock providers. `node scripts/brief-smoke.mjs --url http://localhost:5196` (dev server started with `pnpm --dir web dev --port 5196 --strictPort`) makes real calls, a fraction of a cent each; `--real-openrouter` makes one real OpenRouter call if the key is set. The dossier carries a `unit` field (AFCD-M or AFCD-V), so the brief follows the units lens.

## Rebuilding the ML model

```bash
cd pipeline
uv run python -m harmony_pipeline.cli ml            # trains only if data/dist/ml/model.* is missing
uv run python -m harmony_pipeline.cli ml --force    # retrain (takes a new snapshot when data/work/cube.parquet or the coefficients are newer)
```

The stage is not part of `all`. It takes a one-off snapshot of the fit window and 2022-2025 from `data/work` into `data/work/ml/snap/` (because `data/work` is rewritten by later runs), trains on it, and writes `data/dist/ml/model.onnx`, `data/dist/ml/model.json` and `data/work/ml/{train_log.txt,metrics.json,run.log}`. It took 229 seconds in the review rebuild. The stage takes a new snapshot by itself when `data/work/cube.parquet` or the coefficients are newer than the old one (deleting `data/work/ml/snap` forces one), and records the build it trained on in `model.json` (`trained_on_build`). The snapshot end month is fixed in `ml_challenger.py` (2025-12). The feature list must match `web/src/lib/ml/features.ts`; the app refuses a model whose list differs. See [schema/ml.md](../schema/ml.md).

In the 2026-11-15 build the model was retrained on the final cube of the review rebuild (`trained_on_build.meta_generated` 2026-11-15T13:00:31Z), so Table M6 of the method and the Method lab model match the served record; its out-of-time production row agrees with `validation.json`.

## Web app and tests

```bash
bash scripts/build-wasm.sh          # after any change in crates/
pnpm --dir web dev                  # development, http://localhost:5173
pnpm --dir web build                # production bundle in web/dist
pnpm --dir web preview              # serves web/dist plus /data and the /api routes
pnpm --dir web check                # svelte-check and the Node type check
```

`/data` is served from `data/dist` (with range requests); `?mock=1` in the URL forces the demo mode.

| Command | Checks | Result on 2026-11-15 |
| --- | --- | --- |
| `cargo test -p harmony-core` (with `export PATH="$HOME/.cargo/bin:$PATH"`) | Kernel unit tests | 51 passed |
| `node scripts/kernel-smoke.mjs` | Built WASM kernel on synthetic tiles | passed |
| `node scripts/sound-test.mjs` | Sonification mapping and transcripts | 37 checks passed |
| `node scripts/live-smoke.mjs --unit` | Live proxy units, pace computation, origin checks | 63 checks passed |
| `node scripts/brief-smoke.mjs --offline` | AI routes against mock providers | 118 checks passed |
| `pnpm --dir web exec svelte-check --tsconfig ./tsconfig.app.json` | Type check | 334 files, 0 errors |
| `node scripts/hotspots-export-test.mjs` | CSV export against DuckDB (needs `data/dist/points`) | not run in this pass |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The app shows "demo mode" or a reason such as "No pipeline output found" or "Analysis kernel unavailable" | `data/dist` is missing (`/data/...` answers "data/dist not built yet"), or the WASM kernel is not built: run `bash scripts/build-wasm.sh`. |
| `uv` or a download fails with a certificate error behind a TLS-intercepting proxy | `uv`: set `UV_SYSTEM_CERTS=true` so it uses the OS certificate store. The fetchers call `curl`, which uses the system store on Windows. Node scripts and the dev server: set `NODE_USE_SYSTEM_CA=1` (the smoke scripts document this). DuckDB's `spatial` extension (used by `strata` and `overview`) is loaded with `LOAD spatial` and has to be installable on first use; if that is blocked, install it once on a network that allows it. |
| `cargo` fails to link on Windows with a missing `link.exe` | The Visual Studio (MSVC) linker is not installed. Use the GNU toolchain (`x86_64-pc-windows-gnu`, which is what the development machine uses) for `cargo test`. The `wasm32-unknown-unknown` build does not need a system linker. |
| `wasm-bindgen` reports a schema or version mismatch | The CLI must match the crate: 0.2.130 (`wasm-bindgen = "=0.2.130"`). Install it with `cargo install wasm-bindgen-cli --version 0.2.130`. |
| Worry about COOP/COEP headers or SharedArrayBuffer | Not needed. The kernel runs in a plain Web Worker and ONNX Runtime is single-threaded. |
| `fetch-api` prints `unexpected response: ...` and retries | FIRMS answered 200 with an error text, usually an invalid key or an exhausted budget; the run backs off and retries. "availability endpoint returned no rows (invalid key?)" means the key is wrong. |
| `fetch-country` prints `SIZE MISMATCH` | A download is incomplete; run it again, it resumes. |
| `normalize` stops with "zip is missing or incomplete; run fetch_country first" | The zip for that year is not complete; run `fetch-country`. |
| The newest month has little or no VIIRS (`cov_viirs` near 0 in `meta.json`), the availability table lists NOAA-20 or NOAA-21 as unavailable for the last days, or `verify` fails `quality_label` or `supersession_bounded` | FIRMS has introduced a version string the quality rule does not expect, or standard data cover only part of a month. Check `rows_read_by_version` and `supersession` in `normalize_stats/<sensor>_<year>.json`, and `select quality, version, count(*) from read_parquet('data/work/points/viirs-noaa20/2026.parquet') group by all`. A standard version must be purely numeric (`SP_VERSION_RE` in `normalize.py`). After a fix, `normalize --force --sensors ... --years ...` for the affected sensor-years and `all --from availability`. (The `URT` fault of the first 2026-11-15 build, which dropped all NOAA-20 and NOAA-21 NRT rows of 2026-11, is fixed.) |
| Months in 2026 look empty or fall back to MODIS | VIIRS API files for the year were not normalized yet; run `fetch-api` and then `all`. |
| `verify.json` reports `sort_violations` greater than zero for a points file | The archive is not in the documented order (1-degree block = floor(lat), floor(lon); UTC month; 0.05-degree cell; time; `build_points.py`), which weakens row-group pruning in the CSV export. Rebuild with `points --force`. (Before the fix rebuild of 2026-11-15 the check compared rows by 0.05-degree cell only and reported 1,055 false violations in the largest file.) |
| A step is slow or runs out of memory | Lower the thread and memory limits in `common.connect`; keep 60 GB free in `data/`. `data/work/tmp` is DuckDB's spill directory. |
| `live-smoke` or `brief-smoke` cannot connect | Start the dev server with `--strictPort` on the port you pass, and run the script from the repository root. |
| The live view says it is unavailable | No `FIRMS_MAP_KEY` on the server, or a static host without the route. `GET /api/live/status` shows `available`. |
| A route answers 403 `forbidden` | The browser marked the request cross-site or sent an `Origin` that is not the server's host. Call the route from the app's own origin, or without an `Origin` header (curl, server-to-server). |
