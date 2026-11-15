"""Land and burst screen for detections, between `static_mask` and `afcd`.

Near-real-time rows carry no FIRMS `type`, so offshore and sea detections that the standard-quality
`type = 3` (offshore) filter would remove reach the record unless they are screened here. Two rules:

1. Land rule (near-real-time rows only). A 0.0125 deg land raster (sub-cell centres) is drawn from the
   RESOLVE Ecoregions 2017 polygons (every polygon, rock and ice included; a polygon smaller than the
   sample spacing marks the sample nearest to it). An L0 cell (0.05 deg) is land if any of its samples is
   land; the land set is then dilated by LAND_BUFFER_CELLS L0 cells (one cell, 0.05 deg, about 5.5 km at
   the equator), so a cell counts as water only when no mapped land lies in it or in any of its eight
   neighbours. This is conservative at coasts: a detection within one cell of mapped land is kept. Islands
   smaller than about 1 km that the polygons omit are treated as water. A row without `type` (near-real-time)
   in a water cell is not `used`. Standard rows are left to their own `type`.

2. Burst screen (every row, action depends on quality). For each satellite x UTC date, x = candidate
   detections (confidence ok, type 0 or absent, outside the static mask) that are suspect: in a water cell,
   or in a land cell with no candidate detection in any other calendar year ("historically fire-free",
   leave-own-year-out) AND not confirmed by another satellite (no candidate detection of any other satellite
   in the same 0.1 deg block within +-1 local-solar day). The confirmation keeps real large fires on new
   ground (Siberia 2019/2021, Canada 2023: tens of thousands of fire-free detections a day, all seen by
   several satellites) out of the metric; a false alarm is one satellite's granule. Fire-free detections
   count only on days when another satellite was available (none in the Terra-only era). A satellite-day is
   a burst when log1p(x) exceeds the median of that satellite's log1p(x) over all its days by more than
   BURST_K robust standard deviations (1.4826 MAD, at least 0.25) and x >= BURST_MIN. On a near-real-time
   burst day the suspect rows of that satellite and day are not `used`; standard-quality burst days are only
   reported (validation.json `bursts`), never excluded.

The water cells and the excluded (satellite, date, cell) keys are joined in `static_mask.used_sql`, the one
definition of `used` (afcd, build_points and verify read it).

Outputs: data/work/land_l0.npy (packed L0 land raster before dilation, cached; rebuilt only when the shapefile
or the sampling changes), data/work/screen_water.parquet (l0 of water cells that hold any detection),
data/work/screen_excluded.parquet (satellite, utc_date, l0 excluded by the burst rule),
data/work/screen.json (summary and the burst list for validation.json).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .common import connect, fresh, posix, timed, write_json
from .config import L0_NX, L0_NY, POINTS_DIR, SUB, WORK
from .static_mask import OUT as MASK

LAND_NPY = WORK / "land_l0.npy"
LAND_META = WORK / "land_l0.json"
WATER = WORK / "screen_water.parquet"
EXCLUDED = WORK / "screen_excluded.parquet"
SUMMARY = WORK / "screen.json"
LAND_SS = SUB                  # samples per L0 cell side: 4 = sub-cell centres, 0.0125 deg
LAND_BUFFER_CELLS = 1          # dilation of the land set in L0 cells (conservative at coasts)
BURST_K = 6.0                  # robust standard deviations of log1p(suspect detections) above the satellite median
BURST_MIN = 500                # and at least this many suspect detections on the satellite-day


def land_raster() -> np.ndarray:
    """(L0_NY, L0_NX) bool, row 0 = south: an L0 cell holds at least one land sample."""
    import duckdb
    import shapely

    from .strata import SHP, ensure_shapefile

    ensure_shapefile()
    key = {"shp_size": SHP.stat().st_size, "shp_mtime": int(SHP.stat().st_mtime), "ss": LAND_SS}
    if LAND_NPY.exists() and LAND_META.exists() and json.loads(LAND_META.read_text()) == key:
        return np.unpackbits(np.load(LAND_NPY), axis=1)[:, :L0_NX].astype(bool)
    with timed("screen land raster"):
        con = duckdb.connect()
        con.execute("LOAD spatial")
        wkb = [r[0] for r in con.execute(f"SELECT ST_AsWKB(geom) FROM ST_Read('{posix(SHP)}') "
                                         "WHERE geom IS NOT NULL").fetchall()]
        con.close()
        parts = shapely.get_parts(shapely.from_wkb([bytes(b) for b in wkb]))
        nx, ny = L0_NX * LAND_SS, L0_NY * LAND_SS
        d = 360 / nx
        xs = -180 + (np.arange(nx) + 0.5) * d
        ys = -90 + (np.arange(ny) + 0.5) * d
        hit = np.zeros((ny, nx), bool)
        for g in parts:
            if g is None or g.is_empty:
                continue
            x0, y0, x1, y1 = g.bounds
            i0, i1 = np.searchsorted(xs, x0), np.searchsorted(xs, x1, side="right")
            j0, j1 = np.searchsorted(ys, y0), np.searchsorted(ys, y1, side="right")
            if i1 <= i0 or j1 <= j0:      # smaller than the sample spacing: mark the nearest sample
                p = g.representative_point()
                hit[min(max(int((p.y + 90) / d), 0), ny - 1), min(max(int((p.x + 180) / d), 0), nx - 1)] = True
                continue
            shapely.prepare(g)
            gx, gy = np.meshgrid(xs[i0:i1], ys[j0:j1])
            hit[j0:j1, i0:i1] |= shapely.contains_xy(g, gx, gy)
        land = hit.reshape(L0_NY, LAND_SS, L0_NX, LAND_SS).any(axis=(1, 3))
        del hit
        np.save(LAND_NPY, np.packbits(land, axis=1))
        write_json(LAND_META, key)
    return land


def buffered_land(land: np.ndarray) -> np.ndarray:
    """Land dilated by LAND_BUFFER_CELLS in all eight directions (longitude wraps)."""
    from scipy import ndimage

    b = LAND_BUFFER_CELLS
    if b <= 0:
        return land
    padded = np.pad(land, ((0, 0), (b, b)), mode="wrap")
    return ndimage.binary_dilation(padded, structure=np.ones((2 * b + 1, 2 * b + 1), bool))[:, b:-b]


def robust_threshold(lx: np.ndarray) -> tuple[float, float, float]:
    """(median, robust sd, threshold) of log1p values."""
    med = float(np.median(lx))
    sd = 1.4826 * float(np.median(np.abs(lx - med)))
    sd = max(sd, 0.25)                     # a satellite with almost constant counts still needs a margin
    return med, sd, med + BURST_K * sd


def main(force: bool = False) -> None:
    files = sorted(POINTS_DIR.glob("*/*.parquet"))
    from .strata import SHP
    from .availability import OUT as AVAIL
    deps = files + [MASK, SHP, AVAIL]
    if not force and all(fresh(p, deps) for p in (WATER, EXCLUDED, SUMMARY)):
        print("[screen] up to date")
        return
    land = buffered_land(land_raster())
    con = connect()
    with timed("screen"):
        pts = f"read_parquet('{posix(POINTS_DIR)}/*/*.parquet', union_by_name=true)"
        cells = con.execute(f"SELECT DISTINCT l0 FROM {pts}").fetchnumpy()["l0"].astype(np.int64)
        water = cells[~land.ravel()[cells]]
        con.register("w_df", pd.DataFrame({"l0": water.astype(np.uint32)}))
        con.execute(f"COPY (SELECT l0 FROM w_df ORDER BY l0) TO '{posix(WATER)}' (FORMAT parquet)")
        con.execute("CREATE TEMP TABLE water AS SELECT l0 FROM w_df")
        # candidate rows: everything `used` would keep before this screen
        from .availability import OUT as AVAIL
        blk = f"((p.l0 // {L0_NX}) // 2) * {L0_NX // 2} + (p.l0 % {L0_NX}) // 2"     # 0.1 deg block
        con.execute(f"""CREATE TEMP TABLE r AS
            SELECT p.l0, {blk} AS blk, p.lsd, year(p.lsd) AS y, p.satellite, p.utc_date, p.quality,
                   p.type IS NULL AS untyped
            FROM {pts} p LEFT JOIN read_parquet('{posix(MASK)}') sm ON p.sub = sm.sub
            WHERE p.conf_ok AND coalesce(p.type, 0) = 0 AND sm.sub IS NULL""")
        con.execute("CREATE TEMP TABLE cy AS SELECT l0, count(DISTINCT y) AS ny FROM r GROUP BY l0")
        con.execute("CREATE TEMP TABLE ff AS SELECT l0 FROM cy WHERE ny = 1 AND l0 NOT IN (SELECT l0 FROM water)")
        # confirmation of fire-free detections by any other satellite: same 0.1 deg block, +-1 local-solar day
        con.execute("CREATE TEMP TABLE fk AS SELECT DISTINCT blk, lsd, satellite FROM r WHERE l0 IN (SELECT l0 FROM ff)")
        con.execute("""CREATE TEMP TABLE ak AS SELECT DISTINCT blk, lsd, satellite FROM r
                       WHERE blk IN (SELECT DISTINCT blk FROM fk)""")
        con.execute("""CREATE TEMP TABLE conf AS SELECT DISTINCT fk.blk, fk.lsd, fk.satellite FROM fk JOIN ak
                       ON ak.blk = fk.blk AND ak.lsd BETWEEN fk.lsd - 1 AND fk.lsd + 1 AND ak.satellite <> fk.satellite""")
        con.execute(f"""CREATE TEMP TABLE oth AS SELECT a.satellite, a.date AS utc_date, count(b.satellite) AS n_other
            FROM read_parquet('{posix(AVAIL)}') a LEFT JOIN read_parquet('{posix(AVAIL)}') b
              ON b.date = a.date AND b.satellite <> a.satellite AND b.available GROUP BY ALL""")
        con.execute("""CREATE TEMP TABLE rs AS
            SELECT r.*, w.l0 IS NOT NULL AS is_water, f.l0 IS NOT NULL AS is_free,
                   (f.l0 IS NOT NULL AND c.blk IS NULL AND coalesce(o.n_other, 0) > 0) AS is_unconf
            FROM r LEFT JOIN water w USING (l0) LEFT JOIN ff f USING (l0)
            LEFT JOIN conf c ON c.blk = r.blk AND c.lsd = r.lsd AND c.satellite = r.satellite
            LEFT JOIN oth o ON o.satellite = r.satellite AND o.utc_date = r.utc_date""")
        sd = con.execute("""SELECT satellite, utc_date, any_value(quality) AS quality,
                count(*) AS n, count_if(is_water) AS n_water, count_if(is_free) AS n_free,
                count_if(is_unconf) AS n_unconf, count_if(is_water OR is_unconf) AS x
            FROM rs GROUP BY ALL""").df()
        rows = []
        for sat, g in sd.groupby("satellite"):
            lx = np.log1p(g.x.to_numpy(float))
            med, rsd, thr = robust_threshold(lx)
            z = (lx - med) / rsd
            hit = (lx > thr) & (g.x.to_numpy() >= BURST_MIN)
            for r in g[hit].itertuples():
                rows.append({"satellite": sat, "date": str(r.utc_date)[:10], "quality": r.quality,
                             "detections": int(r.n), "suspect": int(r.x), "water": int(r.n_water),
                             "fire_free_land_unconfirmed": int(r.n_unconf), "fire_free_land": int(r.n_free),
                             "share_suspect": round(r.x / max(r.n, 1), 3),
                             "satellite_median": round(float(np.expm1(med)), 1),
                             "threshold": round(float(np.expm1(thr)), 1),
                             "robust_z": round(float((np.log1p(r.x) - med) / rsd), 1),
                             "action": "excluded" if r.quality == "nrt" else "reported"})
        rows.sort(key=lambda b: (-b["robust_z"], b["satellite"], b["date"]))
        # the highest standard-quality satellite-days (report-only scan of the science-quality record)
        sp_top = []
        for sat, g in sd[sd.quality == "sp"].groupby("satellite"):
            ga = sd[sd.satellite == sat]
            med, rsd, thr = robust_threshold(np.log1p(ga.x.to_numpy(float)))
            g = g.assign(z=(np.log1p(g.x.to_numpy(float)) - med) / rsd).sort_values("z", ascending=False).head(3)
            sp_top += [{"satellite": sat, "date": str(r.utc_date)[:10], "suspect": int(r.x), "water": int(r.n_water),
                        "fire_free_land_unconfirmed": int(r.n_unconf), "detections": int(r.n),
                        "robust_z": round(float(r.z), 1)} for r in g.itertuples()]
        sp_top.sort(key=lambda b: -b["robust_z"])
        excl = [(b["satellite"], b["date"]) for b in rows if b["action"] == "excluded"]
        con.execute("CREATE TEMP TABLE bd(satellite VARCHAR, utc_date DATE)")
        if excl:
            con.executemany("INSERT INTO bd VALUES (?, CAST(? AS DATE))", excl)
        # the suspect rows of near-real-time burst days (their water rows are already out by the land rule)
        con.execute(f"""COPY (SELECT DISTINCT rs.satellite, rs.utc_date, rs.l0 FROM rs
                JOIN bd ON bd.satellite = rs.satellite AND bd.utc_date = rs.utc_date
                WHERE rs.quality = 'nrt' AND (rs.is_water OR rs.is_unconf) ORDER BY ALL)
            TO '{posix(EXCLUDED)}' (FORMAT parquet)""")
        # the exclusion key is (satellite, date, cell): every near-real-time row there is dropped, confirmed or not
        n_excl = con.execute(f"""SELECT count(*) FROM rs JOIN read_parquet('{posix(EXCLUDED)}') e
                USING (satellite, utc_date, l0) WHERE rs.quality = 'nrt'""").fetchone()[0]
        n_excl_only_burst = con.execute(f"""SELECT count(*) FROM rs JOIN read_parquet('{posix(EXCLUDED)}') e
                USING (satellite, utc_date, l0) WHERE rs.quality = 'nrt' AND NOT (rs.is_water AND rs.untyped)""").fetchone()[0]
        land_rule = con.execute("""SELECT satellite, strftime(utc_date, '%Y-%m') AS month, count(*) AS n
                FROM rs WHERE is_water AND untyped GROUP BY ALL ORDER BY ALL""").fetchall()
        sp_water = con.execute("SELECT count(*) FROM rs WHERE is_water AND NOT untyped").fetchone()[0]
        per_sat = {sat: {"days": int(len(g)), "median_suspect": float(np.median(g.x)),
                         "p99_suspect": float(np.quantile(g.x, 0.99)),
                         "threshold": round(float(np.expm1(robust_threshold(np.log1p(g.x.to_numpy(float)))[2])), 1)}
                   for sat, g in sd.groupby("satellite")}
        summary = {
            "land": {
                "rule": "near-real-time rows (no FIRMS type) in L0 cells with no mapped land within one cell are not used",
                "source": "RESOLVE Ecoregions 2017, all polygons incl. rock and ice, sampled at 0.0125 deg",
                "buffer_cells": LAND_BUFFER_CELLS, "buffer_deg": round(LAND_BUFFER_CELLS * 360 / L0_NX, 4),
                "water_cells_with_detections": int(len(water)),
                "nrt_rows_excluded": int(sum(n for _, _, n in land_rule)),
                "nrt_rows_excluded_by_satellite_month": [{"satellite": s, "month": mo, "rows": int(n)}
                                                         for s, mo, n in land_rule],
                "sp_candidate_rows_in_water_cells_kept": int(sp_water),
            },
            "bursts": {
                "rule": (f"satellite-day burst: log1p(suspect detections) > satellite median + {BURST_K:g} x 1.4826 MAD "
                         f"(over all days of that satellite) and >= {BURST_MIN} suspect detections; suspect = candidate "
                         "detections (confidence ok, type 0 or none, not static-masked) in water cells, or in land cells "
                         "with no candidate detection in any other calendar year that no other satellite confirms "
                         "(0.1 deg block, +-1 local-solar day; counted only when another satellite was available)"),
                "action": "near-real-time burst days: suspect rows excluded from used; standard-quality: reported only",
                "k": BURST_K, "min_suspect": BURST_MIN,
                "by_satellite": per_sat,
                "flagged": rows,
                "standard_quality_top": sp_top,
                "n_flagged": len(rows),
                "n_excluded_days": len(excl),
                "rows_excluded": int(n_excl),
                "rows_excluded_beyond_land_rule": int(n_excl_only_burst),
            },
        }
        write_json(SUMMARY, summary)
        print(f"  water cells {len(water):,}; NRT rows in water excluded {summary['land']['nrt_rows_excluded']:,}; "
              f"bursts flagged {len(rows)} ({len(excl)} near-real-time days excluded, {n_excl:,} rows)")
        for b in rows[:20]:
            print(f"    {b['satellite']:7s} {b['date']} {b['quality']:3s} suspect {b['suspect']:>7,} of {b['detections']:>9,} "
                  f"(water {b['water']:,}, unconfirmed fire-free {b['fire_free_land_unconfirmed']:,}) "
                  f"z {b['robust_z']} -> {b['action']}")
        for b in sp_top[:6]:
            print(f"    top standard-quality: {b['satellite']:7s} {b['date']} suspect {b['suspect']:,} z {b['robust_z']}")
