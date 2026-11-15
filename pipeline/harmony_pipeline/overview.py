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


def load_grid(meta: dict) -> np.ndarray:
    """Harmonized AFCD-M as float32 (n_months, H, W), rows north-first, months m_first..m_last."""
    m0, m1, sw = meta["m_first"], meta["m_last"], meta["default_switch_m"]
    # Same fallback as the browser kernel: a month the preferred stream does not cover uses the other one.
    cov_v, cov_m = meta["months"]["cov_viirs"], meta["months"]["cov_modis"]
    use_meq = [m for m in range(m0, m1 + 1)
               if (m < sw and cov_m[m] > 0) or (m >= sw and cov_v[m] <= 0 and cov_m[m] > 0) or (m < sw and cov_v[m] <= 0)]
    meq_months = ",".join(map(str, use_meq)) or "-1"
    with tempfile.TemporaryDirectory() as tmp:  # private spill dir: never share data/work/tmp with other jobs
        con = duckdb.connect()
        con.execute(f"SET memory_limit='8GB'; SET threads=8; SET temp_directory='{posix(tmp)}'")
        # L1 cell = iy * 1440 + ix at 0.25 deg; 0.5 deg cell (ix // 2, iy // 2)
        df = con.execute(f"""
            SELECT ((cell % 1440) // 2)::INT AS x, (359 - (cell // 1440) // 2)::INT AS y, m::INT AS m,
                   sum(CASE WHEN m IN ({meq_months}) THEN meq ELSE kv END) / 100.0 AS h
            FROM read_parquet('{posix(TILES)}/L1/*.parquet')
            WHERE m BETWEEN {m0} AND {m1}
            GROUP BY ALL HAVING h > 0""").fetchnumpy()
        con.close()
    grid = np.zeros((m1 - m0 + 1, H, W), np.float32)
    grid[df["m"] - m0, df["y"], df["x"]] = df["h"]
    return grid


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
        grid = load_grid(meta)
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
            "version": 2,
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
