# Method

How Harmony turns MODIS and VIIRS active-fire detections into one record, how that record is checked, and where it is weak. Written for a reader who knows fire remote sensing. The code is the reference: `pipeline/harmony_pipeline/` (parameters in `config.py`) and `crates/harmony-core/src/` (kernel). Measured numbers are in the section [Measured values](#measured-values-as-of-the-2026-11-15-build); the rest of the text refers to those tables by name, so a data refresh mostly changes that section. The exceptions are the overview-atlas and watchlist figures in section 19, which come from `data/dist/overview/meta.json` and `data/dist/watch.json` and are labelled there.

Contents: [1 Problem](#1-problem) · [2 Filters](#2-filters) · [3 Unit](#3-the-unit-afcd-m) · [4 Availability and coverage](#4-satellite-availability-and-coverage-correction) · [5 Static sources](#5-static-source-mask) · [6 Strata](#6-strata) · [7 Calibration](#7-calibration-model) · [8 Terra bridge](#8-terra-bridge) · [9 Error model](#9-sensor-error-model) · [10 Drift fingerprint](#10-modis-orbit-drift-fingerprint) · [11 Final series](#11-the-final-series-fusion-default-and-switch) · [12 Intervals](#12-uncertainty-conformal-intervals) · [13 Validation](#13-validation) · [14 ML challenger](#14-ml-challenger) · [15 Live pace](#15-live-now-versus-normal-pace) · [16 Outlook](#16-outlook) · [17 Analog years](#17-analog-years) · [18 Lens](#18-reference-sensor-lens) · [19 Statistics](#19-statistics-in-the-interface) · [20 Limits](#20-known-limitations-and-what-would-improve-it) · [21 New and standard](#21-what-is-new-here-and-what-is-standard) · [Measured values](#measured-values-as-of-the-2026-11-15-build) · [References](#references)

## 1. Problem

MODIS (Terra from 2000-11, Aqua from 2002-07; 1 km pixels) is ending, probably around 2027, and its orbits have drifted since about 2021. VIIRS 375 m (S-NPP from 2012-01, NOAA-20 from 2018, NOAA-21 from 2023-03) is its successor. VIIRS detects smaller and cooler fires and reports many more pixels, so a count of detections is not comparable across the two. Table M1 gives the measured ratio of VIIRS to MODIS detections by year. It is about 4 while only S-NPP flies, jumps to about 8 in 2018 when NOAA-20 joins (each satellite adds its own detections of the same fires), and to 12 or more in 2023 when NOAA-21 joins. A time series of raw counts therefore has three artificial steps, in 2012, 2018 and 2023, that are larger than most real year-to-year changes. Table M4 shows what a change-point test finds in the raw series at the sensor switch, and in the harmonized one.

The aim is a record whose unit means the same thing in 2003 and in 2025, so that "this month against the median of the same month" is a valid statement for any area. Where both sensors fly, the record does not pick one: it combines them with weights from an estimated error model (sections 9 and 11), corrects MODIS for its orbital drift (section 10), and gives every month an interval calibrated on held-out data (section 12).

## 2. Filters

Source: standard-quality FIRMS country-year files and the FIRMS area API (see [README](../README.md#nasa-data-used)). Defined in `normalize.py`, `static_mask.py`.

- MODIS: `confidence >= 30` (`MODIS_MIN_CONFIDENCE`).
- VIIRS: confidence `n` or `h` (nominal or high); `l` is dropped.
- `type == 0` (presumed vegetation fire) when `type` exists. Rows from the near-real-time API have no `type`.
- The static-source mask (section 5) is applied to every row, including near-real-time rows.
- Land rule for near-real-time rows (`screen.py`). Near-real-time rows have no `type`, so the offshore class (`type = 3`) that standard data remove cannot be removed by type. A row without `type` is not used if its 0.05° cell holds no mapped land and none of its eight neighbours does. Land is the RESOLVE Ecoregions 2017 layer (every polygon, rock and ice included) sampled at 0.0125° (sub-cell centres; a polygon smaller than the spacing marks its nearest sample). The one-cell buffer (0.05°, about 5.5 km at the equator) makes the test conservative at coasts: a detection within one cell of mapped land is kept. Islands smaller than about 1 km that the polygons omit count as water. Standard rows keep their own `type`.
- Burst screen (`screen.py`), for every satellite-day. *Suspect* detections are candidate detections (confidence ok, type 0 or absent, outside the static mask) in a water cell, or in a land cell with no candidate detection in any other calendar year ("historically fire-free") that no other satellite confirms (no detection by another satellite in the same 0.1° block within ±1 local-solar day; counted only on days when another satellite was available). The confirmation keeps real large fires on new ground out of the count: Siberia in 2019 and 2021 and Canada in 2023 have tens of thousands of fire-free detections a day, all seen by several satellites, whereas a false alarm is one satellite's granule. A satellite-day is a *burst* when `log(1 + suspect)` exceeds that satellite's median over all its days by more than 6 robust standard deviations (1.4826 MAD, at least 0.25) and it has at least 500 suspect detections. On a near-real-time burst day the suspect cells of that satellite and day are not used; standard-quality burst days are only reported (`validation.json` `bursts`). Table M5b gives the result.
- Quality comes from the FIRMS `version`. A row is standard (`sp`) only if its version is purely numeric (MODIS `6.03`, `6.2`, `61.03`; VIIRS `2`); every version with a letter suffix — `NRT` (`6.1NRT`, `2.0NRT`), `URT` (ultra-real-time, `2.1URT`, FIRMS's first pass of the newest granules) or `RT` — and a missing version count as near-real-time (`nrt`, provisional).
- Exact duplicates on (satellite, UTC time, latitude, longitude) are dropped. These arise where country files overlap at borders; the standard row is kept over a near-real-time one, and an `NRT` row over a `URT` one. A `URT` row is also dropped when the same satellite has `NRT` rows at the same acquisition time (the same granule, reprocessed). In the 2026-11-15 build the `URT` rows (1,612 NOAA-20 and 249 NOAA-21 rows of 2026-11-15) lie in granules after the last `NRT` granule and match no `NRT` row exactly or within 10 minutes and 0.005 degrees, so all are kept.
- Standard-quality rows replace near-real-time rows per (satellite, UTC month) only where standard data genuinely cover the month: every day of the month must be covered by a standard input (a bulk country file covers its whole year, an area-API file from an `_SP` source its date span) and the satellite must have standard rows in the month. If standard data covered only part of a month, near-real-time rows would be dropped on the covered days only. `fetch-api` pulls standard data for whole months only, so in practice a month is either all standard or all near-real-time for a satellite; `verify.py` fails if a satellite-month loses more than 2 % of its rows to supersession without whole-month standard coverage, or if any row with a near-real-time version is labelled standard.

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

A satellite-day is *available* if its global detection count exceeds 5 % of the centred 31-day rolling median of that satellite's daily counts (zero-filled within its operating period), and an input file covers the date. This finds outages and partial days without a hand-kept list. Table M5 lists the unavailable days it found; they include the Terra power anomaly of 2001, the Terra safe-hold of 2016 and the S-NPP safe mode of 2022. The count rule also flags the newest days when a feed is incomplete: in the 2026-11-15 build it marks Aqua unavailable on 2026-11-15, a partial last day. A regional run cannot use the count rule (quiet regions legitimately have zero counts) and uses the nominal operating period minus known outages instead.

Monthly coverage:

```
cov_terra = fraction of days Terra is available
cov_modis = cov_terra                       before 2002-07
          = (f_terra + f_aqua) / 2          from 2002-07   (overpass coverage, for the 0.5 rules)
cov_U     = 1 - (1 - f_aqua)(1 - t_dn) - (1 - f_terra)(1 - a_dn)   from 2002-07 (divides m_ta)
cov_viirs = fraction of days with >= 1 VIIRS satellite available
```

A stream is divided by its coverage, `x / cov`, when `cov >= 0.5`, with the factor capped at 2 (`COV_MIN`, `COV_MAX_CORR`). Below 0.5 the value is left uncorrected (and such months are excluded from the calibration fit); the coverage arrays in `meta.json` record the fraction, and the kernel falls back to the other stream only when a stream's coverage is exactly zero. A month with coverage between 0 and 0.5 is therefore shown uncorrected, which understates it. The published tiles keep this scaling. For a *partial* month (below the completeness rule below) the kernel divides it back out, with the same rule read from `meta.json` (`method.coverage_correction.min_cov` and `max_factor`, defaults 0.5 and 2, applied to `cov_viirs` and, as an approximation of `cov_U` that is exact when both MODIS satellites stop on the same day, to `cov_modis`), so the series, the calendar, the map cells, the exports and `inProgress` report what was detected in the days so far; the scaled value is kept as `inProgress.projected`, the full-month projection, and is only ever shown beside the count ("first 15 days so far: N (on pace for about P)"). The Global pulse atlases keep the scaled value, so the pulse reads an in-progress month out as a projection ("on pace for ... projected from the first 15 days"), never as a count.

**Union-aware MODIS coverage (2026-11 review).** The Terra∪Aqua stream `m_ta` is divided by `cov_U`, not by `(f_terra + f_aqua)/2`. A day without Aqua loses the union cell-days Terra does not see, `1 - t_dn`, not half of them; `t_dn` and `a_dn` are the shares of union cell-days seen by Terra and by Aqua, fitted per day|night over the 2003-2011 months in which both flew every day (`validation.json` `modis_union_share`). By day Terra sees about 30 % of the union and Aqua 73 %; at night the roles reverse (71 % and 31 %). The old formula therefore under-corrected Aqua outages (2022-04, 16 days without Aqua: about 14 % low by day) and over-corrected Terra outages (2022-10, 2016-02, 2003-12: about 7-12 % high by day). The 0.5 thresholds still use `cov_modis`.

**Completeness.** A month drives statistics only when the stream(s) serving it delivered data on at least 0.9 of its days (`config.COV_COMPLETE`, written to `meta.json` as `complete_min_coverage` and read from there by the kernel, the app and the watchlist). Day coverage is `days_modis` (days with Terra or Aqua available) and `days_viirs` (= `cov_viirs`); in fused mode the larger of the used streams. A month below it is *partial*: drawn and flagged, never used for a baseline, ratio, percentile, level, rank, total, YTD, record, analog, outlook origin, trend or the seam (section 19). An outage of one MODIS satellite while the other flies leaves the day coverage at 1, so such a month is coverage-corrected and complete; a Terra-only month with an outage, or the month in progress, is not.

The VIIRS stream is a per-day mean over the VIIRS satellites available on that day, never a sum. Each satellite's sub-cell-day carries weight `1 / n`, where `n` is the number of VIIRS satellites available that UTC date, and weight 0 on days the satellite is flagged unavailable. NOAA-20 and NOAA-21 are first scaled to S-NPP units by a factor `c20`, `c21` per stratum and day|night, estimated as `sum(S-NPP) / sum(NOAA-x)` over months where both satellites were available every day. A stratum factor is used only if it passes a guard; otherwise the biome factor is used if it passes the same guard, else the global one. The guard: both sums at least 200 cell-days (`K_MIN_SUM`); no single month supplying more than half of either sum (`NOAA_MAX_MONTH_SHARE`), so the factor describes the sensor pair rather than one month; and the factor between 0.5 and 2 (`NOAA_RANGE`; the three VIIRS instruments share one design and the global factors are about 0.95, so a stratum factor outside that range cannot be an instrument difference). The level used and the reason a stratum factor was rejected are in `validation.json` (`noaa_scale`). Without NOAA-21 overlap, `c21 = c20`. With these, the per-cell-month VIIRS value is

```
V = ws + c20 * w20 + c21 * w21        (all coverage-corrected by cov_viirs)
```

where `ws`, `w20`, `w21` are the weighted sub-cell-day sums per satellite. Because `V` is a mean over operating satellites, adding NOAA-20 in 2018 does not double it. Table M3 gives the NOAA-20 factors.

## 5. Static-source mask

Gas flares, industrial heat, kilns, volcanoes and similar sources are detected every day and would be counted as fire. `static_mask.py` masks a 0.0125° sub-cell, over all sensors and years, if

1. it has 5 or more detections labelled `type` 1, 2 or 3 (`MASK_TYPED_MIN`); or
2. type 1, 2 or 3 is more than half of its typed detections, with at least 3 typed; or
3. it is persistent: accepted VIIRS detections in at least 10 distinct months of a calendar year, in at least 3 different years.

The set is dilated by one sub-cell in all eight directions to absorb geolocation jitter. The `type` field is absent from near-real-time data, so the mask is the only static-source filter that near-real-time rows receive in the pipeline; they also get the land rule and the burst screen (section 2). The live view (section 15) does not apply it. Table M5 gives the size of the mask.

## 6. Strata

Code: `strata.py`. The calibration ratio differs by land cover (different fire sizes, temperatures, durations), so it is fitted per stratum: RESOLVE Ecoregions 2017 **biome x realm** (14 biomes x 8 realms), plus one "unclassified" stratum. A 0.05° cell takes the stratum of its centre; if the centre falls outside every ecoregion (coasts, lakes, rock and ice) it takes the nearest ecoregion within 0.25°, else "unclassified". Table M5 gives the counts.

The original plan also used a cropland flag from MODIS land cover (MCD12C1). It was not implemented; see section 20.

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

**Why this window.** It is the period in which MODIS and VIIRS both operate, before most of the MODIS orbital drift. It is not entirely before it: the overpass times had begun to move by 2021 (section 10). Refitting on 2012-2019 moves the V-weighted factor by +0.32 % globally and by up to 6 % at night in some biome groups (Table M11d); the window was kept, and the drift analysis uses 2012-2019 only. The coefficients are applied unchanged to every later month, so a drift in MODIS after 2021 shows up as a drift in the out-of-time check and is not absorbed into the calibration.

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

**Is the bridge era biased high? (2026-11 review.)** 2001 is the highest year of the MODIS record globally (bridged 4.49 million cell-days against a 2003-2011 mean of 3.96 and maximum of 4.19; 2002, half bridged, 4.37), and August 2001 is the highest August of 2001-2025, 15.4 % above the next (August 2002; 18.5 % before the coverage fix of section 4, which raised the Aqua-outage month August 2002). The excess is in Terra's own observations, not in the bridge: Terra's coverage-corrected cell-days are 1.12 times their 2003-2011 mean in 2001 (1.41 times in August), and 2002 is as high (1.14); the effective bridge factor in 2001 equals its 2003-2011 value within 1 % (2.99 against 2.90-3.05; August 3.09 against 3.11). Terra's 2001 detections do not differ from later years in confidence (share 30-49: 14.4 % against 14.8-15.1 %), fire type, FRP, detections per cell-day or product version, and the months before and after the 2001-06-15 power-supply anomaly (B-side and A-side electronics) are both high. The two coverage-scaled months are not the cause: June 2001 (Terra unavailable 2001-06-16 to 07-02, coverage 0.50, scaled x2) is still 0.77 times its normal and is now flagged partial (15 of 30 days, below the 0.9 completeness rule), July 2001 is scaled x1.07. Tested out of sample on 2002-07..12, when Aqua exists, the bridge reads 0.7 % high over the six months (monthly -3.6 % to +6.3 %, August +0.7 %); with the old coverage formula the same test read 2.4 % high, most of which was the under-corrected Aqua outage in the reference. Published products disagree on 2001: the GFED2 burned area (derived from Terra active fires) has its 2001-2004 maximum in 2001, while FireCCI51 has its minimum then; GFED4.1s carbon has 2001 low globally but highest of 2001-2011 for southern Africa and Australia, the regions that carry the excess here; and the decline of about 1.2-1.4 % a year in GFED5 and MCD64A1 alone implies 2001 about 7-9 % above the 2003-2011 mean, against 13 % here. Whether Terra's elevated early counts are real burning or an instrument effect cannot be resolved without a second sensor. Bridged months (2000-11 to 2002-06) should be read as Terra-only estimates scaled to Terra+Aqua, unbiased within a few percent where they can be tested, whose excess over later years cannot be cross-checked; the interface marks them with the bridge source code and should say so (suggested: "Terra-only estimate, scaled to Terra+Aqua; the early-2000s Terra record cannot be checked against a second sensor").

## 9. Sensor error model

Code: `harmonize.py` (stage `harmonize`, after `calibrate`). The record has up to three estimates of the same month: MODIS Terra∪Aqua (`meq`), the Terra-only bridge before Aqua, and calibrated VIIRS (`kv`). To combine them, and to put an interval on every month, each needs an error variance. The quantity they all estimate is called the *latent MODIS-equivalent activity* `mu` of a stratum, day|night and month: the Terra∪Aqua cell-days that MODIS would record on average for the fires that burned (the average over overpass timing, cloud and the detection lottery). MODIS itself is therefore a noisy measurement of `mu`, not the truth.

**Variance law.** For a stream `j` and a stratum × day|night group at level `mu`:

```
Var_j(mu) = rho_j * mu^2  +  phi_j * mu
```

`phi_j` is the dispersion of noise that is independent between cells (variance over mean; 1 = Poisson); it adds over cells, so an area gets `phi * S` with `S` the area's sum. `rho_j` is the relative variance of an error shared by the whole stratum in that month (a diurnal or cloud regime that shifts every cell the same way, a year-specific sensor ratio); it multiplies the square of the stratum sum, as `relvar` does in the legacy interval. Groups (stratum × day|night) are independent of each other.

**Streams.** Terra∪Aqua `U`, Terra `T` and Aqua `A` (each MODIS satellite's own cell-days), the production VIIRS stream (calibrated `kv`), and, for reporting, S-NPP, NOAA-20 and NOAA-21 alone. Each is coverage-corrected by its own satellite's monthly availability and rescaled to the Terra∪Aqua scale with a ratio per stratum × day|night × month of year over 2012-02 to 2019-12 (`T' = g_T T`, and so on). NOAA-21 is rescaled with the production chain (`c21` to S-NPP, then `k`), so it never enters a fit against MODIS.

**(a) Cell-level dispersion `phi` by triple collocation.** Triple collocation (TC; Stoffelen 1998; McColl et al. 2014; Gruber et al. 2016) estimates the error variances of three measurements of one signal from their covariances, provided the three errors are independent of each other and of the signal:

```
e_1 = C_11 - C_12 C_13 / C_23        (and cyclically for e_2, e_3)
```

Units are 1° cell × stratum × day|night × month. Values are put on the Anscombe square-root scale, `y = sqrt(X + 3/8 g)` (Anscombe 1948; `g` is the stream's rescaling factor, so the constant applies to its native counts), on which a Poisson count has variance `g/4` whatever its mean; hence `phi_j = 4 e_j`. TC is run on anomalies from each unit's month-of-year mean (seasonal cycle and persistent cell offsets removed), with covariances pooled within units so that the degrees of freedom lose one per unit × month of year. Zeros of active units are kept; unit × month-of-year cells whose mean level is below 1 cell-day are left out, because the square root does not stabilise a Poisson variance there. Triplets:

| Triplet | Months | Gives |
| --- | --- | --- |
| Terra, Aqua, S-NPP | 2012-02 to 2019-12 | `phi` of Terra and Aqua (rescaled) and of S-NPP |
| Terra, Aqua, production VIIRS (leave-one-year-out `kv`) | 2012-02 to 2017-12 (one satellite); 2018-2019 (two) | `phi_V` for one and two satellites |
| Terra, Aqua, production VIIRS | 2023-03 to 2025-12 | `phi_V` for three satellites (MODIS drift era) |
| Terra, Aqua, NOAA-20; Terra, Aqua, NOAA-21 | 2018-2019; 2023-03 to 2025-12 | reporting only |

Terra∪Aqua cannot be in a triplet with Terra or Aqua (it contains both). If each MODIS satellite samples the fires as an independent thinning of the same events with equal native dispersion, the union has that native dispersion and a rescaled single satellite has `g` times it, so `phi_U = (phi_T'/g_T + phi_A'/g_A)/2`; the two halves are reported separately as a check. The Terra-only bridge has the dispersion of rescaled Terra, `phi_B = phi_T'`.

**(b) Stratum-coherent error `rho`.** TC on the log of stratum × day|night × month sums (Terra, Aqua, leave-one-year-out VIIRS; 2012-02 to 2019-12; anomalies from the stratum's month-of-year mean). The TC error at that scale still contains the cell-level part `phi/S`, which is removed: `rho_j = max(0, e_j - phi_j mean(1/S_j))`. Terra∪Aqua takes `rho_U = (rho_T + rho_A)/4`: at stratum scale the union behaves like the mean of the two satellites (the variance of the log difference between the union and that mean is reported in Table M7). The bridge takes `rho_B = rho_T + relvar_bridge`. VIIRS takes one `rho_V` for any number of satellites, because an error common to the VIIRS satellites (same instrument design and algorithm, same early-afternoon overpass) does not average out when satellites are added. The kernel adds `relvar`, the year-jackknife variance of the calibration factor, as a floor that combining VIIRS satellites cannot remove.

**(c) Common mode.** Aqua and the three VIIRS satellites all cross the equator in the early afternoon, so they share the diurnal and cloud state of the month, and TC, which needs independent errors, counts their shared error as signal: it understates the Aqua and VIIRS errors and overstates Terra's. Three sensors cannot separate this. A second identification assumes instead that Terra and Aqua have equal stratum-coherent error (same instrument and algorithm) and leaves the Aqua-VIIRS error covariance `g` free. Solved on strata whose mean exceeds 500 cell-days, pooled per day|night, it gives an Aqua-VIIRS error correlation `kappa_AV = g / sqrt(e_A e_V)`. Terra∪Aqua carries about half of Aqua's share, so the kernel uses `kappa = kappa_AV / sqrt(2)`, clipped to [0, 0.9], as the correlation of the MODIS and VIIRS stratum-coherent errors (Table M7). A positive `kappa` widens the fused interval relative to independence.

**(d) Cross-check by a Poisson split.** In the one-satellite years, the variance of the square-root difference `sqrt(VIIRS) - sqrt(Terra∪Aqua)` (anomalies) is split between the two streams in proportion to their Poisson expectations, `1/4` and `k/4`, which assumes both have the same dispersion relative to Poisson. Table M7 sets this next to TC.

**Fallback.** Every estimate is made per stratum × day|night, else from pooled sufficient statistics per biome × day|night, else globally per day|night. A level is accepted when it has enough residual degrees of freedom (500 unit-months for cells, 48 months for strata), all three cross-covariances are positive and every error variance is above a quarter of its Poisson expectation (below that the estimate is not plausible and counts as failed). Table M7 gives the share of strata at each level.

**Assumptions and how they fail.**
- Independent errors within a triplet. Weakest for Aqua and VIIRS (shared overpass); handled by (c), which rests on its own assumption (equal Terra and Aqua error).
- Terra's differences include the real difference between morning and afternoon burning, and TC counts it as Terra error. The latent target is therefore closer to the afternoon view. This matters most for the bridge, which uses Terra alone.
- Poisson-like variance within a cell-month (variance proportional to the mean). Cell-days are bounded by the days in a month, so the busiest cells saturate; there the law overstates the variance. At very low activity the VIIRS-to-MODIS conversion is poorer than the law implies (section 13).
- The three-satellite VIIRS dispersion is estimated in 2023-2025, when Terra and Aqua drift. TC is insensitive to a change of scale, not to a change in error structure, so this row is the least certain.
- After S-NPP ended (2026-11-02) the VIIRS stream is NOAA-20 and NOAA-21, and the kernel uses the two-satellite row, which was estimated with S-NPP and NOAA-20.

## 10. MODIS orbit-drift fingerprint

Code: `harmonize.py`, `drift`. Terra and Aqua no longer hold their orbits: since about 2021 Terra crosses the equator earlier and Aqua later. Fires follow a strong diurnal cycle, so a moving overpass changes how many fires MODIS sees even if nothing on the ground changes. VIIRS keeps its overpass and serves as the fixed reference.

**Ratio.** For satellite `j` (Terra, Aqua, Terra∪Aqua) a reference ratio `k_ref[j, s, d, moy] = sum(obs_j) / sum(V)` is fitted on 2012-2019 only, before the drift (the production calibration window runs to 2021 and so already contains its start; Table M3 gives how much `k` moves when that window ends in 2019 instead). Then, for any year and for a biome, biome group, hemisphere or the globe, by day|night:

```
R_j = sum(obs_j) / sum(k_ref V)
```

Before the drift `R` should be 1. For 2012-2019, each year's ratio uses `k_ref` fitted without that year; this is the placebo test, and its spread is the year-to-year noise floor of `R`.

**Uncertainty.** A delete-a-group jackknife over 40 random groups of 5° blocks, refitting `k_ref` in every replicate, gives a sampling interval (t with 39 degrees of freedom). It reflects spatial sampling only; the placebo years show that `R` also varies by a few percent from year to year for reasons unrelated to drift, so the table also gives a total interval with the placebo variance added (Table M8).

**Overpass time.** From the detections themselves (`acq_time_utc` and longitude): the mean local solar time of detections per satellite × stratum × month × day|night (night shifted by 12 h so that it does not wrap at midnight; VIIRS sub-sampled 1 in 8 by sub-cell). Its shift from the same satellite's 2012-2019 mean for the same stratum × day|night × month of year measures the drift directly. Then `log R = beta * shift` is fitted through the origin over all years, per biome group × day|night × satellite. This uses the drift as a natural experiment on the diurnal sensitivity of detections: `beta` is the change in log detections per hour of overpass shift, and the table gives the share of the post-2020 variance of `log R` the shift explains.

**What cannot be separated.** `R` measures anything that changes MODIS relative to VIIRS: the drift, but also a real shift in the timing of burning (for example in when crop residue is burned), a change in the fire-size mix (MODIS misses small fires that VIIRS sees), or a change on the VIIRS side (NOAA-21 joining in 2023-03, S-NPP ageing). The overpass regression attributes the part that moves with the overpass; the rest is not attributed. 2026 is a partial year (complete months to October, near-real-time data from August (VIIRS) and September (MODIS)), so its ratio is also affected by the season mix and data quality.

**Use in the kernel.** The Terra∪Aqua ratio per biome × day|night × year from 2020 (`meta.json`, `drift`) corrects `meq` in fused mode: `meq / R`, with the MODIS variance increased by `sd^2 + (0.5 log R)^2`. Here `sd^2` is the jackknife plus placebo variance, and the second term treats half of the correction as uncertain attribution (drift or real change). The weight of MODIS therefore falls as the drift grows. A biome-year with less than 2,000 expected cell-days uses the global ratio. Because the reference is calibrated VIIRS, a drift-corrected MODIS value shares the VIIRS calibration error, and the kernel counts that as common error (section 11). The raw annual ratio is used rather than the overpass-time fit, so the correction also removes changes that are not drift; this is deliberate (VIIRS is the reference that carries the record forward) and is why the attribution term is there.

## 11. The final series: fusion (default) and switch

For month `t` and area weights `w_i` the kernel works per stratum × day|night group `g`, with `M_g = sum w_i meq_i`, `V_g = sum w_i kv_i` and the error model of section 9 (`meta.json`: `strata[].err`, `fusion.kappa`, `drift`).

**Fused mode (default).**
1. Streams. MODIS is used if it has coverage, VIIRS likewise; when one stream covers at least half the month and the other does not, the partial one is dropped. Before 2002-07 MODIS is the Terra bridge, with its own parameters.
2. Drift. From 2020, `M_g <- M_g / R` and `rho_M <- rho_M + sd^2 + (0.5 log R)^2` (section 10).
3. Variances at a common level `mu`: `Var_M(mu) = rho_M mu^2 + phi_M mu`, `Var_V(mu) = (rho_V + relvar) mu^2 + phi_V[n] mu` (`n` = number of VIIRS satellites that month), and covariance `C(mu) = kappa sqrt(rho_M0 rho_V0) mu^2`, plus `relvar mu^2` in drift-corrected months (subscript 0: before the drift and calibration terms), capped at 0.99 times the geometric mean of the two variances. Both variances are evaluated at the same `mu`, not at each stream's own value; with Poisson-like variances, weighting each value by its own variance would favour the lower one.
4. Weight and estimate, three fixed-point steps from `mu = (M_g + V_g)/2`:

```
w     = clamp( (Var_V - C) / (Var_M + Var_V - 2C), 0, 1 )      MODIS weight
mu    = w M_g + (1 - w) V_g
Var_g = w^2 Var_M + (1-w)^2 Var_V + 2 w (1-w) C
```

   The weight is computed from `Var/mu`, so at `mu = 0` it takes its limit `phi_V/(phi_M + phi_V)` (with `C = 0`). With one stream, `H_g` is that stream and `Var_g` its variance.
5. Area: `H = sum_g H_g`, `Var = sum_g Var_g`, MODIS weight `= sum_g w_g H_g / H`.

This is the generalised-least-squares combination of two unbiased estimates with given variances and covariance. It is best only if the error model is right, which section 13 tests; it is not claimed to be optimal. Against an independent reference its gain over a plain equal-weight average is not demonstrated (Table M10). In the MODIS-only era it returns MODIS (now with an interval); from 2012 it blends; in the drift era the MODIS weight falls; after MODIS ends it returns VIIRS. Combining satellite streams with weights from estimated error variances is standard in other fields: GFAS assimilates fire radiative power from several sensors (Kaiser et al. 2012), and ESA CCI soil moisture merges products with collocation-derived weights (Gruber et al. 2017).

**Switch mode** (`mode: "switch"`) is the previous behaviour: `meq` (no drift correction) before `switchM`, `kv` from it, each falling back to the other when it has no coverage, and the interval from that stream's own variance. `switchM` matters only in this mode.

The source code of a month (none, bridge, MODIS, VIIRS) still travels with the series; in fused mode it names the stream with the larger weight. The tile files are unchanged: everything above is computed in the browser from `meq`, `kv` and `meta.json`. The map's cell layer fuses each tile row the same way unless `seriesMode: "switch"` is passed. The overview atlases are still built with the switch rule, with no drift correction, and so are the trend map and the watchlist, which read the same grid (`overview.py`, `watch.py`).

## 12. Uncertainty: conformal intervals

The error model gives a variance for every month, but section 13 shows that taken at face value it is too narrow: its nominal 80 % interval covers a held-out reference about 60 % of the time at 1° scale. Instead of one inflation factor (the legacy `ci_scale`), the width is calibrated empirically by split conformal prediction (Vovk et al. 2005; Lei et al. 2018), separately by biome group and activity size (Mondrian bins).

**Scale.** Intervals are on a shifted log, `log(x + 0.5)`, so that a month with no fire can lie inside one:

```
sigma  = sqrt(Var) / (H + 0.5)
bounds = max(0, (H + 0.5) exp(-/+ q sigma) - 0.5)
```

**Scores.** For every unit-month in 2012-2021 the leave-one-year-out calibrated VIIRS prediction `P` (refitted without its year) is compared with observed Terra∪Aqua `O`: `score = |log((O + 0.5)/(P + 0.5))| / sigma_diff`, where `sigma_diff` is the error-model standard deviation of `P - O` (VIIRS variance plus MODIS variance minus twice the common mode), evaluated at `P` and summed over the groups in the unit. Units are 1° cells and 5° blocks, each split by biome group, and whole strata; scores of the three supports are pooled.

**Multipliers.** `q80`, `q95` = the `ceil((n+1)p)`-th smallest score in each bin of biome group × size class of `P` (below 5, 5-20, 20-100, 100-1000, and 1000 or more cell-days). A bin with fewer than 500 scores is merged with a neighbouring size class, a group with too few scores takes the global row, and a multiplier is capped at 8. With a correct Gaussian error model, `q80` would be 1.28 and `q95` 1.96. The kernel takes the size class from `H` and averages the multipliers of the groups present, weighted by each group's share of `H`.

**What the coverage means.** In the calibration years the 80 % and 95 % levels hold by construction in every bin. They are *empirical held-out coverage by biome group and size class*, not a guarantee: conformal coverage assumes exchangeable scores, and monthly fire data are autocorrelated and, after 2021, affected by drift. The interval is a statement about where Terra∪Aqua would be: its calibration target is the observed MODIS record of a held-out year, which includes MODIS's own noise. The same multipliers are applied to fused and MODIS-only months, whose coverage of the latent activity cannot be observed. The test that matters is out of time: the frozen calibration in 2022-2024, scored against observed MODIS (raw and drift-corrected), by size class, next to the legacy interval (Table M9).

**Zero and near-zero months (2026-11 review).** The variance law gives `Var(0) = 0`, so a month with no fire had a 0-0 interval, and in calibration a unit-month predicted at 0 with something observed had an infinite score. Both the kernel and the conformal scores now floor the variance at the level of the shifted-log offset: `Var <- max(Var, Var_floor)`, where `Var_floor` is the activity-weighted mean (record totals of `meq + kv` per stratum × day|night group of the area) of the groups' variance laws evaluated at `mu = 0.5` under the month's streams (Poisson, `Var = 0.5`, for an area with no activity at all). A zero month therefore has a lower bound 0 and an upper bound from the error model; the floor changes nothing above a few cell-days. The conformal multipliers were refitted with the floor (Table M9).

`ci_scale` and the legacy formula remain in `meta.json`; they are used only by a kernel that reads a `meta.json` without the harmonization fields.

## 13. Validation

The tests below are in `calibrate.py` and `harmonize.py` and stored in `data/dist/validation.json`, which the app reads and shows ([schema](../schema/validation.md)). Results: Tables M2 to M4 and M7 to M11.

**Leave-one-year-out (LOYO), 2012-2021.** For each year `y`, `k` and `r` are refitted on the other nine years (with the same `tau`) and used to predict `y` from VIIRS; the prediction is compared with observed MODIS. Scored at two scales: stratum x month (a unit is a whole stratum) and 1° cell x month. Metrics per unit-month where either value is positive: Pearson `r` and RMSE of `log1p`, percentage bias, slope of observed on predicted `log1p`, the share of unit-years whose peak month is matched exactly or within one month, and the share of unit-months whose anomaly (against the unit's own month-of-year mean over the LOYO years) has the same sign in prediction and observation.

`tau` itself is not refitted per fold: it is the value of {5, 10, 20, 50, infinity} that minimises these same leave-one-year-out 1° errors, so the scores reported here carry some selection optimism from that five-way choice (expected to be small with five candidates and close to a million cell-months, but not measured separately). Within every fold, `k` and the per-cell multiplier `r` are refitted without the held-out year, so they never see the year they predict.

**Naive baseline.** One global ratio `sum(M)/sum(V)` fitted leave-one-year-out, with no strata, season, day|night or cell multiplier, scored the same way. It is the right yardstick for what the structure of the model adds. Table M2 shows the result: the structure reduces log-RMSE clearly at both scales and improves peak timing, but it does not improve the sign of anomalies at stratum scale, where the global ratio is slightly better. The honest reading is that most of the anomaly information is in `V` itself and the calibration mainly corrects level and seasonality.

**Out-of-time, 2022 onward.** The frozen fit is applied after the fit window and compared with MODIS, which still operates, by year (Table M2). The bias grows in 2025-2026. Section 10 measures how much of it is MODIS drift: against drift-corrected MODIS the frozen calibration (and NOAA-21 alone, Table M11) stays within about 1 %. That correction is anchored on VIIRS, so this is a consistency check, not independent proof that the calibration did not move.

**Change-point test at the switch and at VIIRS start.** Pettitt's (1979) non-parametric test on the log monthly global total minus its month-of-year mean, in a 72-month window around the event, on the harmonized series (`meq` before the event, `kv` from it) and on two naive raw-count series, named by where they change from MODIS counts (`nmod`) to VIIRS counts (`nvii`): `naive_switch_2023` changes at the 2023-01 switch, `naive_viirs_from_2012` at the VIIRS start (2012-02; the same series as the app's raw "naive" curve). At the VIIRS start the two coincide; in the switch window `naive_switch_2023` is the seam a naive switch would create, while `naive_viirs_from_2012` is VIIRS counts throughout. A significant change at the event month means a seam. Table M4: the `naive_switch_2023` series has an overwhelmingly significant step (+2.53 in log units, a factor of 12.6, close to the count ratio of 11.7 to 12.9 in 2023-2025, Table M1); the harmonized (switch-rule) series has none at the 5 % level (p = 0.15). Its detected change month is 2025-02, two years after the switch, with a step of -0.12 (a decline), in the period when the MODIS drift is large (Table M8a); it is not significant and was not investigated further. The same tests on the fused record, and the drift-start window, are in Table M4b: there the switch-rule series reaches p = 0.021 around 2020-12 and the fused series p = 0.065, neither a sensor seam but neither a clean pass.

**Aqua-only sensitivity.** `k` is refitted against Aqua alone (without the cell multiplier) and the log anomalies of the stratum-month series are correlated with those of the production series. The anomaly series does not depend materially on which MODIS satellite is the reference (Table M2). Aqua's absolute level is about two thirds of Terra+Aqua, as expected from half the overpasses.

**Log-log slope diagnostic.** The ratio model is proportional (`M = kV`). The OLS slope of `log M` on `log V` at 1° cell-month, by biome, is below 1 in every biome (Table M2). This was first read as MODIS growing more slowly than VIIRS as fire density rises. That reading is not supported: the OLS fit keeps only cell-months with `M > 0` (at low `V` this selects the months in which MODIS happened to see something, which flattens the slope) and is attenuated by noise in `log V`. A Poisson fit of `M = a V^b` that keeps the zeros gives `b` of 1.0 to 1.2 (Table M11c): if anything the MODIS share rises with activity, as expected if MODIS misses mostly small fires.

**Fusion against an independent reference.** Scoring the fused record against MODIS would be circular, because MODIS is one of its inputs. The test therefore fuses Aqua (rescaled to the Terra∪Aqua scale, with leave-one-year-out factors) with leave-one-year-out calibrated VIIRS, using the Aqua and VIIRS error models, and scores every candidate against Terra (rescaled the same way), which none of them contains: Aqua alone (what the switch shows before 2023), VIIRS alone, the fusion, and an equal-weight mean as a contrast. 2012-2019, 1° cell-months and stratum-months, log1p RMSE. Terra's own noise adds the same floor to every candidate, and Aqua and VIIRS share the afternoon overpass, so neither is favoured against the other by the morning reference. The error-model parameters come from the same years (they are a few numbers per stratum from about a million cell-months; the calibration itself is leave-one-year-out). Table M10.

**MODIS weight by era and change points of the fused record.** The production fusion is run per 1° cell × stratum × day|night (as the kernel would for an area of that size) and per stratum for the globe; Table M10 gives the typical MODIS weight by era. Pettitt's test is repeated on the fused global series around the start of VIIRS, the start of the drift correction (2020-01) and the legacy switch (2023-01), next to the switch series and both naive series (Table M4b).

**NOAA-21 blind test.** NOAA-21 never enters a VIIRS-to-MODIS fit. Calibrated NOAA-21 alone (`c21` from its overlap with S-NPP, then the 2012-2021 `k`, no per-cell multiplier) is scored by year against MODIS (raw and drift-corrected) and against calibrated NOAA-20 and S-NPP (Table M11). The drift-corrected comparison is not independent: the drift factors use the VIIRS composite, which includes NOAA-21 from 2023-03.

**Closure.** In the GSICS sense (Chander et al. 2013): the NOAA-20 factor fitted directly against MODIS on 2018-2019 against the chain NOAA-20 → S-NPP (`c20`) → MODIS on the same months, per stratum × day|night × month of year, and both applied out of sample to 2020-2021 (Table M11).

**Activity dependence of the ratio.** Cell-days saturate in busy cells, and MODIS misses more of the small fires than VIIRS, so the ratio could depend on activity (Schroeder et al. 2008 show detection probability rising with fire size). A power law `M = a V^b` (`a` per stratum × day|night × month of year, `b` per biome group × day|night by Poisson deviance on a grid from 0.6 to 1.5) is compared with the proportional model, both without the per-cell multiplier, leave-one-year-out (Table M11). It is a diagnostic, not adopted (section 20).

**Robustness to the end of S-NPP.** S-NPP stopped on 2026-11-02. The VIIRS stream is a per-day mean over the satellites available each day, so later months are NOAA-20 and NOAA-21 only, scaled to S-NPP units by `c20` and `c21` (fitted on the overlap and frozen); the kernel takes the two-satellite error row from the satellite count in `months.viirs_sats`. The build of 2026-11-15 runs through this transition; its last month (2026-11) holds 15 of 30 days: VIIRS coverage 0.50 (NOAA-20 and NOAA-21 for 15 days, S-NPP for 2), MODIS 0.48. VIIRS reaches the 0.5 coverage-correction threshold, so the month is drawn from VIIRS (MODIS, below it, is dropped for that month), but it is below the 0.9 completeness rule, so it is flagged partial and in progress and enters no statistic; the app shows the VIIRS cell-days detected in those 15 days, with the coverage-corrected (x2) value only as the projection beside them (section 4). (Before the fix rebuild the near-real-time classification fault left VIIRS coverage at 0.10; Known issues.)

**Reconciliation.** `verify.py` checks that rows are conserved through the pipeline, that standard and near-real-time never overlap on a satellite-day, that every row's quality label matches its FIRMS version, that no satellite-month loses more than 2 % of its rows to supersession without whole-month standard coverage, that tile totals equal the count of accepted detections at every level, that levels add exactly, that the points archive holds every normalized row in the documented sort order (1-degree block, UTC month, 0.05-degree cell, time; checked on the largest, median and smallest file), that sampled official country files have the same row count as the zips, and prints the top anomaly months per realm. In the 2026-11-15 build every check is ok (`data/work/verify.json`).

## 14. ML challenger

Code: `ml_challenger.py`; schema [ml.md](../schema/ml.md). A cross-check on the production ratio method, not a replacement. It never feeds the served record.

- Form: `mu = v * exp(f(x))`, with `f` a 28-64-64-32-1 ReLU network (8,129 parameters), output clipped to [-8, 4]. The multiplicative form matches the production model, gives zero for zero VIIRS and sums sensibly over cells and months. With a Poisson loss the ratio method is the special case `f = log k[stratum, dn, moy]`, so any gain comes from the extra smooth inputs.
- Inputs: `log1p(v)`, detections per cell-day (a fire-size proxy), day|night, sine and cosine of month of year, latitude, biome and realm one-hot. All can be rebuilt in the browser from tile columns and `meta.json`.
- Loss and training: Poisson deviance on L0 cell-month-dn rows with `v > 0`; hand-written numpy forward and backward passes with Adam, 8 epochs, 4 million sampled rows, fixed seed; then one global mass-balance scalar so that the model also accounts for MODIS cell-days in cell-months without any VIIRS, which a row-level `v * exp(f)` cannot (the ratio of sums absorbs them).
- Protocol: fitted on 2012-02 to 2018-12 and scored on 2019-2021 (a fixed temporal split, not LOYO) against the naive ratio, the stratum ratio, the production ratio with cell multiplier, and the challenger with and without that multiplier. Out of time: fitted on the full window and applied to 2022-2025.
- Result (Table M6): on the held-out years the challenger lowers log-RMSE against the production method at both scales, with similar overall bias, but its worst biome bias is larger, and out of time it is no more stable than the ratio method. The ratio method stays in production because it is transparent, has per-stratum mass balance and cannot fail on unseen strata; the challenger is offered in the Method lab as a cross-check on the selected area, run on WebGPU where available and WASM otherwise, only at the finest tile level.
- Parity: the ONNX graph agrees with the training forward pass to about 1e-6 relative (`data/work/ml/run.log`).

## 15. Live now-versus-normal pace

Code: `web/src/lib/live/pace.ts`, `web/server/liveCore.ts`. Question: is the last week unusual for this area and month? It is a different, deliberately simpler computation than the monthly record, because near-real-time data are unscreened and there is no month to calibrate yet.

1. Rows: near-real-time detections from NOAA-20 and NOAA-21 inside the area polygon, confidence nominal or high, filtered by the day|night option. MODIS near-real-time rows are shown and counted but not used for the pace, because the recent record is calibrated VIIRS. S-NPP is not requested.
2. Cell-days: distinct (0.0125° sub-cell, local-solar date, day|night), per satellite.
3. Per local-solar day, the mean over the satellites that reported (never the sum). A satellite with no rows anywhere in the fetched box on a day when the other has 20 or more is treated as not reporting.
4. Conversion: `AFCD-M = VIIRS cell-days * k_eff(calendar month)`, with `k_eff = sum(kv) / sum(v)` over that calendar month in the area's own monthly series (fallback: all months; if neither exists, no conversion and the result is labelled raw VIIRS cell-days).
5. Normal daily pace: the climatological median of the calendar month divided by its number of days; the bands use the 10th, 25th, 75th and 90th percentiles and the maximum of the baseline. The level label is extreme above the maximum, well-above above the 90th percentile, above the 75th, below the 25th, well-below under the 10th, else normal.
6. Only complete local-solar days (inside the fetched window and more than 3 hours old) enter the pace; the current day is shown, not averaged.

Approximations. The normal pace spreads a monthly median evenly over the days of the month, so it ignores within-month shape. `k_eff` is an average over months and stratum mixtures in the area, not the per-stratum, per-cell calibration. Near-real-time rows have no static-source screening and lower quality than standard rows. The window is at most 7 days, and the box is snapped outward to 0.5°, so rows are filtered to the polygon in the browser. The result is a pace indicator, not a monthly value, and it is not mixed into the record.

## 16. Outlook

Code: `outlook.rs`. A 1 to 3 month look-ahead for the area, on the harmonized series. With `x = log1p(H)`, climatology `mu_k` the mean of `x` for calendar month `k` over the baseline years, and anomaly `a = x - mu_k`:

```
rho_h  = lag-h autocorrelation of the anomalies (h = 1..3), set to 0 unless it exceeds 1.96/sqrt(n), clipped to [0, 0.95]
x_hat  = mu_k + rho_h * a_latest
80 % band: x_hat plus the 10th and 90th percentiles of the in-sample residuals a(t+h) - rho_h * a(t)
skill  = 1 - MSE_model / MSE_climatology,   leave-one-year-out lead-1 hindcast on the log scale (mu and rho re-estimated without the target year)
```

If skill is 0 or below the outlook is the baseline climatology itself (median and 10th to 90th percentile range), and the interface says so. Skill is computed per area when it is drawn; no global skill figure is stored. It needs at least 24 anomaly pairs. The model is deliberately simple; it extends the seasonal cycle by the persistence of this year's departure and does not use weather, fuel or climate indices.

## 17. Analog years

Code: `analogs.rs`. For the year of the latest complete-enough month, the kernel compares its year to date (months 1 to `K`) with every complete earlier year of the selected series:

```
distance(y) = sqrt( mean_{k=1..K} ( log(1 + x_y,k) - log(1 + x_now,k) )^2 )
```

The three nearest years are returned with their distance, their rest-of-year total (months `K+1` to 12) as a ratio to the median rest-of-year total of all candidates, and the month in which their rest of year peaked. Two numbers say how much to trust them: the spread of the analogs' log ratios against the spread over all candidate years, and a leave-one-out hindcast skill (each candidate year predicted from its three nearest other years, `1 - SSE/SSE_median` on log ratios). Analogs are called informative only when the skill exceeds 0.1 and the analogs agree more than the years in general; otherwise the interface is told to treat them as anecdotes. With fewer than four candidates there are no analogs, and when the latest month is December there is no rest of year to describe.

## 18. Reference-sensor lens

Code: `series.rs`, `lens`. MODIS ends; the record will be carried by VIIRS. With `unit: "viirs"` every MODIS-equivalent value of month `m` (the selected series, its bounds, `modisEq`, `viirsCal`, the drift-corrected MODIS) is divided by the area's own conversion factor for that calendar month,

```
f_k = sum kv / sum v       over the area's months of calendar month k in the fit window (2012-02 to 2021-12)
```

(falling back to all fit-window months, then to all months with VIIRS, then to 1), so the whole record reads in uncalibrated VIIRS cell-days, the S-NPP-equivalent per-day mean. Raw counts and `viirsRaw` are untouched.

The lens changes units, not conclusions (2026-11 review). Every statistic that ranks, labels or describes the record is computed on the MODIS-equivalent series: season (window and peak month), percentiles, ratios to the median, robust z, ranks (calendar month, annual, YTD, records), levels, the sparse rule, analogs (choice, distance, rest-of-year ratios, skill), trend direction, p-value, tau and relative slope, the outlook method and skill, and the seam. Only quantities with a unit are taken from the lensed series: monthly values and intervals, calendar values, the climatology, annual totals, the YTD curves, the current value, its median and bounds, outlook levels, record values, analog rest-of-year totals, and the trend slope in cell-days a year (rescaled so its relative size is unchanged). Before the review every statistic was computed on the lensed series, so quantities that add different calendar months were re-weighted by season: under the night-only filter the Gran Chaco season read "August to January" in AFCD-M and "July to December" in AFCD-V. The kernel test `lens_invariance_night_only` checks all of these on a night-only series with a strongly seasonal factor. Intervals and their size classes are computed in MODIS units and then divided by `f_k`.

## 19. Statistics in the interface

Computed by the kernel on the harmonized monthly series of the area (`stats.rs`, `trend.rs`, `season.rs`). "Harmonized" is the selected series: fused by default, the switch series in switch mode, and in VIIRS units under the lens (section 18).

- **Complete months only.** Every statistic below uses months whose serving stream(s) delivered data on at least 0.9 of their days (section 4). A partial month is drawn and flagged (`Series.partial`, `Calendar.partial`) but never ranked or labelled; when it is the last month of the record the analysis carries `inProgress` ("November 2026: first 15 days so far"). A partial month's values are what was detected so far (the pipeline's coverage scaling is undone, section 4); `inProgress.projected` is the scaled full-month value, stated only as "on pace for about P". In the 2026-11-15 build this is 2026-11 (15 of 30 days), which before the review was scaled x2 and shown as the current month.
- **Baseline** for a calendar month: the harmonized values of that month in the chosen baseline years (default 2003-2022); months without coverage and partial months are left out and true zeros are kept. Quantiles use the type-7 definition.
- **Ratio, percentile, rank, robust z** of a month against its baseline: ratio to the median, percentile rank among the baseline values, rank among all years, and `(x - median) / max(1.4826 MAD, max(sqrt(median), 0.5))` (the floor, the Poisson standard deviation of a count of that size, keeps quiet months from producing huge scores). The ratio is reported only when the baseline median is at least 1 AFCD-M; below that a ratio of two small counts says nothing (a desert month read "56x normal").
- **Levels** need both rank and size (2026-11 review; before, the percentile alone, so a month at 1.1 times its median could read "well above normal" next to a 1.3-times month reading "near normal"):

| Level | Percentile | Ratio to median |
| --- | --- | --- |
| extreme | >= 97.5 | >= 2 |
| well above | >= 90 | >= 1.5 |
| above | >= 75 | >= 1.2 |
| well below | <= 10 | <= 1/1.5 |
| below | <= 25 | <= 1/1.2 |
| normal | otherwise | |
| undefined | no baseline, or baseline median below 1 AFCD-M | |

  Checked from the top; a month at the 99th percentile and 1.3 times its median is "above". The kernel sets no other level (calendar and cell layers carry ratios and percentiles, not labels).
- **Activity and sparse areas.** `activity.meanAnnual` is the mean annual harmonized activity over the baseline years (sum of the 12 calendar-month baseline means, AFCD-M, lens-independent). An area is *sparse* when (a) `meanAnnual` < 10 AFCD-M, or (b) fewer than 24 baseline months have any activity, or (c) the complete MODIS-only years (before 2012) average below 1 AFCD-M a year while the complete VIIRS years average below 20, so the ratio of the eras is undefined. In a sparse area the kernel returns no trend direction (`trend.direction = "none"`, `trend.suppressed = true`), no season (`season.defined = false`), no analogs, and the climatological outlook with skill 0. Example from the review: a 150 km circle in the Sahara at 10° E, 24° N has annual totals of 0 in 2000-2011 and 0.07-1.9 from 2012 (VIIRS sees small sources MODIS never saw); it read "risen about 8 % a year", "56x normal" and described a fire season, and is now sparse with undefined level.
- **Year to date** against the envelope of past years built from years with complete data through each month.
- **Trend.** Theil-Sen slope of the annual totals of complete years with Sen's 95 % interval, and the Mann-Kendall test for significance. Suppressed in sparse areas.
- **Season.** Peak month, the shortest circular window holding 80 % of the annual median profile, and a second peak if a local maximum above half the main peak lies more than two months away. `season.defined` is false in sparse areas and when the profile is empty.
- **Seam** (per area). Over months where both streams exist, the raw VIIRS-to-MODIS ratio, the harmonized ratio and their correlation.

### Global fire clock (pulse view)

The fire clock is standard pyrogeography (Giglio et al. 2006; Archibald et al. 2013), shown here on the harmonized
record rather than claimed as a finding. Per 0.5 deg cell (`overview.py`, `season.png`): the **mean** of each calendar
month over 2003-2022 (the median of clim.png is zero in every month for episodic regimes such as boreal forest, where a
cell burns in a few years only); colour = the calendar month with the largest mean (peak month, not the circular mean,
which falls between the two seasons of a bimodal regime); **concentration** = resultant length of the circular mean of
the 12 monthly values (0 = spread over the year, 1 = one month), drawn as lightness/paleness on a cyclic map built for
colour-vision deficiency rather than as a second hue; **season length** = the shortest run of consecutive months holding
80 % of the annual total. A **second season** is flagged where, on the 3 x 3-pooled cycle (>= 20 AFCD-M a year), another
local maximum >= 0.15 x the main peak lies >= 3 months away and the cycle dips to <= 0.5 x that second peak on both arcs
between them; such cells are hatched in the second season's colour. This flags 22.7 % of fire-active cells, close to
the ~25 % of fire-active land that Benali et al. (2017) found bimodal by fitting circular distributions. Colour map: Crameri's
cyclic **romaO** (Scientific colour maps, MIT licence), January at blue, July at ochre; on the light theme its OKLab
lightness is compressed to 0.36-0.68 so the pale end stays visible. Cells under ~1 AFCD-M a year fade out.

### Trend across the hand-over

Per 0.5 deg cell, Theil-Sen slope of the annual harmonized totals over the complete years of 2001-2025 (a year is complete
when every month's served-stream day coverage is >= 0.9, the completeness rule of section 4; in the 2026-11-15 build 2003-2025
qualify, because 2001-06 and 2002-03 are Terra-only months with outages; before the review rebuild the rule was coverage >= 0.5
and 2001-2025 qualified), computed on the 3 x 3
(1.5 deg) moving-window sums for robustness and expressed as % of the window's 2003-2022 mean per year; cells need a
window mean >= 10 AFCD-M a year and >= 8 years with fire. Significance: Mann-Kendall (tie- and continuity-corrected
normal approximation; serial correlation not modelled, and the 1.5 deg windows overlap, so neighbouring tests are
dependent) with a Benjamini-Hochberg false-discovery rate of 5 % across the 45,548 tested cells (Wilks 2016) — 25 % are
significant. The map draws significant cells solid and the rest muted and hatched. Because no published trend exists
for a spliced MODIS -> VIIRS active-fire *count* record, the same analysis is run on the MODIS-derived stream alone
(`meq`, which continues through 2025) as a seam test.

Regional summary (`overview/meta.json` -> `trend`, GFED-style basis regions as lat/lon boxes; "total" = Theil-Sen of
the region's annual total; build of 2026-11-15 after the review rebuild, 2003-2025, switch-rule grid without drift correction):

| Region | Total %/yr (p) | MODIS-only | Cell mean %/yr | Sig. falling / rising (area share) | vs MODIS-only: sign agreement, slope r |
|---|---|---|---|---|---|
| Boreal North America | +3.7 (0.09) | +3.9 | +0.4 | 0.02 / 0.02 | 0.93, 0.97 |
| Temperate North America | +0.8 (0.29) | +0.5 | +0.2 | 0.07 / 0.10 | 0.87, 0.95 |
| Central America | -0.7 (0.20) | -0.6 | -0.3 | 0.06 / 0.02 | 0.90, 0.95 |
| N. Hemisphere South America | -0.1 (0.87) | -0.2 | -0.6 | 0.10 / 0.01 | 0.86, 0.95 |
| S. Hemisphere South America | -1.7 (0.04) | -1.6 | -1.0 | 0.21 / 0.05 | 0.94, 0.97 |
| Europe | -4.0 (<0.001) | -3.8 | -1.9 | 0.28 / 0.04 | 0.94, 0.98 |
| Middle East and North Africa | +1.6 (0.08) | +1.2 | +1.1 | 0.06 / 0.17 | 0.88, 0.94 |
| N. Hemisphere Africa | -1.0 (<0.001) | -1.2 | +0.4 | 0.24 / 0.14 | 0.93, 0.98 |
| S. Hemisphere Africa | -0.0 (0.92) | -0.2 | -0.2 | 0.08 / 0.10 | 0.91, 0.96 |
| Boreal Asia | -1.5 (0.17) | -1.5 | -1.9 | 0.26 / 0.01 | 0.95, 1.00 |
| Central Asia | -1.6 (<0.001) | -1.6 | +0.0 | 0.24 / 0.21 | 0.96, 0.98 |
| Southeast Asia | -1.1 (0.05) | -1.1 | +0.4 | 0.25 / 0.23 | 0.96, 0.98 |
| Equatorial Asia | -4.0 (0.006) | -4.1 | -2.8 | 0.25 / 0.00 | 0.94, 0.96 |
| Australia and New Zealand | -0.3 (0.83) | -0.4 | -0.3 | 0.03 / 0.01 | 0.91, 0.94 |

Against the literature. The harmonized record reproduces the published *declines* in savanna, grassland and cropland
burning (Andela et al. 2017): Sahel-Sudan savanna -1.1 %/yr (p < 0.001), Kazakh steppe -6.9 %/yr (p < 0.001), and the
Northern-Hemisphere-Africa, Southern-Hemisphere-South-America and Central-Asia totals; the Cerrado (-2.0 %/yr, p = 0.10) and
the eastern-China cropland box (-1.5 %/yr, p = 0.10) fall but not significantly over 2003-2025 (the Cerrado was significant
over 2001-2025, p = 0.03). For the extratropical forest *increases* (Zheng et al. 2021; Jones et al. 2022, 2024) it agrees
in sign for boreal North America (+3.7 %/yr, p = 0.09; Canadian boreal box +6.0 %/yr, p = 0.04, largely carried by 2023),
East-Siberian taiga (+4.6 %/yr, p = 0.08) and the western US (+1.1 %/yr, n.s.), but **not** for the Boreal Asia box as a
whole (-1.5 %/yr, n.s.), which is dominated by the declining agricultural and steppe-margin burning of southern Siberia and
the Amur region (cf. the large 2003 and 2008 fire years) rather than by taiga. Active-fire cell-days measure fire
*occurrence*, not emissions or burned area, so a muted forest signal is expected where fewer but larger fires burn.
Punjab-Haryana, a known MODIS overpass-time / orbit-drift artefact zone, shows no trend (-0.8 %/yr, n.s.).

Seam test. A splice artefact would appear as a step in 2023: the worldwide trend is -1.02 %/yr over 2003-2025,
-1.17 %/yr over 2003-2022 (MODIS years only) and -1.07 %/yr for the MODIS-only stream over 2003-2025; the harmonized /
MODIS-only global annual ratio is 1.014 (2023), 1.000 (2024) and 1.07 (2025, the year the drifting Terra and Aqua
orbits weaken MODIS). Cell trends agree in sign with the MODIS-only trends over 93 % of the tested area (slope
correlation 0.98); the agreement is partly by construction, since 20 of the 23 years are identical.

### Watchlist ("where is fire unusual this month?")

`watch.py` (schema/watch.md): for the latest month whose served stream delivered data on >= 0.9 of its days (the
completeness rule of section 4, read from `meta.json` `complete_min_coverage`; 2026-10 in this build, because 2026-11 holds
15 of 30 days; before the review rebuild the rule was coverage >= 0.5, so the half-covered 2026-11, scaled x2, was the
target and 13 of 15 clusters read "highest of 27 Novembers"), and
for the three months ending there, each 0.5 deg cell is compared with the same calendar month(s) of the 2003-2022
baseline (target year excluded; years with an incomplete month left out of the baseline and the ranks). Cells with >= 5
AFCD-M, at or above the 90th baseline percentile and >= 2 x the
baseline median (median floored at 1) form 8-connected clusters (longitude wraps), scored by excess activity (sum of
value minus median). For the top 15, the cluster's *own* summed series gives the ratio to normal, the baseline
percentile (resolution ~5 % with 20 years) and the rank among all years of the record. Because clusters are selected
for being unusual, their ranks lean to the top by construction. The watchlist reads the same switch-rule grid as the
overview atlases (no drift correction) and its recent months are provisional.

Current list (`data/dist/watch.json`, written 2026-11-15, target month 2026-10, near-real-time data; record 2001-2026 for
October): for October the first clusters are New Guinea (15.7 x normal, highest of 26 Octobers), the central African
savanna on the CAR-South Sudan border (3.6 x, highest), Borneo (19.6 x, third highest; record 2006), the Amazon basin
(4.9 x, highest) and the Llanos of Colombia and Venezuela (4.3 x, highest); 6 of the 15 clusters are the highest of their
record. For August-October Central Siberia comes first (171 x normal, highest of 26, against a near-zero normal), then New
Guinea (10.4 x, highest) and the CAR-South Sudan savanna (4.4 x, highest). These are provisional,
near-real-time based and not checked against another source.

Historical checks (`watch --month`; files in `data/work/watch/`, written during the refresh before the final tile
build, so a rerun can move the figures slightly; their record ranks cover only the years up to the target year,
2001-2023 for June 2023): June 2023 puts British Columbia and Alberta (234 x normal) and Quebec and Labrador (177 x and
250 x in two clusters) first, each the highest on record; December 2019 puts south-east Australia first (196 x), and
January 2020 the same region (374 x); August 2019 is led by Central Siberia (58 x) and Yakutia (149 x), with the
arc-of-deforestation cluster only 14th at 4.4 x normal (third highest of 26 Augusts).

## 20. Known limitations and what would improve it

| Limitation | Effect | Improvement |
| --- | --- | --- |
| Fusion weights not optimal at every scale | Against an independent reference (Terra) the fused record beats both single streams at 1° and for active strata, but an equal-weight mean does about as well (the gain over a plain average is not demonstrated), and at stratum scale for small strata Aqua alone is better (Table M10). The error model understates the VIIRS conversion error at low activity. | An additive low-activity variance term, estimated by collocation on low-activity units. |
| No cropland stratum | Agricultural burning (short, small, often at fixed overpass hours) is pooled with the biome. The cell multiplier absorbs part of it. | Add a cropland flag from a land-cover product (MODIS MCD12C1 was planned) as a third stratum dimension. |
| Interval width calibrated empirically | The error model (section 9) understates the error; conformal multipliers (section 12) correct the width per biome group and size class, but their coverage is empirical and slips by 3-9 points out of time (Table M9). Areas whose activity is spread over many biome groups take a weighted multiplier that was not calibrated as such. | Model the between-year variance of `k` per stratum directly (a random year effect) and validate on area sums. |
| Proportional VIIRS-to-MODIS ratio | A power law with `b` of 1.0-1.2 predicts better than the proportional ratio when neither has the per-cell multiplier (Table M11c); a power of `V` is not additive over cells, so it cannot be applied to L0 rows and summed. Its gain on top of the multiplier is untested. | Fit `b` at L0 jointly with the cell multiplier and test it leave-one-year-out; adopt only if it helps there. |
| MODIS drift and ending | Drift is measured and corrected against VIIRS (section 10), so in the drift era MODIS adds little that is independent of VIIRS at biome-year scale; real changes in the timing of burning are removed with the drift. The VIIRS error rows for three satellites are estimated in the drift era. | An independent reference with a fixed overpass (e.g. geostationary fire products over the Americas, Africa and Australia) to separate drift from real change. |
| Where MODIS saw nothing and VIIRS sees a little | VIIRS 375 m detects small and cool sources (flares, small agricultural fires, hot surfaces) that MODIS never recorded. Calibrated to MODIS-equivalent units they still appear from 2012 as a small positive record after a run of zeros, so a trend across the hand-over in such an area measures the change of sensor, not of fire. The record cannot show a real trend there; the kernel flags these areas as sparse (section 19) and suppresses trend, season, analogs and outlook. | A detection-limit model: the probability that MODIS would have seen a VIIRS detection of given FRP and size, to estimate a MODIS-era equivalent of small fires. |
| Terra-only bridge era | 2001-2002 are high in Terra's own counts (section 8); the bridge itself reads a few percent high out of sample. 2001-06 and 2002-03 are partial (Terra outages) and excluded from statistics, so 2001 and 2002 are incomplete years. | A second early sensor (e.g. the TRMM VIRS fire product for the tropics) to cross-check Terra in 2000-2002. |
| Screens tuned on one event | The land rule and the burst screen were designed on the 2026-10-25 NOAA-20 false alarm; their thresholds (one-cell buffer, 6 robust standard deviations, 500 detections) are judgement calls checked on the whole record (Table M5b), not fitted. Near-real-time rows in small unmapped islands are dropped. | A labelled set of known false-alarm granules from FIRMS to tune the screen. |
| Detections are not burned area | Counts do not give area burned. | Cross-check against a burned-area product, for example GFED5 (Chen et al. 2023) or the FIRMS burned-area layers, as an external validation of the monthly ranks. |
| Persistent sources missed by the mask | A source that FIRMS does not label and that is active for less than 10 months a year is counted. | Tune the persistence rule against known flare locations. |
| Count-based availability | A genuine regional quiet period is not confused with an outage because counts are global, but a small partial outage of one satellite may not be flagged. | Use the satellites' own granule metadata. |
| Overview, trend map and watchlist use the switch rule | They are built in Python from the 0.25° tiles with MODIS before 2023-01 and calibrated VIIRS after, without drift correction, while the area analysis fuses by default. A place's month on the globe can differ from the same month in the area analysis, most from 2020 on. | Build the overview and watchlist from the fused record (a fused column in the tiles or a Python port of the fusion). |
| AI dossier unit under the lens | The dossier has no unit field, so under the VIIRS lens the model is still told the values are MODIS-equivalent (its comments in `dossierTypes.ts` say AFCD-M). The rule-based brief handles the lens. | Add the unit to the dossier and the prompt. |
| Coefficients are refitted at every rebuild | They are *frozen* in the sense of a fixed fit window and are not stored between builds, so a rebuild can move them slightly (the mask and the availability table are recomputed over all data). | Store the coefficient files with the release and make the build read them. |
| Daily time zones | Local-solar date uses longitude / 15 h, not civil time zones. | Intentional; documented here so that day boundaries are not mistaken for civil days. |

## 21. What is new here and what is standard

Standard, with prior use for fire data and common among entries made for this challenge: cell-days as a unit, a stratified ratio calibration with shrinkage, leave-one-year-out validation and change-point tests. The design parallels GFED5's near-real-time extension (Chen et al. 2026), which also calibrates VIIRS to the MODIS-based record; it is supporting precedent for the calibration, and Harmony does not claim to improve on it.

Standard methods applied here to MODIS/VIIRS active-fire counts: triple collocation (established for winds and soil moisture, and applied to fire radiative power, not counts, by Kang et al. 2026), merging of satellite products with error-variance weights (GFAS, Kaiser et al. 2012; ESA CCI soil moisture, Gruber et al. 2017), split conformal prediction (Vovk et al. 2005; Lei et al. 2018; in Earth observation, Singh et al. 2024), and cross-calibration closure (Chander et al. 2013). Count models with time-varying levels have a long statistical history (for example Harvey and Fernandes 1989); the fusion here is a simpler per-month combination.

What we did not find elsewhere, in a search of the fire-count literature and of other entries made for this build (a search, not a proof): fusion weights for MODIS and VIIRS fire counts estimated by collocation rather than assumed; a global per-biome, day/night estimate of drift-induced change in MODIS active-fire counts against a fixed-overpass VIIRS reference, with the overpass-time shift used to estimate the diurnal sensitivity of detections; and empirical conformal intervals for a harmonized fire-count record checked out of time. To our knowledge none of the three has been published for active-fire counts; each component is standard, and none is claimed as first, optimal or guaranteed.

## Measured values (as of the 2026-11-15 build)

Update this section from the files named in each caption after a refresh; apart from the overview and watchlist figures in section 19, nothing else in this document contains data-dependent numbers. The build has global scope and runs to 2026-11-15, with NOAA-21 from 2023-03 and near-real-time data from 2026-08 (VIIRS) and 2026-09 (MODIS); 2026-11 is partial for both sensors (15 of 30 days; VIIRS coverage 0.50, MODIS 0.48) and is in progress: drawn, never used in statistics (section 4). Every table was recomputed from the files named in its caption after the refresh, again after the fix rebuild of the same day (near-real-time classification, NOAA scale-factor guard, naive-series names), and again after the review rebuild of the same day (land and burst screen, union-aware MODIS coverage, completeness rule, variance floor of the intervals; Known issues 5). Table M6 comes from `data/dist/ml/model.json`, retrained on the final cube (`trained_on_build`).

### Known issues of the 2026-11-15 build

1. **Ultra-real-time rows (fixed in the fix rebuild).** The first 2026-11-15 build labelled a row near-real-time only if its `version` contained `NRT`, so the 1,612 NOAA-20 rows (`2.1URT`) and 249 NOAA-21 rows (`2.0URT`) of 2026-11-15 counted as standard and the other 769,150 NOAA-20 and 748,160 NOAA-21 near-real-time rows of 2026-11 were dropped as superseded (VIIRS coverage of 2026-11 was 0.10). The rule is now version-based (section 2); the 2026 files were re-normalized and every later stage rebuilt. 2026-11 now has all three VIIRS satellites' near-real-time rows (VIIRS coverage 0.50, MODIS 0.48); after the fix rebuild it was coverage-corrected and entered statistics as the current month, and since the review rebuild it is in progress (issue 5).
2. **ML model snapshot (fixed in the review rebuild).** The model had been trained on a snapshot taken before the refresh; it is retrained on the final cube, and the `ml` stage now takes a new snapshot whenever the cube or the coefficients are newer than the old one (Table M6).
3. **Switch-rule products.** The overview atlases, the trend map and the watchlist use the switch rule (section 11).
4. **Two naive series (renamed in the fix rebuild).** `validation.json` now names both raw-count records explicitly in Tables M4 and M4b: `naive_switch_2023` (MODIS counts, then VIIRS counts from 2023-01; formerly `pettitt.naive`) and `naive_viirs_from_2012` (VIIRS counts from 2012-02; formerly `pettitt.at_viirs_start.naive` and `fusion.pettitt_fused.*.naive`). The web app's method section still reads the old keys `pettitt.naive` and `pettitt.at_viirs_start.naive` until it is updated.
5. **Review rebuild (2026-11-15).** An integration review found, and this rebuild fixes: (a) a half-covered month treated as complete: 2026-11 (15 of 30 days, coverage 0.50) was scaled x2 and shown as the current month, and the watchlist read 13 of 15 clusters as "highest of 27 Novembers"; a month now drives statistics only at day coverage >= 0.9 (section 4), so the current month and the watchlist target are 2026-10; (b) a false-alarm NOAA-20 overpass on 2026-10-25 (about 10,000 near-real-time detections on the Arafura and Banda seas, which the `unclassified` stratum and the NOAA-20 scale factor had absorbed); near-real-time rows over water and the suspect rows of burst days are now removed (section 2, Table M5b); (c) levels that contradicted the ratio (section 19); (d) the VIIRS lens changing the season and other rank statistics (section 18); (e) confident statements in sparse areas (section 19); (f) a 0-0 interval for zero months (section 12); (g) the MODIS coverage correction, which assumed each MODIS satellite carries half of the Terra∪Aqua cell-days (section 4). The bridge era was investigated and left unchanged (section 8).

**Table M1. Raw and harmonized VIIRS-to-MODIS ratios by year** (`validation.json`, `ratio_by_year`). Count ratio = VIIRS detections / MODIS detections; AFCD ratio = sum of uncalibrated `v` / sum of `meq`; harmonized ratio = sum of `kv` / sum of `meq`. 2012 starts in February for VIIRS, so its ratios are not comparable.

| Year | MODIS detections | VIIRS detections | Count ratio | AFCD ratio (raw) | Harmonized ratio |
| --- | --- | --- | --- | --- | --- |
| 2012 | 4,516,630 | 17,017,651 | 3.77 | 2.41 | 0.89 |
| 2013 | 3,828,738 | 15,335,521 | 4.01 | 2.78 | 1.00 |
| 2014 | 3,997,393 | 16,070,102 | 4.02 | 2.78 | 1.00 |
| 2015 | 4,284,877 | 17,112,136 | 3.99 | 2.74 | 0.99 |
| 2016 | 3,992,527 | 16,219,255 | 4.06 | 2.80 | 0.99 |
| 2017 | 4,019,104 | 15,865,506 | 3.95 | 2.68 | 0.98 |
| 2018 | 3,749,733 | 26,532,307 | 7.08 | 2.75 | 1.00 |
| 2019 | 4,107,420 | 33,389,336 | 8.13 | 2.75 | 1.00 |
| 2020 | 4,004,148 | 33,040,120 | 8.25 | 2.83 | 1.02 |
| 2021 | 3,933,448 | 32,148,055 | 8.17 | 2.76 | 1.01 |
| 2022 | 3,397,224 | 27,756,052 | 8.17 | 2.81 | 1.03 |
| 2023 | 4,167,362 | 48,548,346 | 11.65 | 2.76 | 1.01 |
| 2024 | 4,351,135 | 52,121,428 | 11.98 | 2.76 | 1.00 |
| 2025 | 3,268,543 | 42,136,938 | 12.89 | 2.97 | 1.07 |
| 2026 | 2,730,821 | 38,604,119 | 14.14 | 3.46 | 1.24 |

The count ratio steps up again from 2023, when NOAA-21 joins (each satellite adds its own detections); the harmonized ratio does not, but it rises in 2025-2026 as MODIS drifts (section 10). 2026 runs to mid-November; its 2026-11 MODIS value is left uncorrected (coverage 0.48, below 0.5) while VIIRS is coverage-corrected (0.50), which raises the 2026 AFCD and harmonized ratios. Since the review rebuild 2026 excludes the near-real-time rows over water and on burst days (section 2), 27,270 VIIRS and 168 MODIS detections.

**Table M2. Validation** (`validation.json`: `loyo`, `loyo_naive_global_ratio`, `out_of_time`, `aqua_only_sensitivity`, `beta_loglog_1deg`).

| Test | Measure | Production | Naive global ratio |
| --- | --- | --- | --- |
| LOYO stratum-month (7,281 unit-months) | r of log1p | 0.9884 | 0.9808 |
| | log-RMSE | 0.4581 | 0.6070 |
| | bias | +0.06 % | +0.00 % |
| | slope | 1.040 | 1.061 |
| | peak month exact / within one month | 0.855 / 0.936 | 0.815 / 0.917 |
| | anomaly sign agreement | 0.892 | 0.898 |
| LOYO 1-degree cell-month (938,505 unit-months) | r of log1p | 0.9439 | 0.9278 |
| | log-RMSE | 0.6004 | 0.6800 |
| | slope | 1.006 | 0.999 |
| | peak month exact / within one month | 0.778 / 0.891 | 0.769 / 0.885 |
| | anomaly sign agreement | 0.843 | 0.844 |
| Out-of-time bias (stratum-month r) | 2022 (11 months) | +2.0 % (0.984) | not computed |
| | 2023 | +1.4 % (0.988) | |
| | 2024 | -0.0 % (0.988) | |
| | 2025 | +7.0 % (0.985) | |
| | 2026 (10 months) | +19.0 % (0.981) | |
| Aqua-only sensitivity | correlation of log anomalies, production vs Aqua-only reference | 0.984 (lowest by biome: unclassified 0.863, tropical and subtropical grasslands 0.957, tundra 0.971; others 0.984-0.995) | |
| Log-log slope, 1-degree, by biome | OLS slope of log M on log V | 0.66 (mangroves) to 0.94 (tropical and subtropical grasslands); all below 1 | |

Stratum-month log-RMSE by biome ranges from 0.17 (deserts) to 0.41 (flooded grasslands) for most biomes; it is 1.20 for boreal forest, 1.36 for tundra and 0.67 for the unclassified stratum (`loyo.stratum_month.by_biome`).

**Table M3. Calibration parameters and interval** (`validation.json`, `params`, `interval_coverage_loyo_1deg`, `noaa_scale`, `meta.json`).

| Item | Value |
| --- | --- |
| Strata | 64 (63 biome x realm, 1 unclassified) |
| `tau` (VIIRS calibration); 1-degree LOYO RMSE for tau = 5 / 10 / 20 / 50 / none | 5; 0.6004 / 0.6089 / 0.6180 / 0.6288 / 0.6450 |
| `tau_bridge` | 20 |
| Share of the 1,536 factors (64 strata x 2 x 12 months) by fallback level: stratum x dn x month / stratum x dn / biome x dn / global x dn | 66.9 % / 22.9 % / 8.6 % / 1.6 % |
| NOAA-20 to S-NPP factor `c20`: median, range across strata and day|night | 0.978; 0.875 to 1.135 across all 128 factors. The scale-factor guard (section 4) rejected four stratum factors because one month supplied more than half of a sum, and used the biome factor instead: `c20` stratum 41 at night 1.037 → 0.968, `c21` stratum 1 at night 0.974 → 0.958, stratum 46 by day 0.883 → 0.949 and at night 0.956 → 0.977. Before the review rebuild a fifth was rejected: `c20` of the unclassified stratum by day was 0.044, because 95 % of its NOAA-20 sum came from 2026-10. Those were not "detections without a type" in the ordinary sense but a false alarm: the NOAA-20 near-real-time granules of 2026-10-25 04:27-04:29 UTC put about 10,000 detections on the open Arafura and Banda seas (near-real-time rows carry no `type`, so the offshore class could not remove them). The land rule and the burst screen now remove them (section 2, Table M5b); the unclassified stratum by day now falls back to the global factor (0.994) because its overlap sum is below 200 cell-days |
| V-weighted `k` by biome (VIIRS to MODIS-equivalent), day | 0.29 (mangroves) to 0.60 (temperate conifer forests) |
| V-weighted `k` by biome, night | 0.14 (montane grasslands) to 0.36 (tundra) |
| Bridge LOYO RMSE at tau_bridge (1-degree) | 0.8220 |
| `ci_scale` (legacy interval only) | 2.2362 |
| Share of Terra∪Aqua cell-days seen by Terra / by Aqua, day and night (union-aware coverage, section 4) | Terra 0.299 / 0.706, Aqua 0.734 / 0.308 (`modis_union_share`) |
| VIIRS-to-MODIS factor refitted on 2012-2019 instead of 2012-2021 | +0.32 % globally (Table M11d) |
| 80 % interval coverage, unscaled | 0.481 |
| 80 % / 95 % coverage after scaling, all cells with H >= 5 (372,877 cell-months) | 0.800 / 0.915 |
| Same by predicted H: 5-20 (177,489), 20-100 (122,603), 100 and above (72,785) | 80 %: 0.822, 0.808, 0.734; 95 %: 0.919, 0.923, 0.889 |

**Table M4. Change-point tests** (`validation.json`, `pettitt`). Step is in natural-log units of the monthly total after removing the month-of-year mean.

| Event | Window | Series | Detected change month | p | Step |
| --- | --- | --- | --- | --- | --- |
| Switch to VIIRS, 2023-01 | 2020-01 to 2025-12 | `naive_switch_2023` (MODIS counts before, VIIRS counts from the switch) | 2023-01 | below 0.0001 | +2.533 |
| | | `naive_viirs_from_2012` (VIIRS counts throughout this window) | 2023-03 | below 0.0001 | +0.439 |
| | | harmonized (`meq` before, `kv` from the switch) | 2025-02 | 0.15 | -0.118 |
| VIIRS start, 2012-02 | 2009-02 to 2015-01 | `naive_viirs_from_2012` (MODIS counts before, VIIRS counts from 2012-02) | 2012-02 | below 0.0001 | +1.367 |
| | | harmonized | 2013-03 | 0.14 | -0.070 |

The `naive_viirs_from_2012` step at 2023-03 in the switch window is NOAA-21 joining (raw VIIRS counts add each satellite's detections), not the switch.

**Table M5. Availability, mask and strata** (`availability.parquet`, `static_mask.parquet`, `data/work/refresh_run.log`).

| Item | Value |
| --- | --- |
| Satellite-days flagged unavailable: Terra / Aqua / S-NPP / NOAA-20 / NOAA-21 (of days in operating period) | 63 of 9,511 / 28 of 8,901 / 51 of 5,401 / 6 of 3,151 / 2 of 1,356 |
| Largest unavailable runs | Terra 2001-06-16 to 07-02 (17 days), 2016-02-19 to 02-27, 2022-10-11 to 10-23; S-NPP 2022-07-27 to 08-10; Aqua 2022-04-01 to 04-16 |
| Flagged at the end of the record | Aqua 2026-11-15 (a partial last day). Before the fix rebuild the classification fault (Known issues) also flagged NOAA-20 and NOAA-21 on 2026-11-01 to 11-14 |
| Masked sub-cells | 139,458 core (typed or persistent) plus 538,764 by dilation, 678,222 in all (0.16 % of the 414.7 million sub-cells) |
| Fire-active 0.05 degree cells and stratum assignment | 2,971,026; 2,945,537 inside an ecoregion, 24,513 nearest within 0.25 degrees, 976 unclassified (3,055 before the review rebuild: most of the difference is the 2026-10 sea detections) |

**Table M5b. Land and burst screen** (`validation.json`: `land_screen`, `bursts`; `screen.py`, section 2). Candidate detections = confidence ok, type 0 or absent, outside the static mask.

| Item | Value |
| --- | --- |
| Water cells (0.05°, no mapped land within one cell) holding any detection | 6,924 |
| Near-real-time candidate rows in water cells, not used | 25,859 (NOAA-20 16,452, NOAA-21 7,541, S-NPP 1,698, Aqua 125, Terra 43; 2026-10: 20,754) |
| Standard-quality candidate rows in water cells (kept; their `type` is 0) | 39,835 over 2000-2026 |
| Burst threshold per satellite (suspect detections a day; median) | Terra 2,380 (4), Aqua 2,857 (5), S-NPP 2,540 (36), NOAA-20 597 (29), NOAA-21 715 (29) |
| Near-real-time burst days (excluded) | NOAA-20 2026-10-25 (9,872 suspect of 56,729 candidates, 9,704 over water; robust z 11.6), 2026-10-09 (2,455; z 8.8), 2026-10-03 (1,567; 7.9), 2026-10-15 (1,411; 7.7); NOAA-21 2026-10-27 (2,140; 8.1), 2026-09-15 (1,718; 7.7), 2026-10-11 (1,642; 7.6), 2026-09-26 (895; 6.4) |
| Rows removed by the burst rule beyond the land rule | 1,579 |
| Standard-quality burst days (report only) | none above the threshold over 2000-2026. Highest: NOAA-20 2022-07-28, 07-31, 08-07 (514-573 suspect, z 5.7-5.9; low-FRP detections at 55-60° N, 125-140° E), NOAA-21 2023-03-10 (671, z 5.9; median FRP 0.6 MW in the Algerian Sahara, 30-35° N, 0-10° E, in the satellite's first weeks), S-NPP 2012-08-01 and 2016-07-24 (about 1,500, z 5.2-5.3; central Siberia, when only MODIS could confirm S-NPP) |
| Accepted detections after the screen | 535,642,631 (MODIS 103,745,759; VIIRS 431,896,872); before 535,670,069 |

**Table M6. ML challenger** (`data/dist/ml/model.json`; trained on the final cube of the review rebuild, `trained_on_build`: `meta.json` generated 2026-11-15T13:00:31Z, data through 2026-11-15). Fixed split: fit 2012-02 to 2018-12, test 2019-2021. Unit-months: 298,011 at 1 degree, 2,219 at stratum scale. Before the retraining the table came from a snapshot taken before the refresh, and its out-of-time production row (+1.2 / +1.5 / 0.0 / +7.3 %) differed from Table M2; it now agrees with it (+2.0 / +1.4 / -0.0 / +7.0 %).

| Method | 1-degree r | 1-degree log-RMSE | Stratum r | Stratum log-RMSE | Bias |
| --- | --- | --- | --- | --- | --- |
| Naive global ratio | 0.930 | 0.666 | 0.980 | 0.621 | +1.70 % |
| Ratio, stratum x dn x month | 0.938 | 0.630 | 0.985 | 0.519 | +1.06 % |
| Production (ratio x cell multiplier) | 0.945 | 0.593 | 0.987 | 0.491 | +1.38 % |
| Challenger (mass-balanced) | 0.948 | 0.550 | 0.989 | 0.435 | +1.59 % |
| Challenger x cell multiplier | 0.952 | 0.527 | 0.990 | 0.403 | +1.17 % |

Out-of-time bias in the ML run, 2022 / 2023 / 2024 / 2025: production +2.0 / +1.4 / -0.0 / +7.0 %; challenger -1.6 / -1.6 / -2.4 / +4.5 %; naive +1.4 / +0.4 / +0.4 / +8.0 %. Worst biome bias on the test years: challenger -16.0 %, production -9.0 %. Mass-balance factor of the shipped model: 1.0880. The `verdict` text in `model.json` is generated from the same table.


**Table M4b. Change points of the fused global series** (`validation.json`, `fusion.pettitt_fused`; detected month, p and step for each series).

| Event (window) | Fused | Switch | `naive_viirs_from_2012` | `naive_switch_2023` |
| --- | --- | --- | --- | --- |
| VIIRS start, 2012-02 (109-180) | 2013-03, p 0.111, step -0.076 | 2013-03, p 0.097, step -0.081 | 2012-02, p below 0.0001, step +1.367 | 2013-03, p 0.100, step -0.085 (MODIS counts only) |
| Drift correction starts, 2020-01 (204-275) | 2020-12, p 0.065, step -0.059 | 2020-12, p 0.021, step -0.076 | 2018-11, p below 0.0001, step +0.496 | 2021-09, p 0.008, step -0.151 (MODIS counts only) |
| Legacy switch, 2023-01 (240-311) | 2025-02, p 0.059, step -0.131 | 2025-02, p 0.152, step -0.118 | 2023-03, p below 0.0001, step +0.439 | 2023-01, p below 0.0001, step +2.533 |

`naive_viirs_from_2012` is raw VIIRS counts from 2012-02 (MODIS counts before); in the two later windows it is VIIRS throughout, so its steps reflect NOAA-20 (2018) and NOAA-21 (2023) joining. `naive_switch_2023` is MODIS counts until 2023-01 and VIIRS counts from it (the series of Table M4); before 2023 it is raw MODIS counts, whose 2021-09 decline is the MODIS drift. Fused global total over raw MODIS, by year: 2012 0.984, 2013 0.997, 2014 1.003, 2015 0.993, 2016 0.993, 2017 0.990, 2018 1.002, 2019 1.001, 2020 1.027, 2021 1.004, 2022 1.028, 2023 1.013, 2024 1.002, 2025 1.072, 2026 1.241 (2026-11 MODIS uncorrected at coverage 0.48).

**Table M7a. Cell-level dispersion `phi`** (`validation.json`, `error_model`; day / night; group values weighted by Terra∪Aqua cell-days; MODIS-equivalent units, 1 = Poisson). TC = triple collocation; split = Poisson split of the VIIRS - Terra∪Aqua difference (section 9d).

| Biome group | Terra∪Aqua, TC | Terra∪Aqua, split | VIIRS 1 sat., TC | VIIRS 1 sat., split | VIIRS 2 sat. | VIIRS 3 sat. | Terra bridge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tropical forests | 1.80 / 0.95 | 2.26 / 2.14 | 0.80 / 1.35 | 0.71 / 0.45 | 0.78 / 1.09 | 0.44 / 0.67 | 9.0 / 1.3 |
| Temperate forests | 1.22 / 0.90 | 1.58 / 2.29 | 1.16 / 1.74 | 0.79 / 0.57 | 0.79 / 2.01 | 0.61 / 1.57 | 3.4 / 1.1 |
| Boreal forest and tundra | 0.52 / 0.81 | 1.22 / 2.60 | 1.61 / 3.09 | 0.68 / 0.82 | 2.00 / 4.98 | 1.34 / 2.86 | 1.1 / 0.6 |
| Tropical savannas and grasslands | 2.48 / 1.27 | 2.59 / 2.29 | 1.01 / 1.13 | 1.03 / 0.45 | 0.69 / 1.24 | 0.57 / 0.73 | 10.5 / 1.9 |
| Temperate grasslands | 1.25 / 1.09 | 1.30 / 2.51 | 0.75 / 0.87 | 0.73 / 0.53 | 0.46 / 0.68 | 0.22 / 0.31 | 3.1 / 1.9 |
| Flooded and montane grasslands | 1.74 / 1.24 | 1.91 / 2.21 | 1.04 / 1.19 | 0.81 / 0.55 | 0.89 / 1.85 | 0.31 / 0.62 | 6.3 / 2.0 |
| Mediterranean | 1.28 / 0.90 | 1.37 / 1.97 | 0.70 / 1.07 | 0.72 / 0.63 | 0.36 / 1.40 | 0.37 / 0.66 | 5.1 / 1.5 |
| Deserts and xeric shrublands | 1.63 / 1.24 | 1.72 / 2.09 | 0.66 / 1.06 | 0.77 / 0.59 | 0.47 / 1.19 | 0.52 / 1.09 | 5.3 / 2.4 |
| Mangroves and unclassified | 0.92 / 0.49 | 1.28 / 1.45 | 0.61 / 0.73 | 0.38 / 0.36 | 0.35 / 1.66 | 0.20 / 1.17 | 4.7 / 0.8 |
| All strata | 2.07 / 1.08 | 2.29 / 2.28 | 0.96 / 1.49 | 0.90 / 0.53 | 0.75 / 1.78 | 0.54 / 1.08 | 8.8 / 1.6 |

**Table M7b. Stratum-coherent relative variance `rho`** (day / night). `relvar` is the calibration floor the kernel adds to VIIRS.

| Biome group | Terra∪Aqua | VIIRS (any number of satellites) | VIIRS `relvar` | Terra bridge (incl. `relvar_bridge`) |
| --- | --- | --- | --- | --- |
| Tropical forests | 0.0065 / 0.0078 | 0.0038 / 0.0159 | 0.0018 / 0.0073 | 0.0247 / 0.0087 |
| Temperate forests | 0.0066 / 0.0336 | 0.0170 / 0.0278 | 0.0037 / 0.0867 | 0.0259 / 0.0419 |
| Boreal forest and tundra | 0.0053 / 0.0265 | 0.0127 / 0.0653 | 0.0024 / 0.0090 | 0.0162 / 0.0649 |
| Tropical savannas and grasslands | 0.0014 / 0.0015 | 0.0009 / 0.0077 | 0.0003 / 0.0013 | 0.0048 / 0.0034 |
| Temperate grasslands | 0.0073 / 0.0484 | 0.0086 / 0.0567 | 0.0009 / 0.0940 | 0.0194 / 0.0019 |
| Flooded and montane grasslands | 0.0043 / 0.0167 | 0.0081 / 0.0154 | 0.0015 / 0.0080 | 0.0159 / 0.0194 |
| Mediterranean | 0.0136 / 0.0232 | 0.0070 / 0.0674 | 0.0026 / 0.3715 | 0.0513 / 0.0339 |
| Deserts and xeric shrublands | 0.0071 / 0.0132 | 0.0077 / 0.0231 | 0.0017 / 0.1112 | 0.0227 / 0.0279 |
| Mangroves and unclassified | 0.0123 / 0.0376 | 0.0079 / 0.0822 | 0.0027 / 0.0276 | 0.0494 / 0.0219 |
| All strata | 0.0037 / 0.0124 | 0.0037 / 0.0236 | 0.0011 / 0.0283 | 0.0130 / 0.0189 |

Single satellites, all strata, `phi` day / night: S-NPP 1.17 / 1.46, NOAA-20 1.07 / 2.05, NOAA-21 1.42 / 1.38, Aqua rescaled 2.42 / 3.62, Terra rescaled 8.77 / 1.55. The two halves of the Terra∪Aqua estimate: from Terra 2.35 / 1.09, from Aqua 1.79 / 1.07. Signal share of the cell-level anomaly variance 0.82 / 0.82. Variance of log(Terra∪Aqua) - log(mean of rescaled Terra and Aqua), stratum-month anomalies: 0.0082. Common mode (section 9c): day, Aqua-VIIRS error correlation 0.48 on 32 strata, `kappa` = 0.34; night, the alternative identification gives a negative correlation (-0.65, 15 strata), which is not usable, so `kappa` = 0 at night. Fallback levels (stratum / biome / global / global raised to the plausibility floor): cell TC Terra, Aqua, S-NPP 75% / 14% / 2% / 9%; VIIRS one satellite 70% / 21% / 1% / 8%; two 31% / 51% / 11% / 7%; three 44% / 45% / 11% / 0%; stratum-month TC 73% / 26% / 2% / 0%.

**Table M8a. Drift fingerprint, global** (`validation.json`, `drift.table`, scope `global`). Ratio observed / expected (expected from calibrated VIIRS with satellite-specific 2012-2019 ratios). 2019 is a placebo year (leave-one-year-out reference); from 2022 the total 95 % interval (jackknife plus placebo variance) is in brackets. 2026: January to October, near-real-time from August (VIIRS) and September (MODIS).

| Satellite | | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Terra | day | 1.01 | 1.00 | 0.99 | 0.92 (0.88-0.96) | 0.85 (0.80-0.89) | 0.73 (0.68-0.77) | 0.58 (0.53-0.63) | 0.45 (0.40-0.50) |
| Terra | night | 1.03 | 1.04 | 1.10 | 1.04 (0.99-1.10) | 1.16 (1.10-1.22) | 1.27 (1.21-1.33) | 1.35 (1.27-1.43) | 1.55 (1.44-1.67) |
| Aqua | day | 0.99 | 0.95 | 0.99 | 1.00 (0.96-1.03) | 1.02 (0.99-1.06) | 1.06 (1.02-1.10) | 1.01 (0.97-1.05) | 0.90 (0.85-0.95) |
| Aqua | night | 1.07 | 0.99 | 1.09 | 0.98 (0.87-1.10) | 1.03 (0.93-1.15) | 1.04 (0.92-1.16) | 0.83 (0.75-0.93) | 0.70 (0.60-0.81) |
| Terra∪Aqua | day | 1.00 | 0.96 | 0.99 | 0.97 (0.95-1.00) | 0.98 (0.95-1.01) | 0.97 (0.94-1.00) | 0.90 (0.87-0.94) | 0.78 (0.75-0.82) |
| Terra∪Aqua | night | 1.04 | 1.03 | 1.10 | 1.03 (0.97-1.09) | 1.12 (1.06-1.19) | 1.19 (1.12-1.25) | 1.20 (1.13-1.27) | 1.29 (1.19-1.39) |

Placebo, 2012-2019, global, RMS of the log ratio (day / night): Terra 0.021 / 0.022, Aqua 0.016 / 0.050, Terra∪Aqua 0.014 / 0.025; largest single-year departure 9.5 %. The jackknife-only 95 % interval covers 1 in 62 % of the years (day) and 88 % (night) of the Terra∪Aqua placebo years: it misses the year-to-year variability, which is why the total interval adds it.

**Table M8b. Overpass shift** (`drift.overpass`): mean local solar time of detections minus the same satellite's 2012-2019 mean for the same stratum × day|night × month of year, hours.

| Satellite | | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Terra | day | +0.02 | +0.04 | -0.01 | -0.20 | -0.42 | -0.69 | -1.09 | -1.24 |
| Terra | night | +0.00 | +0.01 | -0.05 | -0.20 | -0.44 | -0.74 | -1.16 | -1.71 |
| Aqua | day | -0.01 | -0.01 | -0.00 | +0.06 | +0.25 | +0.60 | +1.14 | +1.83 |
| Aqua | night | -0.00 | -0.00 | +0.01 | +0.07 | +0.29 | +0.64 | +1.16 | +1.95 |
| SNPP | day | -0.02 | -0.03 | -0.02 | -0.01 | +0.00 | -0.02 | +0.01 | +0.12 |
| SNPP | night | -0.02 | -0.03 | -0.02 | -0.01 | +0.02 | -0.03 | +0.03 | +0.15 |
| NOAA20 | day | +0.00 | -0.01 | +0.01 | +0.01 | +0.03 | +0.01 | +0.00 | +0.07 |
| NOAA20 | night | +0.00 | -0.01 | -0.00 | +0.01 | +0.02 | +0.00 | +0.01 | +0.09 |

**Table M8c. Drift by biome group, 2025, and diurnal sensitivity** (`drift.table`, `drift.diurnal_sensitivity`). Ratio (total 95 % interval). `beta` = change in log detections per hour of overpass shift ± standard error (share of the 2020-2026 variance of the log ratio explained by the shift).

| Biome group | Terra day | Terra night | Aqua day | Aqua night | beta Terra day | beta Terra night | beta Aqua night |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tropical forests | 0.60 (0.51-0.70) | 1.53 (1.37-1.72) | 1.02 (0.92-1.13) | 0.79 (0.67-0.92) | +0.41 ± 0.02 (98%) | -0.38 ± 0.02 (99%) | -0.06 ± 0.04 (20%) |
| Temperate forests | 0.73 (0.60-0.90) | 1.30 (0.97-1.75) | 1.00 (0.88-1.12) | 0.95 (0.54-1.69) | +0.28 ± 0.03 (97%) | -0.20 ± 0.05 (93%) | -0.09 ± 0.09 (26%) |
| Boreal forest and tundra | 0.80 (0.70-0.91) | 1.06 (0.88-1.27) | 1.20 (1.04-1.39) | 0.89 (0.53-1.48) | +0.01 ± 0.07 (0%) | +0.05 ± 0.07 (3%) | -0.48 ± 0.12 (63%) |
| Tropical savannas and grasslands | 0.52 (0.46-0.58) | 1.40 (1.32-1.49) | 0.99 (0.95-1.04) | 0.82 (0.74-0.90) | +0.64 ± 0.02 (99%) | -0.29 ± 0.01 (99%) | -0.19 ± 0.02 (90%) |
| Temperate grasslands | 0.70 (0.63-0.78) | 1.05 (0.76-1.45) | 1.00 (0.89-1.12) | 0.55 (0.33-0.92) | +0.32 ± 0.02 (99%) | -0.20 ± 0.06 (61%) | -0.40 ± 0.10 (74%) |
| Flooded and montane grasslands | 0.51 (0.44-0.60) | 1.55 (1.36-1.78) | 1.06 (0.99-1.12) | 0.77 (0.49-1.20) | +0.60 ± 0.02 (99%) | -0.44 ± 0.03 (94%) | -0.18 ± 0.04 (70%) |
| Mediterranean | 0.76 (0.57-1.02) | 1.30 (0.83-2.03) | 1.13 (0.95-1.33) | 1.10 (0.62-1.94) | +0.29 ± 0.02 (97%) | -0.14 ± 0.06 (68%) | -0.06 ± 0.09 (10%) |
| Deserts and xeric shrublands | 0.79 (0.69-0.90) | 1.23 (1.01-1.49) | 1.01 (0.93-1.09) | 0.93 (0.69-1.24) | +0.18 ± 0.02 (94%) | -0.21 ± 0.03 (95%) | -0.15 ± 0.05 (66%) |
| Mangroves and unclassified | 0.50 (0.37-0.69) | 1.15 (0.71-1.85) | 1.20 (1.07-1.34) | 0.49 (0.23-1.07) | +0.51 ± 0.05 (95%) | -0.26 ± 0.09 (80%) | -0.21 ± 0.14 (25%) |

**Table M9. Conformal intervals** (`validation.json`, `conformal`; `meta.json`, `conformal`). Multipliers of the global row; coverage of observed Terra∪Aqua at 80 % / 95 % by size class of the prediction, all supports pooled. In the calibration years the new interval covers 0.800 / 0.950 in every class by construction. Since the review rebuild the scores and the kernel use the variance floor of section 12, which lowers the H<5 multipliers (q80 / q95 1.29 / 3.02 before, 1.13 / 2.02 now) because a zero prediction no longer has a zero-width interval. Out of time = frozen calibration, 2022-2024.

| Size class (AFCD) | q80 / q95 | n, 2012-2021 | legacy, 2012-2021 | n, 2022-2024 | conformal vs raw MODIS | conformal vs drift-corrected MODIS | legacy vs raw MODIS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H<5 | 1.13 / 2.02 | 791,538 | 0.396 / 0.407 | 270,347 | 0.801 / 0.947 | 0.800 / 0.947 | 0.363 / 0.376 |
| 5-20 | 1.79 / 3.40 | 233,723 | 0.826 / 0.922 | 69,012 | 0.775 / 0.939 | 0.777 / 0.939 | 0.818 / 0.914 |
| 20-100 | 1.89 / 3.37 | 164,403 | 0.804 / 0.921 | 47,466 | 0.754 / 0.927 | 0.760 / 0.929 | 0.774 / 0.900 |
| 100-1000 | 2.12 / 3.74 | 93,950 | 0.722 / 0.874 | 27,918 | 0.734 / 0.920 | 0.750 / 0.927 | 0.669 / 0.834 |
| H>=1000 | 2.19 / 3.98 | 13,737 | 0.633 / 0.805 | 4,283 | 0.713 / 0.912 | 0.733 / 0.920 | 0.557 / 0.725 |

Out of time by biome group (80 %, conformal / legacy): Tropical forests 0.78 / 0.57; Temperate forests 0.79 / 0.49; Boreal forest and tundra 0.82 / 0.37; Tropical savannas and grasslands 0.77 / 0.57; Temperate grasslands 0.78 / 0.55; Flooded and montane grasslands 0.79 / 0.48; Mediterranean 0.79 / 0.49; Deserts and xeric shrublands 0.80 / 0.39; Mangroves and unclassified 0.81 / 0.36.78 / 0.57; Temperate forests 0.80 / 0.49; Boreal forest and tundra 0.82 / 0.37; Tropical savannas and grasslands 0.78 / 0.57; Temperate grasslands 0.79 / 0.55; Flooded and montane grasslands 0.78 / 0.48; Mediterranean 0.80 / 0.49; Deserts and xeric shrublands 0.80 / 0.39; Mangroves and unclassified 0.82 / 0.36. The legacy interval cannot cover a zero (class below 5) and narrows relative to the error for the largest values. The conformal interval undercovers out of time by 3 to 9 points in the classes above 5, more for larger values; drift-correcting the reference recovers part of that.

**Table M10. Fusion** (`validation.json`, `fusion`). (a) Non-circular test, 2012-2019: log1p RMSE against rescaled Terra; size class from the mean of the two inputs.

| Scale | Aqua alone (switch) | VIIRS alone | Fused | Equal weights | Mean Aqua weight |
| --- | --- | --- | --- | --- | --- |
| 1° cell-month, all (n 739,773) | 0.949 | 0.932 | 0.898 | 0.888 | 0.35 |
| stratum-month, all (n 5,800) | 0.464 | 0.570 | 0.512 | 0.502 | 0.56 |
| 1°, H<5 (n 452,137) | 0.865 | 0.855 | 0.808 | 0.790 | |
| 1°, 5-20 (n 134,264) | 1.212 | 1.190 | 1.160 | 1.155 | |
| 1°, 20-100 (n 95,270) | 0.996 | 0.974 | 0.962 | 0.964 | |
| 1°, 100-1000 (n 53,894) | 0.792 | 0.747 | 0.752 | 0.760 | |
| 1°, H>=1000 (n 4,208) | 0.698 | 0.621 | 0.644 | 0.657 | |
| stratum, H<5 (n 656) | 0.880 | 0.871 | 0.809 | 0.793 | |
| stratum, 5-20 (n 345) | 0.899 | 1.447 | 1.273 | 1.231 | |
| stratum, 20-100 (n 810) | 0.539 | 0.726 | 0.639 | 0.637 | |
| stratum, 100-1000 (n 1,997) | 0.291 | 0.297 | 0.272 | 0.273 | |
| stratum, H>=1000 (n 1,992) | 0.165 | 0.180 | 0.159 | 0.158 | |

Error model alone (no conformal multiplier): the nominal 80 % / 95 % interval of the fused value, widened by Terra's own error, covers Terra (H ≥ 5) 0.59 / 0.70 of the time at 1° and 0.76 / 0.87 at stratum scale. Fused with `kappa` = 0: 0.898 (1°), 0.511 (stratum).

(b) MODIS weight of the production fusion (median over 1° cell-months; activity-weighted in brackets): 2012-2019 0.35 (0.39); 2020-2021 0.31 (0.32); 2022-2025 0.25 (0.27); 2026 0.23 (0.18). Global, by year: 2012 0.41, 2013 0.38, 2014 0.40, 2015 0.39, 2016 0.39, 2017 0.39, 2018 0.36, 2019 0.37, 2020 0.31, 2021 0.33, 2022 0.30, 2023 0.28, 2024 0.26, 2025 0.21, 2026 0.18.

**Table M11. Sensor tests** (`validation.json`: `noaa21_blind`, `closure`, `power_law`, `k_refit_2012_2019`). (a) NOAA-21 blind test, stratum-month.

| Year | bias vs MODIS | log-RMSE vs MODIS | bias vs drift-corrected MODIS | bias vs NOAA-20 | log-RMSE vs NOAA-20 | bias vs S-NPP |
| --- | --- | --- | --- | --- | --- | --- |
| 2023 (10 months) | +0.5 % | 0.444 | +0.2 % | +0.2 % | 0.153 | +0.7 % |
| 2024 (12 months) | +0.3 % | 0.503 | +0.1 % | -0.1 % | 0.181 | +2.5 % |
| 2025 (12 months) | +6.8 % | 0.560 | -0.6 % | -0.4 % | 0.182 | +0.1 % |
| 2026 (10 months) | +19.1 % | 0.613 | -0.4 % | -0.5 % | 0.162 | +0.0 % |

(b) Closure, NOAA-20 → MODIS, chain over direct: weighted mean log -0.0041, RMS 0.0244; out of sample (2020-2021, 1°) log-RMSE chain 0.6818, direct 0.6824; bias +0.5 % and +1.0 %.

(c) Power law, leave-one-year-out, no per-cell multiplier: 1° log-RMSE proportional 0.6450, power 0.6187; stratum-month 0.5012 and 0.4602. Selected `b` 1.00 to 1.20 (grid 0.6-1.5). For comparison, the per-cell multiplier lowers the proportional model's 1° error from 0.645 to 0.601 (Table M3).

(d) VIIRS-to-MODIS factor refitted on 2012-2019 instead of 2012-2021 (V-weighted): +0.32 % globally; by biome group, day / night: Tropical forests +0.2 / -0.3 %; Temperate forests -0.0 / -3.1 %; Boreal forest and tundra +0.0 / -6.4 %; Tropical savannas and grasslands +0.8 / +0.1 %; Temperate grasslands -0.2 / +2.6 %; Flooded and montane grasslands +0.4 / -3.7 %; Mediterranean +0.3 / +0.9 %; Deserts and xeric shrublands -0.7 / -0.0 %; Mangroves and unclassified +1.1 / +0.3 %.

## References

- Giglio, L., Schroeder, W., Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment* 178, 31-41. doi:10.1016/j.rse.2016.02.054
- Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. *Remote Sensing of Environment* 143, 85-96. doi:10.1016/j.rse.2013.12.008
- Dinerstein, E., Olson, D., Joshi, A., et al. (2017). An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm. *BioScience* 67(6), 534-545. doi:10.1093/biosci/bix014
- Chen, Y., Hall, J., van Wees, D., et al. (2023). Multi-decadal trends and variability in burned area from the fifth version of the Global Fire Emissions Database (GFED5). *Earth System Science Data* 15(11), 5227-5259. doi:10.5194/essd-15-5227-2023
- Giglio, L., Csiszar, I., Justice, C. O. (2006). Global distribution and seasonality of active fires as observed with the Terra and Aqua Moderate Resolution Imaging Spectroradiometer (MODIS) sensors. *Journal of Geophysical Research: Biogeosciences* 111, G02016. doi:10.1029/2005JG000142
- Archibald, S., Lehmann, C. E. R., Gómez-Dans, J. L., Bradstock, R. A. (2013). Defining pyromes and global syndromes of fire regimes. *PNAS* 110(16), 6442-6447. doi:10.1073/pnas.1211466110
- Benali, A., Mota, B., Carvalhais, N., et al. (2017). Bimodal fire regimes unveil a global-scale anthropogenic fingerprint. *Global Ecology and Biogeography* 26(7), 799-811. doi:10.1111/geb.12586
- Crameri, F. (2018). Scientific colour maps (romaO used here). Zenodo. doi:10.5281/zenodo.1243862 (MIT licence); Crameri, F., Shephard, G. E., Heron, P. J. (2020). The misuse of colour in science communication. *Nature Communications* 11, 5444. doi:10.1038/s41467-020-19160-7
- Andela, N., Morton, D. C., Giglio, L., et al. (2017). A human-driven decline in global burned area. *Science* 356(6345), 1356-1362. doi:10.1126/science.aal4108
- Zheng, B., Ciais, P., Chevallier, F., et al. (2021). Increasing forest fire emissions despite the decline in global burned area. *Science Advances* 7(39), eabh2646. doi:10.1126/sciadv.abh2646
- Jones, M. W., Abatzoglou, J. T., Veraverbeke, S., et al. (2022). Global and regional trends and drivers of fire under climate change. *Reviews of Geophysics* 60, e2020RG000726. doi:10.1029/2020RG000726
- Jones, M. W., Veraverbeke, S., Andela, N., et al. (2024). Global rise in forest fire emissions linked to climate change in the extratropics. *Science* 386, eadl5889. doi:10.1126/science.adl5889
- Wilks, D. S. (2016). "The stippling shows statistically significant grid points": How research results are routinely overstated and overinterpreted, and what to do about it. *Bulletin of the American Meteorological Society* 97(12), 2263-2273. doi:10.1175/BAMS-D-15-00267.1
- Benjamini, Y., Hochberg, Y. (1995). Controlling the false discovery rate: a practical and powerful approach to multiple testing. *Journal of the Royal Statistical Society B* 57(1), 289-300.
- van der Werf, G. R., Randerson, J. T., Giglio, L., et al. (2017). Global fire emissions estimates during 1997-2016. *Earth System Science Data* 9, 697-720. doi:10.5194/essd-9-697-2017
- Anscombe, F. J. (1948). The transformation of Poisson, binomial and negative-binomial data. *Biometrika* 35(3-4), 246-254. doi:10.1093/biomet/35.3-4.246
- Chander, G., et al. (2013). Overview of intercalibration of satellite instruments. *IEEE Transactions on Geoscience and Remote Sensing* 51, 1056-1080. doi:10.1109/TGRS.2012.2228654
- Chen, Y., et al. (2026). Tracking recent extremes and interannual variability of global fire emissions using a near-real-time extension. *Earth System Science Data* 18, 7535-7555. doi:10.5194/essd-18-7535-2026
- Gruber, A., et al. (2016). Recent advances in (soil moisture) triple collocation analysis. *International Journal of Applied Earth Observation and Geoinformation* 45, 200-211. doi:10.1016/j.jag.2015.09.002
- Gruber, A., et al. (2017). Triple collocation-based merging of satellite soil moisture retrievals. *IEEE Transactions on Geoscience and Remote Sensing* 55, 6780-6792. doi:10.1109/TGRS.2017.2734070
- Harvey, A. C., Fernandes, C. (1989). Time series models for count or qualitative observations. *Journal of Business & Economic Statistics* 7, 407-417. doi:10.1080/07350015.1989.10509750
- Kaiser, J. W., et al. (2012). Biomass burning emissions estimated with a global fire assimilation system based on observed fire radiative power. *Biogeosciences* 9, 527-554. doi:10.5194/bg-9-527-2012
- Kang, Y., et al. (2026). Comprehensive global fire radiative power evaluation by minimizing detection bias with intercomparison and extended triple collocation. *Remote Sensing of Environment* 333, 115136. doi:10.1016/j.rse.2025.115136
- Lei, J., et al. (2018). Distribution-free predictive inference for regression. *Journal of the American Statistical Association* 113, 1094-1111. doi:10.1080/01621459.2017.1307116
- McColl, K. A., et al. (2014). Extended triple collocation: estimating errors and correlation coefficients with respect to an unknown target. *Geophysical Research Letters* 41, 6229-6236. doi:10.1002/2014GL061322
- Schroeder, W., et al. (2008). Validation of GOES and MODIS active fire detection products using ASTER and ETM+ data. *Remote Sensing of Environment* 112, 2711-2726. doi:10.1016/j.rse.2008.01.005
- Singh, G., et al. (2024). Uncertainty quantification for probabilistic machine learning in earth observation using conformal prediction. *Scientific Reports* 14, 16166. doi:10.1038/s41598-024-65954-w
- Stoffelen, A. (1998). Toward the true near-surface wind speed: error modeling and calibration using triple collocation. *Journal of Geophysical Research: Oceans* 103, 7755-7766. doi:10.1029/97JC03180
- Pettitt, A. N. (1979). A non-parametric approach to the change-point problem. *Applied Statistics* 28(2), 126-135. doi:10.2307/2346729

Bibliographic details were checked against Crossref; for the 2026-11 additions the DOI, first author, year, title, journal, volume and pages were checked, and co-authors beyond the first are abbreviated where not checked. Vovk, Gammerman and Shafer (2005), *Algorithmic Learning in a Random World* (Springer), is cited without a DOI. Sen's slope estimator and the Mann-Kendall test are standard methods (Sen 1968; Mann 1945; Kendall 1975) and are not cited with details here.
