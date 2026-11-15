"""Watchlist: where is fire unusual this month? -> data/dist/watch.json (schema/watch.md).

For the latest month whose served-stream coverage is >= COV_OK (and, separately, the three-month window ending
there) every 0.5 deg cell is compared with the same calendar month(s) in the CLIM_BASELINE years of the harmonized
record. Cells with meaningful activity that exceed the 90th baseline percentile and twice the baseline median are
grouped into 8-connected clusters; clusters are ranked by excess activity (sum of value - baseline median) and the
top N are described at cluster level: the cluster's own 26-year series for that month (window) gives the ratio to
normal, the baseline percentile and the rank among all years of the record.

Inputs: data/dist/meta.json + data/dist/tiles/L1 only (same reader as the overview stage).
  uv run python -m harmony_pipeline.cli watch [--force]
  uv run python -m harmony_pipeline.cli watch --month 2023-06     # historical check -> data/work/watch/
"""
from __future__ import annotations

import json
import math
import tempfile
from datetime import datetime, timezone

import duckdb
import numpy as np

from .build_tiles import META, TILES
from .common import fresh, posix, timed, write_json
from .config import CLIM_BASELINE, DIST, MONTH0_YEAR, WORK
from .overview import CELL, H, REGIONS, W, cell_centres, load_grid, served_stream

OUT = DIST / "watch.json"
HIST = WORK / "watch"
COV_OK = 0.5
MIN_CELL = 5.0            # AFCD-M per 0.5 deg cell in the month (window) for a cell to be considered
MIN_PCT = 90.0            # cell must be at or above this empirical percentile of its baseline years
MIN_RATIO = 2.0           # ... and at least this multiple of its baseline median
MEDIAN_FLOOR = 1.0        # AFCD-M per cell: ratios use max(median, floor x cells) so empty baselines stay finite
TOP_N = 15
R_EARTH = 6371.0088

# Broad regions for human labels, first match wins (lon0, lat0, lon1, lat1). Modest on purpose: these name the
# general area a cluster lies in, not a place.
GAZETTEER = [
    (-170, 55, -141, 72, "Alaska"),
    (-141, 60, -100, 72, "Yukon and Northwest Territories"),
    (-125, 49, -110, 60, "British Columbia and Alberta"),
    (-110, 49, -95, 61, "Saskatchewan and Manitoba"),
    (-80, 45, -55, 63, "Quebec and Labrador"),
    (-95, 42, -80, 57, "Ontario"),
    (-125, 32, -114, 49, "Pacific US West"),
    (-114, 31, -102, 49, "US Interior West"),
    (-102, 25, -90, 49, "US Great Plains"),
    (-90, 24, -75, 37, "US Southeast"),
    (-90, 37, -66, 49, "US Midwest and Northeast"),
    (-118, 14, -86, 32, "Mexico"),
    (-92, 7, -77, 18, "Central America"),
    (-85, 17, -60, 27, "Caribbean"),
    (-75, 2, -60, 10, "Llanos (Colombia-Venezuela)"),
    (-82, 0, -50, 13, "Northern South America"),
    (-58.5, -22, -55, -16, "Pantanal"),
    (-65, -13, -45, -5, "Southern Amazon - arc of deforestation"),
    (-55, -20, -41, -5, "Cerrado"),
    (-48, -18, -34, -2, "Northeast Brazil"),
    (-66, -19, -57, -12, "Bolivian lowlands"),
    (-65, -28, -57, -19, "Gran Chaco"),
    (-75, -12, -48, 2, "Amazon basin"),
    (-82, -20, -65, 0, "Andes and western Amazon"),
    (-58, -35, -40, -20, "Southern Brazil, Paraguay and Uruguay"),
    (-76, -56, -53, -20, "Southern Cone (Argentina-Chile)"),
    (-18, 8, 16, 18, "West African Sahel and Sudan savanna"),
    (16, 3, 33, 15, "Central African savanna (CAR-South Sudan)"),
    (-18, 3, 16, 8, "West African Guinea savanna"),
    (33, 3, 52, 18, "Ethiopia and the Horn of Africa"),
    (8, -5, 28, 3, "Congo basin"),
    (11, -18, 24, -5, "Southern Africa - Angola miombo"),
    (24, -18, 36, -5, "Southern Africa - miombo belt"),
    (28, -5, 42, 3, "East Africa"),
    (36, -27, 42, -10, "Mozambique coast"),
    (43, -26, 51, -12, "Madagascar"),
    (12, -35, 36, -18, "Southern Africa - savanna and highveld"),
    (-18, 18, 35, 37, "North Africa"),
    (-10, 35, 4, 44, "Iberian Peninsula"),
    (26, 36, 45, 42, "Turkey"),
    (4, 36, 30, 46, "Mediterranean Europe"),
    (22, 44, 42, 53, "Ukraine and southern Russia"),
    (-11, 46, 30, 72, "Central and northern Europe"),
    (30, 50, 60, 72, "European Russia"),
    (34, 12, 63, 42, "Middle East"),
    (72, 28, 78, 33, "Punjab-Haryana (India-Pakistan)"),
    (60, 23, 78, 37, "Pakistan and Afghanistan"),
    (88, 20, 98, 29, "Northeast India and Bangladesh"),
    (68, 6, 90, 30, "India"),
    (92, 9, 110, 24, "Mainland Southeast Asia"),
    (95, -6, 106, 6, "Sumatra and Malay Peninsula"),
    (108, -4.5, 119.5, 7.5, "Borneo"),
    (117, 5, 127, 20, "Philippines"),
    (130, -11, 156, 0, "New Guinea"),
    (95, -11, 141, 8, "Maritime Southeast Asia"),
    (120, 46, 142, 56, "Amur and Russian Far East"),
    (50, 40, 90, 56, "Kazakh steppe and Central Asia"),
    (90, 40, 125, 53, "Mongolia and northern China"),
    (100, 18, 125, 42, "Eastern China"),
    (125, 30, 146, 46, "Korea and Japan"),
    (60, 55, 90, 75, "Western Siberia"),
    (90, 50, 115, 75, "Central Siberia"),
    (115, 56, 180, 75, "Yakutia and East Siberia"),
    (112, -23, 154, -10, "Northern Australia savanna"),
    (140, -44, 155, -28, "South-east Australia"),
    (112, -36, 125, -23, "Western Australia"),
    (125, -36, 140, -23, "Central and southern Australia"),
    (165, -48, 180, -34, "New Zealand"),
]


def place(lon: float, lat: float) -> str:
    for x0, y0, x1, y1, name in GAZETTEER:
        if x0 <= lon < x1 and y0 <= lat < y1:
            return name
    for _, name, (x0, y0, x1, y1) in REGIONS:
        if x0 <= lon < x1 and y0 <= lat < y1:
            return name
    return f"{abs(lat):.0f}°{'N' if lat >= 0 else 'S'} {abs(lon):.0f}°{'E' if lon >= 0 else 'W'}"


def cell_area_km2() -> np.ndarray:
    """(H,) area of a 0.5 deg cell in each row."""
    lat_n = 90 - np.arange(H) * CELL
    return R_EARTH ** 2 * math.radians(CELL) * (np.sin(np.radians(lat_n)) - np.sin(np.radians(lat_n - CELL)))


def haversine_km(lon0, lat0, lon1, lat1):
    p0, p1 = np.radians(lat0), np.radians(lat1)
    a = np.sin((p1 - p0) / 2) ** 2 + np.cos(p0) * np.cos(p1) * np.sin(np.radians(lon1 - lon0) / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(np.minimum(1, a)))


def convex_hull(pts: list[tuple[float, float]]) -> list[list[float]]:
    """Andrew's monotone chain; closed ring, counter-clockwise."""
    pts = sorted(set(pts))
    if len(pts) <= 2:
        return [list(p) for p in pts + pts[:1]]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    ring = lo[:-1] + hi[:-1]
    return [[round(x, 3), round(y, 3)] for x, y in ring + ring[:1]]


def label_clusters(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """8-connected components; longitude wraps at the antimeridian."""
    from scipy import ndimage

    lab, n = ndimage.label(mask, structure=np.ones((3, 3), int))
    # merge components touching across 180 deg
    parent = list(range(n + 1))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for y in range(H):
        for dy in (-1, 0, 1):
            yy = y + dy
            if 0 <= yy < H and lab[y, 0] and lab[yy, W - 1]:
                a, b = find(lab[y, 0]), find(lab[yy, W - 1])
                if a != b:
                    parent[max(a, b)] = min(a, b)
    roots = np.array([find(i) for i in range(n + 1)])
    lab = roots[lab]
    uniq = np.unique(lab[lab > 0])
    remap = np.zeros(n + 1, int)
    remap[uniq] = np.arange(1, len(uniq) + 1)
    return remap[lab], len(uniq)


def dominant_strata(meta: dict, months: list[int]) -> np.ndarray:
    """(H, W) stratum id with the most harmonized activity in `months` (-1 none), from the L1 tiles."""
    use_meq, _ = served_stream(meta)
    meq = ",".join(str(m) for m in months if m in set(use_meq)) or "-1"
    ms = ",".join(map(str, months))
    with tempfile.TemporaryDirectory() as tmp:
        con = duckdb.connect()
        con.execute(f"SET memory_limit='4GB'; SET threads=8; SET temp_directory='{posix(tmp)}'")
        df = con.execute(f"""
            WITH s AS (
              SELECT ((cell % 1440) // 2)::INT AS x, (359 - (cell // 1440) // 2)::INT AS y, stratum::INT AS st,
                     sum(CASE WHEN m IN ({meq}) THEN meq ELSE kv END) AS h
              FROM read_parquet('{posix(TILES)}/L1/*.parquet') WHERE m IN ({ms}) GROUP BY ALL HAVING h > 0)
            SELECT x, y, arg_max(st, h) AS st FROM s GROUP BY x, y""").fetchnumpy()
        con.close()
    out = np.full((H, W), -1, np.int32)
    out[df["y"], df["x"]] = df["st"]
    return out


def window_series(grid: np.ndarray, m0: int, cov: np.ndarray, months: list[int]):
    """Same calendar window in every year of the record: years, (n_years, H, W) sums, and which are complete."""
    k0 = months[0] % 12
    span = len(months)
    last_year = MONTH0_YEAR + (m0 + len(grid)) // 12
    years, vals = [], []
    for y in range(MONTH0_YEAR, last_year + 1):
        ms = [(y - MONTH0_YEAR) * 12 + k0 + i for i in range(span)]
        if ms[0] < m0 or ms[-1] >= m0 + len(grid) or any(cov[m] < COV_OK for m in ms):
            continue
        years.append(y)
        vals.append(grid[ms[0] - m0:ms[-1] - m0 + 1].sum(0))
    return np.array(years), np.array(vals, np.float32)


def month_iso(m: int) -> str:
    return f"{MONTH0_YEAR + m // 12}-{m % 12 + 1:02d}"


def analyse(grid: np.ndarray, meta: dict, months: list[int], strata: np.ndarray) -> dict:
    m0 = meta["m_first"]
    _, cov = served_stream(meta)
    years, series = window_series(grid, m0, cov, months)
    target_year = MONTH0_YEAR + months[0] // 12
    if target_year not in years:
        raise SystemExit(f"[watch] {month_iso(months[-1])}: window not covered (coverage < {COV_OK})")
    it = int(np.nonzero(years == target_year)[0][0])
    x = series[it]
    bsel = (years >= CLIM_BASELINE[0]) & (years <= CLIM_BASELINE[1]) & (years != target_year)
    base = series[bsel]
    nb = int(bsel.sum())
    med = np.median(base, axis=0)
    pct = 100 * ((base < x).sum(0) + 0.5 * (base == x).sum(0)) / max(nb, 1)
    ratio = x / np.maximum(med, MEDIAN_FLOOR)
    hot = (x >= MIN_CELL) & (pct >= MIN_PCT) & (ratio >= MIN_RATIO)
    lab, n = label_clusters(hot)

    lon_c, lat_c = cell_centres()
    area_row = cell_area_km2()
    excess = np.where(hot, x - med, 0)
    if n:
        score = np.bincount(lab.ravel(), weights=excess.ravel(), minlength=n + 1)[1:]
        order = np.argsort(-score)[:TOP_N]
    else:
        score, order = np.zeros(0), []
    names = {s["id"]: s["name"] for s in meta.get("strata", [])}
    out = []
    for rank_i, ci in enumerate(order, 1):
        iy, ix = np.nonzero(lab == ci + 1)
        w = x[iy, ix]
        lons, lats = lon_c[ix], lat_c[iy]
        # activity-weighted centroid (longitude unwrapped around the heaviest cell for dateline clusters)
        ref = lons[np.argmax(w)]
        ul = (lons - ref + 180) % 360 - 180 + ref
        clon = float(((np.sum(ul * w) / w.sum()) + 180) % 360 - 180)
        clat = float(np.sum(lats * w) / w.sum())
        cs = series[:, iy, ix].sum(1)                               # the cluster's own record for this window
        cb = cs[bsel]
        cmed = float(np.median(cb))
        rank = int((cs > cs[it]).sum() + 1)
        radius = float(haversine_km(clon, clat, ul, lats).max()) + CELL * 111.32 / 2 * 1.42
        corners = [(float(a + dx), float(b + dy)) for a, b in zip(ul, lats)
                   for dx in (-CELL / 2, CELL / 2) for dy in (-CELL / 2, CELL / 2)]
        st = strata[iy, ix]
        biome = None
        if (st >= 0).any():
            ids, inv = np.unique(st[st >= 0], return_inverse=True)
            best = ids[np.argmax(np.bincount(inv, weights=w[st >= 0]))]
            biome = names.get(int(best))
        out.append({
            "id": f"{month_iso(months[-1])}-{'m' if len(months) == 1 else 'q'}{rank_i:02d}",
            "rank": rank_i,
            "label": place(clon, clat),
            "centroid": [round(clon, 3), round(clat, 3)],
            "bbox": [round(float(ul.min() - CELL / 2), 2), round(float(lats.min() - CELL / 2), 2),
                     round(float(ul.max() + CELL / 2), 2), round(float(lats.max() + CELL / 2), 2)],
            "circle": {"lon": round(clon, 3), "lat": round(clat, 3), "km": round(radius / 5) * 5},
            "polygon": convex_hull(corners),
            "cells": int(len(iy)),
            "area_km2": round(float(area_row[iy].sum()), -1),
            "afcd": round(float(cs[it]), 1),
            "normal_afcd": round(cmed, 1),
            "excess_afcd": round(float(score[ci]), 1),
            "ratio": round(float(cs[it] / max(cmed, MEDIAN_FLOOR * len(iy))), 2),
            "normal_near_zero": bool(cmed < MEDIAN_FLOOR * len(iy)),
            "percentile": round(float(100 * ((cb < cs[it]).sum() + 0.5 * (cb == cs[it]).sum()) / max(nb, 1)), 1),
            "baseline_years_exceeded": int((cb < cs[it]).sum()),
            "record_rank": rank, "record_years": int(len(years)),
            "record_max_year": int(years[np.argmax(cs)]),
            "biome": biome,
        })
    return {
        "months": [month_iso(months[0]), month_iso(months[-1])],
        "provisional": bool(any(meta["months"]["provisional"][m] for m in months)),
        "coverage": [round(float(cov[m]), 3) for m in months],
        "baseline_years": nb,
        "record_years": [int(years[0]), int(years[-1])],
        "candidate_cells": int(hot.sum()),
        "clusters_found": int(n),
        "clusters": out,
    }


def latest_month(meta: dict, cov: np.ndarray) -> int:
    m = meta["m_last"]
    while m > meta["m_first"] and cov[m] < COV_OK:
        m -= 1
    return m


def main(force: bool = False, month: str | None = None) -> None:
    deps = [META, TILES / "index.json"]
    if month is None and not force and fresh(OUT, deps):
        print("[watch] up to date")
        return
    meta = json.loads(META.read_text())
    _, cov = served_stream(meta)
    if month:
        y, mo = (int(v) for v in month.split("-"))
        m = (y - MONTH0_YEAR) * 12 + mo - 1
    else:
        m = latest_month(meta, cov)
    with timed(f"watch {month_iso(m)}"):
        grid = load_grid(meta)
        windows = {"month": [m], "three_months": [m - 2, m - 1, m]}
        res = {}
        for key, ms in windows.items():
            res[key] = analyse(grid, meta, ms, dominant_strata(meta, ms))
        doc = {
            "version": 1,
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "data_through": meta["data_through"],
            "month": month_iso(m),
            "unit": "harmonized AFCD-M (MODIS-equivalent active-fire cell-days), day + night, all strata",
            "method": {
                "grid": "0.5 deg cells (L1 tiles summed 2 x 2)",
                "baseline": list(CLIM_BASELINE), "baseline_note": "same calendar month(s); the target year is excluded",
                "coverage_min": COV_OK,
                "cell_min_afcd": MIN_CELL, "cell_min_percentile": MIN_PCT, "cell_min_ratio": MIN_RATIO,
                "median_floor_afcd": MEDIAN_FLOOR,
                "clustering": "8-connected cells, longitude wraps", "score": "sum over cells of (value - baseline median)",
                "top_n": TOP_N,
                "cluster_stats": "ratio, percentile and rank use the cluster's own summed series for the window",
            },
            "caveat": ("Recent months are near-real-time (provisional): they may include persistent industrial or "
                       "volcanic sources that the static-source screen has not yet seen for long enough, and "
                       "coverage-corrected partial data. With 20 baseline years a percentile resolves only ~5 %; "
                       "ranks are reported against all years of the record. Clusters are selected because their cells are "
                       "unusual, so cluster ranks lean towards the top by construction; a fixed region can rank lower. "
                       "Unusual is not the same as dangerous."),
            "windows": res,
        }
        if month:
            HIST.mkdir(parents=True, exist_ok=True)
            path = HIST / f"watch-{month_iso(m)}.json"
        else:
            path = OUT
        write_json(path, doc)
        for key in windows:
            r = res[key]
            print(f"  {key} {r['months'][0]}..{r['months'][1]}: {r['candidate_cells']} cells, {r['clusters_found']} clusters")
            for c in r["clusters"][:8]:
                print(f"    {c['rank']:2d} {c['label'][:42]:42s} {c['afcd']:9.0f} AFCD-M  x{c['ratio']:<6} "
                      f"rank {c['record_rank']}/{c['record_years']} (max {c['record_max_year']})  {c['area_km2']:.0f} km2")
        print(f"  -> {path}")
