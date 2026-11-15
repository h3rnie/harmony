# NASA Space Apps 2026 submission

The seven fields of the project submission form, as prepared for entry, with the sources behind every figure.

- **Challenge:** Harmonization of MODIS and VIIRS Hot Spots
- **Team:** Hernie (one member: Toh Yu Heng, Singapore)
- **Naming:** the form's Project Name is "Project Harmony". Everywhere else (the app, the deck, the repository) the product is "Harmony".
- **Figures:** from the 2026-11-15 global build, version `20261115T130031Z`.

| # | Field | Value |
|---|---|---|
| 1 | Project Name | Project Harmony |
| 2 | Project Summary | 193 words, below (limit 100 to 200) |
| 3 | Project Demo | <https://harmony.hernie.me/demo> (7 slides) |
| 4 | Project Link | <https://harmony.hernie.me> |
| 5 | Project Details | below |
| 6 | NASA data and resources | 13 entries, below |
| 7 | Other data, resources and tools | 26 entries, below |

## 1. Project Name

Project Harmony

## 2. Project Summary

NASA has been spotting fires from orbit since 2000, first with MODIS and, from 2012, with the sharper VIIRS. The trouble is, they don't count the same way. For the same fires, VIIRS reports four to thirteen times as many hotspots, depending on how many of its satellites are flying, so a chart that joins the two records makes the planet look as if it caught fire in 2012.

Harmony is a web app that fixes this. It counts the places burning each day rather than pixels, calibrates one sensor against the other over the years they flew together, and blends every working satellite by how reliable it has proved to be. The result: the sensors agree within 3% in every year from 2013 to 2024.

Draw an area, or type in coordinates, and in about a second you get a calendar of its burning since 2000, how this month compares with a typical one, and the hotspots as a CSV. Suomi NPP stopped sending data on 2 November 2026 and MODIS is close to retirement, so the people who watch fires for a living need this long record to carry on unbroken.

## 3. Project Demo

https://harmony.hernie.me/demo

Seven slides, hosted on the site so no login is needed. Arrow keys, clicking and swiping move between slides; "Notes" shows the speaker notes; printing from the browser gives a seven-page 16:9 PDF. The slide sources are in [deck/](deck/).

## 4. Project Link

https://harmony.hernie.me

Source code: https://github.com/h3rnie/harmony

## 5. Project Details

**What it does**

Open Harmony and pick a place: draw it on the map, type coordinates, or choose from a short list of regions burning unusually this month. The first thing you see is a sentence, such as "September 2020 was 1.4 times the normal." Below it is the burning calendar the challenge asks for, one row per year and one column per month. Then come the fire season, the long-term trend, past years that looked similar, and the last week's detections measured against the usual pace. The calendar and the hotspots behind any search download as CSV.

**How it works**

Everything starts from 658 million FIRMS detections from five satellites. Three ideas turn them into one record.

First, I stopped counting pixels. A 1.4 km square that had fire on a given day counts once, whether MODIS logged it as one hotspot or VIIRS as six. That alone closes most of the gap.

Second, what's left is calibrated on the ten years both sensors flew together (2012–2021), separately for each biome and region, for day and night, and for each month of the year.

Third, I don't switch from one sensor to the other on some chosen date. Each satellite's error is estimated from the data, and every month is a weighted blend of whichever satellites were flying, with a range around it. When a satellite retires, the record leans on the rest.

**Does it hold up?**

Raw, VIIRS reports 4 to 13 times as many hotspots as MODIS. Harmonized, the ratio stays between 0.98 and 1.03 in every year from 2013 to 2024. On years it was not fitted on, the record tracks MODIS with a correlation of 0.944. There is no detectable jump at the hand-over, where the raw counts jump more than twelvefold.

One result I didn't expect. VIIRS always passes at the same local time, so it works as a yardstick for MODIS itself. By 2025 Terra was crossing about 1.1 hours earlier than it used to, and its daytime detections were running 42% low. Harmony corrects for this before blending. If fires had genuinely moved to a different hour of the day it would look the same, and the app says so.

**Who it's for**

A duty officer who needs to know whether this week is unusual. A researcher who needs a 26-year series with honest error bars. A land manager who wants to know when a place burns and whether that is changing. And because the record doesn't depend on any one satellite, it keeps going on NOAA-20 and NOAA-21 after MODIS is gone.

**How I built it**

The data pipeline is Python and DuckDB. The analysis runs in your browser: a Rust kernel compiled to WebAssembly reads small Parquet tiles, which is why answers arrive in about a second and the site costs very little to host. The interface is Svelte and TypeScript, with MapLibre for the map, Observable Plot for charts and a WebGPU globe. The app is hosted on Vercel and the data on Cloudflare R2. A plain-language brief is written by Anthropic's Claude from the computed numbers only, with a rule-based version when no model is available. I used an AI coding assistant (Claude Code) during development. No special hardware: one desktop PC, and about three hours for a full data build.

**What's new here**

Calibrating one sensor against another by a ratio is standard practice. Three things go further, and I couldn't find them in the fire-count literature: blending weights worked out from the data itself, using VIIRS to measure MODIS's orbit drift by biome and time of day, and a calibrated range on every month of the calendar. You can also listen to a place's fire record as sound, see it as a clock of the year, or watch the whole planet on a globe.

**What I weighed**

Only official NASA FIRMS fire data goes in. I kept the unflattering results in view: the 80% ranges cover 76% of months on unseen years, blending beats either sensor alone but not a simple average, and detections are not burned area. For accessibility there are colour-blind-safe palettes, numbers printed in the cells, keyboard control, data tables and sound. API keys never leave the server.

## 6. NASA data and resources

1. NASA FIRMS (Fire Information for Resource Management System) – https://firms.modaps.eosdis.nasa.gov/
2. FIRMS, part of NASA EOSDIS (overview and acknowledgement) – https://earthdata.nasa.gov/firms
3. MODIS Collection 6.1 active fire, standard quality (MCD14ML), Terra and Aqua, from FIRMS country-year files – https://firms.modaps.eosdis.nasa.gov/country/
4. MODIS Collection 6.1 active fire, near-real-time (MCD14DL) – https://doi.org/10.5067/FIRMS/MODIS/MCD14DL.NRT.0061
5. VIIRS 375 m active fire, Suomi NPP (VNP14IMGTDL) – https://doi.org/10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002
6. VIIRS 375 m active fire, NOAA-20 (VJ114IMGTDL) – https://doi.org/10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002
7. VIIRS 375 m active fire, NOAA-21 (VJ214IMGTDL) – https://doi.org/10.5067/FIRMS/VIIRS/VJ214IMGT_NRT.002
8. FIRMS Area API (2026 data, NOAA-21, and the live "right now" view) – https://firms.modaps.eosdis.nasa.gov/api/area/
9. FIRMS Archive Download – https://firms.modaps.eosdis.nasa.gov/download/
10. FIRMS FAQ (attribute, confidence and type definitions) – https://www.earthdata.nasa.gov/data/tools/firms/faq
11. NASA Terra mission – https://terra.nasa.gov/
12. NASA Aqua mission – https://aqua.nasa.gov/
13. NASA/NOAA Suomi NPP mission – https://science.nasa.gov/mission/suomi-npp/

## 7. Other data, resources and tools

1. NOAA Joint Polar Satellite System (NOAA-20, NOAA-21; space agency partner) – https://www.nesdis.noaa.gov/our-satellites/currently-flying/joint-polar-satellite-system
2. RESOLVE Ecoregions 2017 (biome and region classes, land mask; CC-BY 4.0) – https://ecoregions.appspot.com/
3. OpenStreetMap contributors (basemap data) – https://www.openstreetmap.org/copyright
4. OpenMapTiles (basemap schema) – https://openmaptiles.org/
5. OpenFreeMap (basemap hosting) – https://openfreemap.org/
6. Crameri Scientific colour maps (romaO) – https://www.fabiocrameri.ch/colourmaps/
7. d3-scale-chromatic (inferno ramp) – https://d3js.org/d3-scale-chromatic
8. Python, with NumPy, pandas, SciPy, statsmodels, PyArrow and Shapely, managed by uv – https://docs.astral.sh/uv/
9. DuckDB – https://duckdb.org/
10. Rust – https://www.rust-lang.org/
11. wasm-bindgen – https://github.com/wasm-bindgen/wasm-bindgen
12. Svelte – https://svelte.dev/
13. Vite – https://vite.dev/
14. MapLibre GL JS – https://maplibre.org/
15. Terra Draw – https://terradraw.io/
16. Observable Plot – https://observablehq.com/plot/
17. hyparquet – https://github.com/hyparam/hyparquet
18. ONNX Runtime Web – https://onnxruntime.ai/
19. WebGPU – https://www.w3.org/TR/webgpu/
20. Fontsource (Barlow, Schibsted Grotesk, JetBrains Mono) – https://fontsource.org/
21. Vercel (app hosting) – https://vercel.com/
22. Cloudflare R2 (data hosting) – https://developers.cloudflare.com/r2/
23. Anthropic Claude API (situation brief) – https://www.anthropic.com/
24. OpenRouter (optional alternative model provider) – https://openrouter.ai/
25. Claude Code (AI coding assistance) – https://claude.com/claude-code
26. GitHub (source repository) – https://github.com/h3rnie/harmony

Every link in both lists was checked and resolved on 2026-11-15. Two that did not resolve were left out: the LANCE page at `earthdata.nasa.gov/data/tools/lance` and the DOI `10.5067/FIRMS/MODIS/MCD14ML`.

## Where each figure comes from

All values are read from `data/dist/validation.json`; the tables are in [METHOD.md](METHOD.md).

| Claim in the text | Value | Source |
|---|---|---|
| Detections used | 658,009,224 | README data table; `data/dist/points/index.json` |
| Raw VIIRS per MODIS hotspot | 3.8 (2012) to 12.9 (2025) | `ratio_by_year.count_ratio`, Table M1 |
| Harmonized ratio | 0.98 to 1.03, 2013–2024 | `ratio_by_year.harmonized_ratio`, Table M1 |
| Correlation on held-out years | 0.944 (1° cells, each year of 2012–2021 held out) | `loyo.cell1deg_month.overall.r_log1p`, Table M2 |
| Jump at the hand-over | raw ×12.6 (p < 0.0001); harmonized none (p = 0.15) | `pettitt`, Table M4 |
| Terra daytime detections by 2025 | 0.58 of expected, −42 % (95 % range −46 to −37) | `drift.table`, Table M8a |
| Terra overpass by 2025 | 1.1 hours earlier | `drift.overpass`, Table M8b |
| Coverage of the 80 % range | 76 % on 2022–2024, units of 5 or more cell-days | `conformal.out_of_time`, Table M9 |
| Blend against a simple average | log error 0.898 blended, 0.888 equal weights, 0.949 and 0.932 single sensors | `fusion.non_circular_terra_reference`, Table M10 |
| Gran Chaco, September 2020 | 1.4 times normal, fourth most active September | the app, story "Gran Chaco" |
| Full data build | about 2.9 hours on one desktop PC | README, "Rebuilding the data" |

## How the text answers the judging criteria

| Criterion | Where it is answered |
|---|---|
| Impact | Summary, third paragraph; Details, "Who it's for" |
| Creativity | Details, "What's new here" and the drift result in "Does it hold up?" |
| Validity | Details, "Does it hold up?" and "What I weighed"; the table above |
| Relevance | Summary, third paragraph (calendar, area or coordinates, CSV); Details, "What it does" |
| Presentation | The seven-slide deck at `/demo`, with speaker notes |

## Use of AI

Stated in the form, in Details ("How I built it") and in entries 23 to 25 of the second list: the in-app brief is written by Anthropic's Claude from computed statistics only, and an AI coding assistant (Claude Code) was used during development.
