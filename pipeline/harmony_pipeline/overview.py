"""Compact global overview for the "Global fire pulse" view and the landing-map climatology.

Everything is an 8-bit grayscale PNG the browser decodes natively (written with zlib + struct):

- pulse/{year}.png  atlas 2880 x 1080 = 4 columns x 3 rows of months (Jan top-left, row-major), each month a
                    720 x 360 equirectangular image of 0.5 deg cells, row 0 = north, column 0 = 180 W.
- clim.png          same layout: per-cell median over CLIM_BASELINE years of each calendar month (zeros included).
- land.png          1440 x 720 land fraction (0..255, 2x2 supersampled) rasterised from the RESOLVE ecoregions.
- meta.json         cap, encoding, grid, years, month bounds, global monthly totals for the timeline sparkline.

Value x = harmonized AFCD-M in the 0.5 deg cell that month, day + night, all strata: MODIS-derived `meq` before
`default_switch_m`, calibrated VIIRS `kv` from it — read back from the dist L1 tiles (0.25 deg, 2x2 summed), so
the overview is exactly what the app computes. Encoding u = round(255 * min(1, sqrt(x / cap))), with u >= 1 for
any x > 0 so that faint activity is never lost; cap = 99.9th percentile of the non-zero cell-months.
Inputs: data/dist/meta.json + data/dist/tiles/L1 (+ the ecoregion shapefile for the land mask).
"""
from __future__ import annotations

import calendar
import json
import struct
import tempfile
import zlib
from pathlib import Path

import duckdb
import numpy as np

from .build_tiles import META, TILES
from .common import fresh, posix, timed, write_json
from .config import CLIM_BASELINE, DIST, MONTH0_YEAR

OUT = DIST / "overview"
PULSE = OUT / "pulse"
CELL = 0.5
W, H = 720, 360                 # one month
COLS, ROWS = 4, 3               # months per atlas
LAND_W, LAND_H = 1440, 720
CAP_Q = 99.9


def write_png(path: Path, img: np.ndarray) -> None:
    """8-bit grayscale PNG, filter 'Up' on every row (sparse fire rasters compress best that way)."""
    img = np.ascontiguousarray(img, dtype=np.uint8)
    h, w = img.shape
    up = img.copy()
    up[1:] -= img[:-1]                          # uint8 wrap-around = PNG filter 2 (Up)
    raw = np.empty((h, w + 1), np.uint8)
    raw[:, 0] = 2
    raw[0, 0] = 0                               # first row: no prior row; store it unfiltered
    raw[:, 1:] = up
    raw[0, 1:] = img[0]

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw.tobytes(), 9)) + chunk(b"IEND", b""))
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(png)
    tmp.replace(path)


def atlas(months: np.ndarray) -> np.ndarray:
    """(12, H, W) -> (ROWS*H, COLS*W) with January top-left."""
    return months.reshape(ROWS, COLS, H, W).transpose(0, 2, 1, 3).reshape(ROWS * H, COLS * W)


def encode(x: np.ndarray, cap: float) -> np.ndarray:
    u = np.round(255 * np.sqrt(np.minimum(1.0, x / cap)))
    return np.where(x > 0, np.maximum(u, 1), 0).astype(np.uint8)


def served_stream(meta: dict) -> tuple[list[int], np.ndarray]:
    """Months served from MODIS `meq` (the rest use calibrated VIIRS `kv`) and the coverage of the served stream,
    indexed by absolute month m (same fallback rule as the browser kernel)."""
    m0, m1, sw = meta["m_first"], meta["m_last"], meta["default_switch_m"]
    cov_v, cov_m = meta["months"]["cov_viirs"], meta["months"]["cov_modis"]
    use_meq = [m for m in range(m0, m1 + 1)
               if (m < sw and cov_m[m] > 0) or (m >= sw and cov_v[m] <= 0 and cov_m[m] > 0) or (m < sw and cov_v[m] <= 0)]
    meq = set(use_meq)
    cov = np.zeros(m1 + 1)
    for m in range(m0, m1 + 1):
        cov[m] = cov_m[m] if m in meq else cov_v[m]
    return use_meq, cov


def load_grid(meta: dict, modis_only: bool = False):
    """Harmonized AFCD-M as float32 (n_months, H, W), rows north-first, months m_first..m_last.
    With `modis_only`, also the MODIS-derived stream `meq` for every month (the seam test of the trend map)."""
    m0, m1 = meta["m_first"], meta["m_last"]
    # Same fallback as the browser kernel: a month the preferred stream does not cover uses the other one.
    use_meq, _ = served_stream(meta)
    meq_months = ",".join(map(str, use_meq)) or "-1"
    with tempfile.TemporaryDirectory() as tmp:  # private spill dir: never share data/work/tmp with other jobs
        con = duckdb.connect()
        con.execute(f"SET memory_limit='8GB'; SET threads=8; SET temp_directory='{posix(tmp)}'")
        # L1 cell = iy * 1440 + ix at 0.25 deg; 0.5 deg cell (ix // 2, iy // 2)
        df = con.execute(f"""
            SELECT ((cell % 1440) // 2)::INT AS x, (359 - (cell // 1440) // 2)::INT AS y, m::INT AS m,
                   sum(CASE WHEN m IN ({meq_months}) THEN meq ELSE kv END) / 100.0 AS h,
                   sum(meq) / 100.0 AS hm
            FROM read_parquet('{posix(TILES)}/L1/*.parquet')
            WHERE m BETWEEN {m0} AND {m1}
            GROUP BY ALL HAVING h > 0 OR hm > 0""").fetchnumpy()
        con.close()
    grid = np.zeros((m1 - m0 + 1, H, W), np.float32)
    grid[df["m"] - m0, df["y"], df["x"]] = df["h"]
    if not modis_only:
        return grid
    gm = np.zeros_like(grid)
    gm[df["m"] - m0, df["y"], df["x"]] = df["hm"]
    return grid, gm


def land_mask() -> np.ndarray:
    """Land fraction on a 1440 x 720 grid (row 0 = north) from the RESOLVE ecoregion polygons."""
    import shapely
    from .strata import SHP, ensure_shapefile

    ensure_shapefile()
    con = duckdb.connect()
    con.execute("LOAD spatial")
    wkb = [r[0] for r in con.execute(f"""SELECT ST_AsWKB(ST_SimplifyPreserveTopology(geom, 0.02))
                                         FROM ST_Read('{posix(SHP)}') WHERE geom IS NOT NULL""").fetchall()]
    con.close()
    geoms = shapely.from_wkb([bytes(b) for b in wkb])
    ss = 2                                         # 2 x 2 samples per output pixel
    sw, sh = LAND_W * ss, LAND_H * ss
    d = 360 / sw
    xs = -180 + (np.arange(sw) + 0.5) * d
    ys = 90 - (np.arange(sh) + 0.5) * d
    hit = np.zeros((sh, sw), bool)
    for g in geoms:
        if g is None or g.is_empty:
            continue
        shapely.prepare(g)
        x0, y0, x1, y1 = g.bounds
        cx = np.nonzero((xs >= x0) & (xs <= x1))[0]
        cy = np.nonzero((ys >= y0) & (ys <= y1))[0]
        if not len(cx) or not len(cy):
            continue
        gx, gy = np.meshgrid(xs[cx], ys[cy])
        inside = shapely.contains_xy(g, gx, gy)
        hit[cy[0]:cy[-1] + 1, cx[0]:cx[-1] + 1] |= inside
    frac = hit.reshape(LAND_H, ss, LAND_W, ss).mean(axis=(1, 3))
    return np.round(frac * 255).astype(np.uint8)


# ---------------------------------------------------------------------------------------------------------------
# Fire regime: season timing ("fire clock") and the 2001–2025 trend across the MODIS -> VIIRS hand-over.

SEASON_SHARE = 0.8              # season length = shortest run of consecutive months holding 80 % of the annual total
BIMODAL_MIN = 20.0              # pooled (3 x 3) mean AFCD-M / yr needed before a second season is looked for
BIMODAL_RATIO = 0.15            # second peak >= 0.15 x main peak (pooled cycle) ...
BIMODAL_DIP = 0.5               # ... separated by >= 3 months, with troughs <= 0.5 x second peak on both arcs
TREND_YEARS = (2001, 2025)
TREND_MIN = 10.0                # pooled baseline mean AFCD-M / yr for a trend to be estimated
TREND_MIN_YEARS = 18            # complete years required
TREND_MIN_NONZERO = 8           # pooled years with any activity required
TREND_RANGE = 10.0              # %/yr mapped to the ends of the 8-bit code
FDR_Q = 0.05                    # Benjamini–Hochberg false-discovery rate across cells
COV_OK = 0.5                    # a year is complete if every month's served-stream coverage >= this

# Broad GFED-style basis regions as simple lat/lon boxes (first match wins): approximations of the GFED regions
# (van der Werf et al. 2017), used only for the validation summary in meta.json.
REGIONS = [
    ("BONA", "Boreal North America", (-170, 49, -50, 75)),
    ("TENA", "Temperate North America", (-130, 30, -60, 49)),
    ("CEAM", "Central America", (-120, 8, -60, 30)),
    ("NHSA", "Northern Hemisphere South America", (-82, 0, -34, 13)),
    ("SHSA", "Southern Hemisphere South America", (-82, -56, -34, 0)),
    ("EURO", "Europe", (-11, 36, 42, 72)),
    ("MIDE", "Middle East and North Africa", (-18, 18, 63, 42)),
    ("NHAF", "Northern Hemisphere Africa", (-18, 0, 52, 18)),
    ("SHAF", "Southern Hemisphere Africa", (8, -35, 52, 0)),
    ("BOAS", "Boreal Asia", (42, 50, 180, 78)),
    ("CEAS", "Central Asia", (42, 30, 150, 50)),
    ("SEAS", "Southeast Asia", (63, 8, 125, 30)),
    ("EQAS", "Equatorial Asia", (94, -11, 160, 8)),
    ("AUST", "Australia and New Zealand", (110, -50, 180, -11)),
]


# Smaller boxes for published regional trend signs (expected: -1 falling, +1 rising, 0 = artefact watch).
CHECKS = [
    ("Sahel-Sudan savanna", (-15, 5, 35, 15), -1, "Andela et al. 2017"),
    ("Cerrado", (-55, -20, -42, -5), -1, "Andela et al. 2017"),
    ("Kazakh steppe", (50, 45, 85, 55), -1, "Andela et al. 2017"),
    ("Eastern China cropland", (112, 30, 122, 40), -1, "Andela et al. 2017"),
    ("East Siberian taiga", (100, 60, 160, 72), 1, "Zheng et al. 2021; Jones et al. 2022"),
    ("Canadian boreal", (-140, 50, -60, 70), 1, "Jones et al. 2022; Jones et al. 2024"),
    ("Western US", (-125, 32, -104, 49), 1, "Jones et al. 2022"),
    ("Punjab-Haryana", (73.5, 29, 77.5, 32.5), 0, "MODIS orbit-drift / overpass-time artefact zone"),
]


def cell_centres() -> tuple[np.ndarray, np.ndarray]:
    return -180 + (np.arange(W) + 0.5) * CELL, 90 - (np.arange(H) + 0.5) * CELL


def region_grid() -> np.ndarray:
    """(H, W) region index into REGIONS, -1 = none."""
    lon, lat = cell_centres()
    gx, gy = np.meshgrid(lon, lat)
    out = np.full((H, W), -1, np.int8)
    for i, (_, _, (x0, y0, x1, y1)) in reversed(list(enumerate(REGIONS))):     # reversed: first listed wins
        out[(gx >= x0) & (gx < x1) & (gy >= y0) & (gy < y1)] = i
    return out


def box3(a: np.ndarray) -> np.ndarray:
    """3 x 3 moving sum over the last two axes (longitude wraps, latitude edges padded with zeros)."""
    pad = [(0, 0)] * (a.ndim - 2) + [(1, 1), (0, 0)]
    p = np.pad(a, pad)
    p = np.concatenate([p[..., -1:], p, p[..., :1]], -1)
    out = np.zeros_like(a)
    for dy in range(3):
        for dx in range(3):
            out += p[..., dy:dy + a.shape[-2], dx:dx + a.shape[-1]]
    return out


def mean_cycle(grid: np.ndarray, m0: int) -> np.ndarray:
    """Mean of each calendar month over CLIM_BASELINE, (12, H, W) float64."""
    idx = np.arange(m0, m0 + len(grid))
    years = MONTH0_YEAR + idx // 12
    mon = np.zeros((12, H, W), np.float64)
    for k in range(12):
        sel = (idx % 12 == k) & (years >= CLIM_BASELINE[0]) & (years <= CLIM_BASELINE[1])
        mon[k] = grid[sel].mean(axis=0)
    return mon


def season_fields(grid: np.ndarray, m0: int) -> dict[str, np.ndarray]:
    """Fire clock per 0.5 deg cell from the mean seasonal cycle over CLIM_BASELINE.

    The mean (not the median of clim.png) is used: episodic regimes (boreal forest, where a cell burns in a few
    years only) have zero medians in every month but a well-defined season.
    - peak: calendar month with the largest mean activity (0..11) - the colour
    - r: concentration = resultant length of the circular mean of the 12 monthly values (0 spread, 1 one month)
    - length: shortest run of consecutive months holding SEASON_SHARE of the annual total
    - peak2: second season (0..11, -1 none), tested on the 3 x 3-pooled cycle
    """
    mon = mean_cycle(grid, m0)
    tot = mon.sum(0)
    ang = 2 * np.pi * np.arange(12) / 12
    safe = np.where(tot > 0, tot, 1)
    r = np.hypot(np.tensordot(np.cos(ang), mon, 1), np.tensordot(np.sin(ang), mon, 1)) / safe
    peak = mon.argmax(0)
    ext = np.concatenate([mon, mon], 0)
    csum = np.concatenate([np.zeros((1, H, W)), np.cumsum(ext, 0)], 0)
    length = np.full((H, W), 12, np.int16)
    for L in range(11, 0, -1):
        best = np.max([csum[s + L] - csum[s] for s in range(12)], axis=0)
        length[best >= SEASON_SHARE * tot * (1 - 1e-9)] = L

    # second season
    c = box3(mon)
    s = c
    p1 = s.argmax(0)
    v1 = np.take_along_axis(s, p1[None], 0)[0]
    ismax = (s > np.roll(s, 1, 0)) & (s >= np.roll(s, -1, 0))
    k = np.arange(12)[:, None, None]
    dist = np.abs(k - p1[None])
    dist = np.minimum(dist, 12 - dist)
    cand = np.where(ismax & (dist >= 3), s, -1.0)
    p2 = cand.argmax(0)
    v2 = np.take_along_axis(cand, p2[None], 0)[0]
    fwd = (p2 - p1) % 12                                         # months from p1 forward to p2
    dmin_f = np.full((H, W), np.inf)
    dmin_b = np.full((H, W), np.inf)
    for d in range(1, 12):
        val = np.take_along_axis(s, ((p1 + d) % 12)[None], 0)[0]
        dmin_f = np.where(d < fwd, np.minimum(dmin_f, val), dmin_f)
        dmin_b = np.where(d > fwd, np.minimum(dmin_b, val), dmin_b)
    bimodal = ((c.sum(0) >= BIMODAL_MIN) & (v2 >= BIMODAL_RATIO * v1)
               & (dmin_f <= BIMODAL_DIP * v2) & (dmin_b <= BIMODAL_DIP * v2))
    # report the season that is not the colour's month (the pooled main peak can differ from the cell's peak)
    other = np.where(np.minimum((p1 - peak) % 12, (peak - p1) % 12) <= 1, p2, p1)
    d_other = np.minimum((other - peak) % 12, (peak - other) % 12)
    peak2 = np.where(bimodal & (d_other >= 3) & (tot > 0), other, -1)
    return {"mon": mon, "tot": tot, "r": r, "peak": peak, "length": length, "peak2": peak2}


def theil_sen_mk(x: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Row-wise Theil–Sen slope and two-sided Mann–Kendall p-value (normal approximation, tie and continuity
    corrected; serial correlation is not modelled). x: (n_series, n_years), t: (n_years,)."""
    from scipy.stats import norm

    n = x.shape[1]
    i, j = np.triu_indices(n, 1)
    d = x[:, j] - x[:, i]
    slope = np.median(d / (t[j] - t[i]), axis=1)
    s = np.sign(d).sum(1)
    ties = (x[:, :, None] == x[:, None, :]).sum(2)              # size of each value's tie group
    tie_term = ((ties - 1) * (2 * ties + 5)).sum(1)             # = sum over groups of g(g-1)(2g+5)
    var = (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0
    z = np.where(s > 0, s - 1, np.where(s < 0, s + 1, 0)) / np.sqrt(np.maximum(var, 1e-9))
    return slope, 2 * norm.sf(np.abs(z))


def bh_fdr(p: np.ndarray, q: float) -> np.ndarray:
    """Benjamini–Hochberg: boolean mask of discoveries at false-discovery rate q (Wilks 2016)."""
    n = p.size
    if not n:
        return np.zeros(0, bool)
    order = np.argsort(p)
    ok = p[order] <= q * np.arange(1, n + 1) / n
    out = np.zeros(n, bool)
    if ok.any():
        out[order[:np.nonzero(ok)[0].max() + 1]] = True
    return out


def complete_years(meta: dict, cov: np.ndarray, y0: int, y1: int) -> list[int]:
    m0, m1 = meta["m_first"], meta["m_last"]
    out = []
    for y in range(y0, y1 + 1):
        ms = [(y - MONTH0_YEAR) * 12 + k for k in range(12)]
        if ms[0] >= m0 and ms[-1] <= m1 and all(cov[m] >= COV_OK for m in ms):
            out.append(y)
    return out


def annual(grid: np.ndarray, m0: int, years: list[int]) -> np.ndarray:
    return np.array([grid[(y - MONTH0_YEAR) * 12 - m0:(y - MONTH0_YEAR) * 12 - m0 + 12].sum(0, dtype=np.float64)
                     for y in years])


def cell_trends(ann: np.ndarray, t: np.ndarray) -> dict:
    """Trend per 0.5 deg cell, estimated on the 3 x 3 (1.5 deg) pooled annual totals for robustness."""
    pooled = box3(ann)
    bsel = (t >= CLIM_BASELINE[0]) & (t <= CLIM_BASELINE[1])
    base = pooled[bsel].mean(0)
    valid = (base >= TREND_MIN) & ((pooled > 0).sum(0) >= TREND_MIN_NONZERO) & (len(t) >= TREND_MIN_YEARS)
    pct = np.zeros((H, W))
    p = np.ones((H, W))
    iy, ix = np.nonzero(valid)
    for a in range(0, len(iy), 10000):                          # chunks keep the pairwise arrays small
        sl = slice(a, a + 10000)
        slope, pv = theil_sen_mk(pooled[:, iy[sl], ix[sl]].T, t)
        pct[iy[sl], ix[sl]] = 100 * slope / base[iy[sl], ix[sl]]
        p[iy[sl], ix[sl]] = pv
    sig = np.zeros((H, W), bool)
    sig[valid] = bh_fdr(p[valid], FDR_Q)
    return {"valid": valid, "pct": pct, "p": p, "sig": sig, "base": base}


def series_trend(series: np.ndarray, t: np.ndarray) -> dict:
    bsel = (t >= CLIM_BASELINE[0]) & (t <= CLIM_BASELINE[1])
    slope, p = theil_sen_mk(series[None, :], t)
    base = series[bsel].mean() if bsel.any() else series.mean()
    return {"pct_per_yr": round(float(100 * slope[0] / base), 2) if base > 0 else None, "p": round(float(p[0]), 4),
            "years": [int(t[0]), int(t[-1])], "n_years": int(len(t))}


def agreement(a: dict, b: dict, mask: np.ndarray, area: np.ndarray) -> dict:
    """Area-weighted sign agreement and correlation of two cell-trend fields where both are valid."""
    v = mask & a["valid"] & b["valid"]
    if v.sum() < 3:
        return {"cells": int(v.sum())}
    w = area[v]
    x, y = a["pct"][v], b["pct"][v]
    return {"cells": int(v.sum()),
            "sign_agreement": round(float((w * (np.sign(x) == np.sign(y))).sum() / w.sum()), 3),
            "slope_correlation": round(float(np.corrcoef(x, y)[0, 1]), 3)}


def trend_analysis(grid: np.ndarray, grid_meq: np.ndarray, meta: dict) -> dict:
    m0, sw = meta["m_first"], meta["default_switch_m"]
    _, cov = served_stream(meta)
    years = complete_years(meta, cov, *TREND_YEARS)
    cov_m = np.asarray(meta["months"]["cov_modis"], float)
    years_m = complete_years(meta, cov_m, *TREND_YEARS)
    t, tm = np.array(years, float), np.array(years_m, float)
    ann, ann_m = annual(grid, m0, years), annual(grid_meq, m0, years_m)
    tr, trm = cell_trends(ann, t), cell_trends(ann_m, tm)

    lon, lat = cell_centres()
    area = np.repeat(np.cos(np.radians(lat))[:, None], W, 1)
    reg = region_grid()
    switch_year = MONTH0_YEAR + sw // 12
    regions = []
    for i, (code, name, _) in enumerate(REGIONS):
        inr = reg == i
        v = inr & tr["valid"]
        w = area[v]
        wsum = max(float(w.sum()), 1e-9)
        mean = float((tr["pct"][v] * w).sum() / wsum) if v.any() else None
        tot = ann[:, inr].sum(1)
        st = series_trend(tot, t)
        regions.append({
            "code": code, "name": name, "box": list(REGIONS[i][2]),
            "cell_mean_pct_per_yr": round(mean, 2) if mean is not None else None,
            "sign": 0 if mean is None or abs(mean) < 0.25 else int(np.sign(mean)),
            "share_falling_sig": round(float((w * (tr["sig"][v] & (tr["pct"][v] < 0))).sum() / wsum), 3),
            "share_rising_sig": round(float((w * (tr["sig"][v] & (tr["pct"][v] > 0))).sum() / wsum), 3),
            "total_pct_per_yr": st["pct_per_yr"], "total_p": st["p"],
            "total_pct_per_yr_modis_only": series_trend(ann_m[:, inr].sum(1), tm)["pct_per_yr"],
            "baseline_afcd_per_yr": round(float(tot[(t >= CLIM_BASELINE[0]) & (t <= CLIM_BASELINE[1])].mean())),
            "vs_modis_only": agreement(tr, trm, inr, area),
        })
    lon_g, lat_g = np.meshgrid(lon, lat)
    checks = []
    for name, (x0, y0, x1, y1), expect, src in CHECKS:
        inb = (lon_g >= x0) & (lon_g < x1) & (lat_g >= y0) & (lat_g < y1)
        st = series_trend(ann[:, inb].sum(1), t)
        checks.append({"name": name, "box": [x0, y0, x1, y1], "expected_sign": expect, "source": src,
                       "total_pct_per_yr": st["pct_per_yr"], "total_p": st["p"],
                       "total_pct_per_yr_without_viirs_years": series_trend(ann[t < switch_year][:, inb].sum(1),
                                                                            t[t < switch_year])["pct_per_yr"],
                       "total_pct_per_yr_modis_only": series_trend(ann_m[:, inb].sum(1), tm)["pct_per_yr"]})
    glob, glob_m = ann.reshape(len(t), -1).sum(1), ann_m.reshape(len(tm), -1).sum(1)
    pre = t < switch_year
    overlap = [y for y in years if y >= switch_year and y in years_m]
    summary = {
        "years": years, "years_modis_only": years_m, "switch_year": switch_year,
        "min_baseline_afcd_per_yr": TREND_MIN, "pooling": "3 x 3 cells (1.5 deg moving window)",
        "significance": f"Mann-Kendall, Benjamini-Hochberg FDR q = {FDR_Q} across {int(tr['valid'].sum())} cells",
        "share_valid_cells_sig": round(float(tr["sig"].sum() / max(tr["valid"].sum(), 1)), 3),
        "global": {
            "all_years": series_trend(glob, t),
            "without_viirs_years": series_trend(glob[pre], t[pre]),
            "modis_only_all_years": series_trend(glob_m, tm),
            "annual_totals": {int(y): round(float(v)) for y, v in zip(t, glob)},
            "annual_totals_modis_only": {int(y): round(float(v)) for y, v in zip(tm, glob_m)},
            # seam check: harmonized (calibrated VIIRS) / MODIS-only in the years served from VIIRS
            "harmonized_over_modis_after_switch": {
                int(y): round(float(glob[years.index(y)] / glob_m[years_m.index(y)]), 3) for y in overlap},
        },
        "vs_modis_only": agreement(tr, trm, np.ones((H, W), bool), area),
        "regions": regions,
        "checks": checks,
    }
    return {"tr": tr, "trm": trm, "ann": ann, "t": t, "summary": summary}


def u8_signed(x: np.ndarray, lim: float) -> np.ndarray:
    """[-lim, lim] -> 1..255 with 128 = 0 (0 is reserved for 'no value')."""
    return (128 + np.round(127 * np.clip(x / lim, -1, 1))).astype(np.uint8)


def season_png(sf: dict) -> tuple[np.ndarray, float]:
    """7 layers stacked vertically (720 x 2520), see the data contract."""
    tot = sf["tot"]
    pos = tot[tot > 0]
    cap = max(1.0, float(np.percentile(pos, CAP_Q))) if pos.size else 1.0
    has = tot > 0
    ang = 2 * np.pi * sf["peak"] / 12
    layers = [
        np.where(has, u8_signed(np.cos(ang), 1.0), 128),         # 0 peak-month unit vector x (cos)
        np.where(has, u8_signed(np.sin(ang), 1.0), 128),         # 1 peak-month unit vector y (sin)
        np.where(has, np.round(255 * sf["r"]), 0),              # 2 concentration x 255
        encode(tot.astype(np.float32), cap),                     # 3 mean annual activity, sqrt code vs season cap
        np.where(has, sf["peak"] + 1, 0),                        # 4 peak month 1..12
        np.where(sf["peak2"] >= 0, sf["peak2"] + 1, 0),          # 5 second season 1..12, 0 = none
        np.where(has, sf["length"], 0),                          # 6 season length in months
    ]
    return np.concatenate([np.clip(layer, 0, 255).astype(np.uint8) for layer in layers], 0), cap


def trend_png(ta: dict, cap: float) -> np.ndarray:
    """5 layers stacked vertically (720 x 1800), see the data contract."""
    tr, trm = ta["tr"], ta["trm"]
    v = tr["valid"]
    bsel = (ta["t"] >= CLIM_BASELINE[0]) & (ta["t"] <= CLIM_BASELINE[1])
    base_cell = ta["ann"][bsel].mean(0)
    layers = [
        np.where(v, u8_signed(tr["pct"], TREND_RANGE), 0),       # 0 trend %/yr, 128 = 0, 0 = no estimate
        np.where(v, 1 + np.round(254 * (1 - tr["p"])), 0),       # 1 Mann-Kendall p: 1 + 254 (1 - p)
        np.where(v, np.where(tr["sig"], 2, 1), 0),               # 2 0 none, 1 estimated, 2 significant after FDR
        encode(base_cell.astype(np.float32), cap),               # 3 baseline mean annual activity of the cell
        np.where(trm["valid"], u8_signed(trm["pct"], TREND_RANGE), 0),  # 4 MODIS-only trend, same code
    ]
    return np.concatenate([np.clip(layer, 0, 255).astype(np.uint8) for layer in layers], 0)


def main(force: bool = False) -> None:
    deps = [META, TILES / "index.json"]
    if not force and fresh(OUT / "meta.json", deps) and (OUT / "land.png").exists():
        print("[overview] up to date")
        return
    meta = json.loads(META.read_text())
    m0, m1 = meta["m_first"], meta["m_last"]
    PULSE.mkdir(parents=True, exist_ok=True)
    written: set[Path] = set()
    with timed("overview"):
        grid, grid_meq = load_grid(meta, modis_only=True)
        pos = grid[grid > 0]
        cap = float(np.percentile(pos, CAP_Q)) if pos.size else 1.0
        cap = max(cap, 1.0)

        y_first, y_last = MONTH0_YEAR + m0 // 12, MONTH0_YEAR + m1 // 12
        for year in range(y_first, y_last + 1):
            months = np.zeros((12, H, W), np.float32)
            for k in range(12):
                m = (year - MONTH0_YEAR) * 12 + k
                if m0 <= m <= m1:
                    months[k] = grid[m - m0]
            p = PULSE / f"{year}.png"
            write_png(p, atlas(encode(months, cap)))
            written.add(p)

        idx = np.arange(m0, m1 + 1)
        years = MONTH0_YEAR + idx // 12
        clim = np.zeros((12, H, W), np.float32)
        for k in range(12):
            sel = (idx % 12 == k) & (years >= CLIM_BASELINE[0]) & (years <= CLIM_BASELINE[1])
            if sel.any():
                clim[k] = np.median(grid[sel], axis=0)
        write_png(OUT / "clim.png", atlas(encode(clim, cap)))
        written.add(OUT / "clim.png")

        sf = season_fields(grid, m0)
        season, season_cap = season_png(sf)
        write_png(OUT / "season.png", season)
        written.add(OUT / "season.png")
        ta = trend_analysis(grid, grid_meq, meta)
        del grid_meq
        trend_cap = max(1.0, float(np.percentile(ta["ann"][ta["ann"] > 0], CAP_Q)))
        write_png(OUT / "trend.png", trend_png(ta, trend_cap))
        written.add(OUT / "trend.png")
        active = sf["tot"] >= 1

        from .strata import SHP
        if not fresh(OUT / "land.png", [SHP]):     # static: rebuilt only when the ecoregion layer changes
            with timed("overview land mask"):
                write_png(OUT / "land.png", land_mask())
        written.add(OUT / "land.png")

        totals = grid.reshape(len(grid), -1).sum(1, dtype=np.float64)
        through = meta["data_through"]
        yy, mm, dd = (int(v) for v in through.split("-"))
        last_partial = dd < calendar.monthrange(yy, mm)[1] and (yy - MONTH0_YEAR) * 12 + mm - 1 == m1
        write_json(OUT / "meta.json", {
            "version": 3,
            "generated": meta.get("generated"),
            "data_through": through,
            "scope": meta.get("method", {}).get("scope", "global"),
            "value": "harmonized AFCD-M per 0.5 deg cell per month, day + night "
                     "(MODIS-derived meq before default_switch_m, calibrated VIIRS kv from it)",
            "cap": round(cap, 4),
            "cap_quantile": CAP_Q,
            "encoding": "u = round(255 * min(1, sqrt(x / cap))), u >= 1 where x > 0; decode x = cap * (u / 255)^2",
            "grid": {"cell_deg": CELL, "width": W, "height": H, "row0": "north (90 N)", "col0": "180 W"},
            "atlas": {"cols": COLS, "rows": ROWS, "order": "row-major, January top-left",
                      "width": COLS * W, "height": ROWS * H},
            "pulse": "pulse/{year}.png",
            "years": [y_first, y_last],
            "m_first": m0, "m_last": m1, "last_month_partial": bool(last_partial),
            "m_last_data": int(m0 + np.nonzero(totals > 0)[0].max()) if (totals > 0).any() else m0,
            "default_switch_m": meta["default_switch_m"],
            "clim": {"file": "clim.png", "baseline": list(CLIM_BASELINE), "stat": "median incl. zero months"},
            "season": {
                "file": "season.png", "baseline": list(CLIM_BASELINE), "layers": 7, "cap": round(season_cap, 2),
                "stat": "mean of each calendar month over the baseline (episodic regimes have zero medians)",
                "share": SEASON_SHARE,
                "bimodal": {"min_pooled_afcd_per_yr": BIMODAL_MIN, "ratio": BIMODAL_RATIO, "dip": BIMODAL_DIP,
                            "share_of_active_cells": round(float((sf["peak2"][active] >= 0).mean()), 3)},
            },
            "trend": {
                "file": "trend.png", "layers": 5, "range_pct_per_yr": TREND_RANGE, "cap": round(trend_cap, 2),
                **ta["summary"],
            },
            "land": {"file": "land.png", "width": LAND_W, "height": LAND_H,
                     "value": "land fraction x 255 (RESOLVE Ecoregions 2017, 2 x 2 supersampled)"},
            "global_monthly": [round(float(v), 1) for v in totals],
        })
        written.add(OUT / "meta.json")

        # Drop anything else (older f32/u16 outputs, years no longer in the record).
        for p in sorted(OUT.rglob("*"), reverse=True):
            if p.is_file() and p not in written:
                p.unlink()
            elif p.is_dir() and p != PULSE and not any(p.iterdir()):
                p.rmdir()
        size = sum(p.stat().st_size for p in written)
        print(f"  cap {cap:.1f} AFCD-M, {len(pos):,} non-zero cell-months, {y_last - y_first + 1} atlases, "
              f"{size / 1e6:.1f} MB total")
