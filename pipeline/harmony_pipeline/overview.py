"""Global 0.25 deg overview rasters (1440 x 720, row 0 = south, little-endian) per the contract.

Harmonized value H per L1 cell-month = meq (months before default_switch_m) or kv (from the switch),
in AFCD units, summed over strata and day|night, read back from the L1 tiles (so the overview equals
what the app computes). A cell "has data" if H > 0 in any month; all other cells are NaN.
- clim_{01..12}.f32: median over CLIM_BASELINE years of H for that month-of-year (zeros included).
- latest.f32: H for the latest complete month; latest_ratio.f32: latest / clim median (NaN where the
  median is 0 — ratio undefined).
- annual_{yyyy}.f32: yearly totals of H.
- monthly.u16: months m_first..m_last stacked, round(10*sqrt(H)) clipped to 65535, 0 = none.
"""
from __future__ import annotations

import calendar
import json
import shutil

import numpy as np

from .build_tiles import META, TILES
from .common import connect, fresh, posix, timed, write_json
from .config import CLIM_BASELINE, DIST

OUT = DIST / "overview"
NX, NY = 1440, 720


def main(force: bool = False) -> None:
    if not force and fresh(OUT / "meta.json", [META, TILES / "index.json"]):
        print("[overview] up to date")
        return
    meta = json.loads(META.read_text())
    m0, m1, sw = meta["m_first"], meta["m_last"], meta["default_switch_m"]
    through = meta["data_through"]
    y, mo, d = (int(x) for x in through.split("-"))
    latest_m = m1 if d == calendar.monthrange(y, mo)[1] else m1 - 1
    con = connect()
    with timed("overview"):
        df = con.execute(f"""SELECT cell, m, sum(CASE WHEN m < {sw} THEN meq ELSE kv END) / 100.0 AS h
                             FROM read_parquet('{posix(TILES)}/L1/*.parquet') GROUP BY ALL HAVING h > 0""").df()
        cells, ci = np.unique(df.cell.to_numpy(), return_inverse=True)
        nm = m1 - m0 + 1
        H = np.zeros((len(cells), nm), np.float32)
        H[ci, df.m.to_numpy() - m0] = df.h.to_numpy()
        shutil.rmtree(OUT, ignore_errors=True)
        OUT.mkdir(parents=True)

        def save(name: str, vals: np.ndarray) -> None:
            grid = np.full(NX * NY, np.nan, dtype="<f4")
            grid[cells] = vals
            grid.tofile(OUT / name)

        months = np.arange(m0, m1 + 1)
        years = 2000 + months // 12
        base = (years >= CLIM_BASELINE[0]) & (years <= CLIM_BASELINE[1])
        clim = np.zeros((len(cells), 12), np.float32)
        for k in range(12):
            sel = base & (months % 12 == k)
            clim[:, k] = np.median(H[:, sel], axis=1) if sel.any() else 0
            save(f"clim_{k + 1:02d}.f32", clim[:, k])
        latest = H[:, latest_m - m0]
        save("latest.f32", latest)
        cm = clim[:, latest_m % 12]
        save("latest_ratio.f32", np.where(cm > 0, latest / np.where(cm > 0, cm, 1), np.nan))
        annual_years = sorted(set(years.tolist()))
        for yy in annual_years:
            save(f"annual_{yy}.f32", H[:, years == yy].sum(1))
        stack = np.zeros((nm, NX * NY), dtype="<u2")
        stack[:, cells] = np.clip(np.round(10 * np.sqrt(H.T)), 0, 65535).astype("<u2")
        stack.tofile(OUT / "monthly.u16")
        write_json(OUT / "meta.json", {
            "version": 1, "width": NX, "height": NY, "cell_deg": 0.25, "row0": "south",
            "index": "iy * 1440 + ix = L1 cell id", "dtype": "float32 little-endian", "nodata": "NaN",
            "value": "harmonized AFCD-M per 0.25 deg cell per month (meq before default_switch_m, kv from it)",
            "default_switch_m": sw, "clim_baseline": list(CLIM_BASELINE),
            "clim": [f"clim_{k:02d}.f32" for k in range(1, 13)],
            "latest_m": latest_m, "latest_month": f"{2000 + latest_m // 12}-{latest_m % 12 + 1:02d}",
            "latest": "latest.f32",
            "latest_ratio": {"file": "latest_ratio.f32", "note": "latest / clim median; NaN where median is 0"},
            "annual": {str(yy): f"annual_{yy}.f32" for yy in annual_years},
            "monthly": {"file": "monthly.u16", "m_first": m0, "m_last": m1, "count": nm,
                        "dtype": "uint16 little-endian", "encoding": "round(10*sqrt(value)); value = (u/10)^2",
                        "frame_bytes": NX * NY * 2},
            "active_cells": int(len(cells)),
        })
        print(f"  {len(cells):,} active cells, latest month {latest_m}, monthly.u16 "
              f"{(OUT / 'monthly.u16').stat().st_size / 1e6:.0f} MB")
