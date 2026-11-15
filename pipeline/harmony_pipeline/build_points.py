"""Hotspot archive for CSV export: data/dist/points/{px}_{py}/{year}.parquet + points/index.json.

px = floor((lon+180)/10), py = floor((lat+90)/10) (clamped at 180E / 90N); year = UTC acquisition year.
Rows sorted by (1-degree block, UTC month, L0 cell, acq_time_utc) so row-group min/max statistics prune
both by area (latitude/longitude) and by date (acq_time_utc) - a one-month export of a small area reads
a few row groups instead of the whole tile-year; row
groups <= 50 000 rows; Parquet v1, ZSTD. `used` = conf_ok AND type in (0, NULL) AND not static-masked.
One UTC year is processed at a time (all sensors) to bound memory.
"""
from __future__ import annotations

import json
import shutil

from .common import connect, fresh, posix, timed, write_json
from .config import DIST, POINTS_DIR
from .static_mask import OUT as MASK, used_sql

OUT_DIR = DIST / "points"
INDEX = OUT_DIR / "index.json"
COLS = ("latitude, longitude, acq_time_utc, satellite, instrument, confidence, frp, daynight, type, quality, "
        "brightness, bright_2, scan, track, version, used")


def main(force: bool = False, years: list[int] | None = None) -> None:
    """Rebuild the archive; with `years`, only those UTC years (other years' files and index entries are kept)."""
    from .screen import EXCLUDED, WATER
    files = sorted(POINTS_DIR.glob("*/*.parquet"))
    if not years and not force and fresh(INDEX, files + [MASK, WATER, EXCLUDED]):
        print("[points] up to date")
        return
    con = connect()
    index: dict[str, dict[str, list[int]]] = {}
    todo = sorted({f.stem for f in files})
    if years:
        todo = [y for y in todo if int(y) in set(years)]
        if INDEX.exists():
            index = {k: {y: v for y, v in t.items() if y not in todo} for k, t in json.loads(INDEX.read_text()).items()}
        for y in todo:
            for p in OUT_DIR.glob(f"*/{y}.parquet"):
                p.unlink()
    else:
        shutil.rmtree(OUT_DIR, ignore_errors=True)
    for year in todo:
        src = "[" + ",".join(f"'{posix(f)}'" for f in files if f.stem == year) + "]"
        with timed(f"points {year}"):
            con.execute(f"""CREATE OR REPLACE TEMP TABLE p AS
                SELECT latitude, longitude, acq_time_utc, satellite, instrument, confidence, frp, daynight,
                       type::TINYINT AS type, quality, brightness, bright_2, scan, track, version, used, l0,
                       least(floor((longitude + 180) / 10), 35)::INTEGER AS px,
                       least(floor((latitude + 90) / 10), 17)::INTEGER AS py
                FROM ({used_sql(f"read_parquet({src}, union_by_name=true)")})
                ORDER BY px, py, l0, acq_time_utc""")
            for px, py, n in con.execute("SELECT px, py, count(*) FROM p GROUP BY ALL ORDER BY 1, 2").fetchall():
                path = OUT_DIR / f"{px}_{py}" / f"{year}.parquet"
                path.parent.mkdir(parents=True, exist_ok=True)
                con.execute(f"""COPY (SELECT {COLS} FROM p WHERE px = {px} AND py = {py}
                    ORDER BY floor(latitude), floor(longitude), month(acq_time_utc), l0, acq_time_utc)
                    TO '{posix(path)}' (FORMAT parquet, COMPRESSION zstd, PARQUET_VERSION v1, ROW_GROUP_SIZE 49152)""")
                index.setdefault(f"{px}_{py}", {})[year] = [path.stat().st_size, int(n)]
    write_json(INDEX, index, compact=True)
    total = sum(b for t in index.values() for b, _ in t.values())
    rows = sum(r for t in index.values() for _, r in t.values())
    print(f"  points: {sum(len(t) for t in index.values())} files, {total / 1e6:.1f} MB, {rows:,} rows")
