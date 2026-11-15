# Operations

How to keep the record fresh, manage keys, switch the AI provider, rebuild the ML model and fix the usual problems. Commands were checked against the code (`pipeline/harmony_pipeline/cli.py`, `fetch_api.py`, `scripts/`); timings come from the global build of 2026-11-15. For what the stages compute see [METHOD.md](METHOD.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

All pipeline commands run from `pipeline/` and use `uv run python -m harmony_pipeline.cli ...`. Output goes to `data/` (git-ignored): `raw/` downloads, `work/` intermediate files, `dist/` what the app serves.

## Table O1. Measured figures (as of the 2026-11-15 build)

Update from `data/work/global_run.log` and `du` after a refresh.

| Item | Value |
| --- | --- |
| Time per stage, summed over years: normalize / availability / static_mask / afcd / strata / calibrate / tiles | 82 min / 0.1 min / 1.9 min / 12.7 min / 4.4 min / 1.7 min / 6.9 min |
| Points archive stage | 44.5 min for the years done when measured (2000-2023); the run was still going |
| ML stage | 207 s |
| Raw downloads: country zips (48 files) / API CSVs / RESOLVE | 9.1 GB / 6.3 GB / 0.4 GB |
| Normalized points (`work/points`) | 12 GB |
| Cube | 0.6 GB (`work/cube` and `work/cube.parquet`) |
| Output: tiles / points archive / overview | 0.52 GB / 7.5 GB or more (measured mid-run) / 0.8 MB |
| FIRMS standard (SP) data available through, on 2026-11-15 | MODIS 2026-08-31; VIIRS NOAA-20, NOAA-21, S-NPP 2026-07-31 |
| FIRMS near-real-time data available through | MODIS and NOAA-20 and NOAA-21 2026-11-15; S-NPP 2026-11-02 (its last) |
| NOAA-21 near-real-time starts / standard starts | 2024-01-17 / 2023-03-01 |

The DuckDB connection is set to 12 threads and a 12 GB memory limit (`common.connect`); lower them on a smaller machine.

## Keeping the record fresh

### The top-up routine

Needs `FIRMS_MAP_KEY` ([keys](#key-management)).

```bash
cd pipeline
uv run python -m harmony_pipeline.cli fetch-api --dry-run   # print the windows that would be fetched
uv run python -m harmony_pipeline.cli fetch-api             # download them
uv run python -m harmony_pipeline.cli all                   # rebuild everything downstream
```

`fetch-api` options: `--sensors` (any of `modis viirs-snpp viirs-noaa20 viirs-noaa21`), `--from` and `--to` (dates), `--limit N` (testing), `--bbox w,s,e,n` (writes to `data/raw/api_bbox/`, which the pipeline does not read), `--dry-run`.

What `fetch-api` does:

- It asks FIRMS which dates each source covers (`data_availability`) and plans calendar months from 2026-01-01 (or 2023-03-01 for NOAA-21, and up to 2026-11-02 for S-NPP). For each month it uses the standard-quality (SP) source if SP covers the whole month, otherwise the near-real-time (NRT) source.
- It fetches in windows of at most 5 days, world coverage, into `data/raw/api/{SOURCE}/{start}_{days}.csv`. Existing valid files are skipped, except windows touching the last 3 days of a source's availability (NRT is still filling), which are fetched again. Interrupt and re-run at any time.
- A response is accepted only if its header starts with `latitude,`; an HTTP 200 can carry an error text.

What `all` does after a top-up: `normalize` re-reads only the sensor-years whose API files changed, then every later stage runs again, because each stage skips work only when its outputs are newer than its inputs and the new points make them all older. Expect about an hour to an hour and a half, most of it the points archive. To skip that stage and refresh only the tiles and the overview, run the stages by name in order, but note that the hotspot CSV export then lacks the new detections:

```bash
uv run python -m harmony_pipeline.cli normalize
uv run python -m harmony_pipeline.cli availability
uv run python -m harmony_pipeline.cli static_mask
uv run python -m harmony_pipeline.cli afcd
uv run python -m harmony_pipeline.cli strata
uv run python -m harmony_pipeline.cli calibrate
uv run python -m harmony_pipeline.cli tiles
uv run python -m harmony_pipeline.cli overview
uv run python -m harmony_pipeline.cli verify
```

`all --from <stage>` starts at a later stage; `--force` recomputes a stage even when it looks up to date; `normalize` accepts `--sensors` and `--years` to restrict what it re-reads.

After the run, check `data/work/verify.json` (every check `ok`) and `data/dist/meta.json` (`data_through`, `generated`, the `provisional` array). The web app reads the new files directly; `Cache-Control: no-cache` is set for `/data` in the dev server, and a static host should do the same for `meta.json` and the indexes.

The calibration is refitted at every rebuild on the fixed 2012-02 to 2021-12 window. New data does not enter the fit, but the static mask and the availability table are recomputed over all data, so coefficients can move slightly between builds. Compare `data/dist/validation.json` before and after a refresh.

### What "provisional" means, and when a month becomes final

A month is flagged provisional (`meta.months.provisional`, and a marker in the app) if any NRT row remains in it after standard rows have replaced NRT rows. The replacement rule is per satellite and UTC month: once FIRMS publishes standard data for a satellite-month, `fetch-api` fetches that month from the SP source on its next run and `normalize` drops the NRT rows for that satellite-month. A month is final when all its satellites are standard.

Standard data lag the present by months (Table O1: on 2026-11-15, about 2.5 months for MODIS and 3.5 for VIIRS), so the latest three to four months stay provisional. Standard processing also adds the `type` field that NRT lacks; the static mask is the only static-source screen NRT rows get.

### At the turn of a year, and when a sensor ends

- When FIRMS publishes the bulk country files for a new year, run `fetch-country` (it downloads every file in the FIRMS index with the configured prefixes), then raise the last bulk year of each sensor in `config.SENSORS` (the fourth field; 2025 today). `normalize` reads bulk years from those ranges, and `fetch-api` starts at the year after. This is a code edit.
- S-NPP stopped on 2026-11-02 (`config.OPERATING`, and an end date in `fetch_api.END`). MODIS is expected to end around 2027: nothing needs to change at the end, because availability is detected from the daily counts (days with no data are marked unavailable), but then set the end date of Terra and Aqua in `config.OPERATING` and check that the app's default switch and the live view still make sense. NOAA-20 and NOAA-21 then carry the record.

### Regional runs

For tests and for fast iteration: `all --countries Argentina Bolivia Paraguay` runs only the named FIRMS countries (names as in FIRMS file names) and writes the run manifest `data/work/run.json`. Changing the country set rebuilds the points. Regional runs use the nominal operating period minus a list of known outages for availability, and write `validation.json` with `scope: regional`. Run without `--countries` for the global record.

## Key management

| Variable | Used by | Where to get it |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | `fetch-api`; the live route `/api/live` | https://firms.modaps.eosdis.nasa.gov/api/map_key/ (free) |
| `ANTHROPIC_API_KEY` | AI routes, primary provider | Anthropic console |
| `OPENROUTER_API_KEY` | AI routes, optional second provider | https://openrouter.ai/keys |

- Put them in `.env.local` at the repository root (copy `.env.example`). `.gitignore` excludes `.env` and `.env.*` except `.env.example`, so keys are never committed. Do not paste keys into issues, logs or chat.
- The pipeline reads `FIRMS_MAP_KEY` from `.env.local`, then `.env`, then the environment. The Vite routes read keys from the same places on each request, so a replaced key should take effect without a restart (not tested).
- To rotate a key, make a new one at the provider, replace the line, and check the route status (below). The key is redacted from every log line and error the code produces; if a key leaks anyway, revoke it at the provider.
- Each key is used only server-side. The browser never receives one.

### FIRMS rate limits

A map key has a budget of 5,000 transactions per 10 minutes, and large requests cost more than one transaction (`fetch_api.py`). The pipeline checks `mapserver/mapkey_status` before every request, sleeps while usage is above 80 %, and backs off exponentially (30 seconds up to 10 minutes) on failures. The live route refuses new upstream work with 503 `busy` above 90 %, serves a cached copy if it has one, and limits itself to 12 upstream batches a minute. If the pipeline and the live view share a key, run the top-up when the app is idle, or use a second key. `GET /api/live/status` reports whether the route has a key (`available`) and how many upstream requests it has made.

## AI provider and profile

Set in `.env.local`; defaults apply when empty. Source: `web/server/ai/config.ts`, `.env.example`.

| Variable | Values | Effect |
| --- | --- | --- |
| `AI_PROVIDER` | `anthropic` (default), `openrouter` | Primary provider. Needs its key. |
| `AI_PROFILE` | `sonnet-high` (default), `opus-medium` | `sonnet-high` is `claude-sonnet-5-5` at high effort; `opus-medium` is `claude-opus-5-5` at medium effort. On OpenRouter these map to `anthropic/claude-sonnet-5.5` and `anthropic/claude-opus-5.5`. |
| `AI_MODEL` (alias `BRIEF_MODEL`) | a model id | Overrides the model for the primary provider; must match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}`. |
| `AI_FALLBACK`, `AI_FALLBACK_MODEL` | `openrouter` or `anthropic`; a model id | Used only after an outage, a 5xx or a 429 and one retry on the primary; must be a different, configured provider. |
| `AI_CACHE_TTL` | `5m` (default), `1h` | Lifetime of the prompt-cache breakpoints. |
| `OPENROUTER_REFERER`, `OPENROUTER_BASE_URL` | URL | Optional; the second is a test hook for a mock server. |

Check what the server resolved: `curl http://localhost:5173/api/brief` returns provider, model, profile, effort, fallback, `available`, `ask`, a problem code if any, and token and cache counters. With no key the answer is `available: false`; the app then shows the rule-based brief and hides Ask Harmony. Restart is not needed for an environment change, but the status call is the way to confirm it.

Tests: `node scripts/brief-smoke.mjs --offline` (no network, no spend) checks request shapes, retry, fallback, output validation and rate limits against mock providers. `node scripts/brief-smoke.mjs --url http://localhost:5196` (dev server started with `pnpm --dir web dev --port 5196 --strictPort`) makes real calls, a fraction of a cent each; `--real-openrouter` makes one real OpenRouter call if the key is set.

## Rebuilding the ML model

```bash
cd pipeline
uv run python -m harmony_pipeline.cli ml            # trains only if data/dist/ml/model.* is missing
uv run python -m harmony_pipeline.cli ml --force    # retrain (reuses the snapshot in data/work/ml/snap if present)
```

The stage is not part of `all`. It takes a one-off snapshot of the fit window and 2022-2025 from `data/work` into `data/work/ml/snap/` (because `data/work` is rewritten by later runs), trains on it, and writes `data/dist/ml/model.onnx`, `data/dist/ml/model.json` and `data/work/ml/{train_log.txt,metrics.json,run.log}`. It took 207 seconds on the current build. After a recalibration, delete `data/work/ml/snap` first so that the snapshot picks up the new coefficients. The snapshot end month is fixed in `ml_challenger.py` (2025-12). The feature list must match `web/src/lib/ml/features.ts`; the app refuses a model whose list differs. See [schema/ml.md](../schema/ml.md).

## Web app

```bash
bash scripts/build-wasm.sh          # after any change in crates/
pnpm --dir web dev                  # development, http://localhost:5173
pnpm --dir web build                # production bundle in web/dist
pnpm --dir web preview              # serves web/dist plus /data and the /api routes
pnpm --dir web check                # type check
```

`/data` is served from `data/dist` (with range requests); `?mock=1` in the URL forces the demo mode.

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
| Months in 2026 look empty or fall back to MODIS | VIIRS API files for the year were not normalized yet; run `fetch-api` and then `all`. |
| A step is slow or runs out of memory | Lower the thread and memory limits in `common.connect`; keep 50 GB free in `data/`. `data/work/tmp` is DuckDB's spill directory. |
| `live-smoke` or `brief-smoke` cannot connect | Start the dev server with `--strictPort` on the port you pass, and run the script from the repository root. |
| The live view says it is unavailable | No `FIRMS_MAP_KEY` on the server, or a static host without the route. `GET /api/live/status` shows `available`. |
