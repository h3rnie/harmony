"""Active-fire cell-day (AFCD) cube at L0 (0.05 deg) x month x day|night.

An AFCD is one distinct (0.0125 deg sub-cell, local-solar date, day|night) with >= 1 `used`
detection. Columns per (l0, m, dn):
- m_ta / m_t / m_a: MODIS AFCD from Terra or Aqua / Terra only / Aqua only (a sub-cell-day seen by
  both MODIS satellites counts once in m_ta).
- vs / v20 / v21: AFCD per VIIRS satellite (S-NPP, NOAA-20, NOAA-21), unweighted.
- ws / w20 / w21: the same, each sub-cell-day weighted by 1 / (number of VIIRS satellites available
  that UTC date), and 0 when its satellite is flagged unavailable that date. ws + w20 + w21 is then
  a per-day mean over operating satellites (scaled to S-NPP units later in calibrate).
- nmod / nvii: accepted detection counts (naive hotspot counts).
Months outside [first data month, month of data_through] are dropped. Processed one local-solar
year at a time (reading the adjacent UTC-year files for the date-line spill-over) to bound memory.
Output: data/work/cube/{year}.parquet and the concatenation data/work/cube.parquet.
"""
from __future__ import annotations

from .availability import OUT as AVAIL
from .common import connect, fresh, posix, timed
from .config import POINTS_DIR, WORK
from .static_mask import OUT as MASK, used_sql

CUBE_DIR = WORK / "cube"
OUT = WORK / "cube.parquet"
M_FIRST = 10


def data_through(con) -> str:
    return str(con.execute(f"SELECT max(date) FROM '{posix(AVAIL)}'").fetchone()[0])


def month_last(con) -> int:
    d = data_through(con)
    return (int(d[:4]) - 2000) * 12 + int(d[5:7]) - 1


def cube_year(con, year: int, files: list, m_last: int, out) -> None:
    src = "[" + ",".join(f"'{posix(f)}'" for f in files) + "]"
    con.execute(f"""CREATE OR REPLACE TEMP TABLE p AS
        SELECT l0, m, dn, sub, lsd, utc_date, satellite, instrument
        FROM ({used_sql(f"read_parquet({src}, union_by_name=true)")})
        WHERE used AND year(lsd) = {year} AND m BETWEEN {M_FIRST} AND {m_last}""")
    con.execute(f"""COPY (
      WITH md AS (SELECT l0, m, dn, sub, lsd, bool_or(satellite = 'Terra') t, bool_or(satellite = 'Aqua') a,
                    count(*) n FROM p WHERE instrument = 'MODIS' GROUP BY l0, m, dn, sub, lsd),
      mo AS (SELECT l0, m, dn, count(*) m_ta, count_if(t) m_t, count_if(a) m_a, sum(n) nmod
             FROM md GROUP BY l0, m, dn),
      vd AS (SELECT l0, m, dn, sub, lsd, satellite, min(utc_date) d, count(*) n FROM p
             WHERE instrument = 'VIIRS' GROUP BY l0, m, dn, sub, lsd, satellite),
      vw AS (SELECT vd.*, CASE WHEN av.available THEN 1.0 / av.nviirs ELSE 0.0 END AS w
             FROM vd LEFT JOIN read_parquet('{posix(AVAIL)}') av ON av.satellite = vd.satellite AND av.date = vd.d),
      vi AS (SELECT l0, m, dn,
               count_if(satellite = 'SNPP') vs, count_if(satellite = 'NOAA20') v20, count_if(satellite = 'NOAA21') v21,
               coalesce(sum(w) FILTER (satellite = 'SNPP'), 0) ws,
               coalesce(sum(w) FILTER (satellite = 'NOAA20'), 0) w20,
               coalesce(sum(w) FILTER (satellite = 'NOAA21'), 0) w21,
               sum(n) nvii FROM vw GROUP BY l0, m, dn)
      SELECT l0::UINTEGER AS l0, m::USMALLINT AS m, dn::UTINYINT AS dn,
        coalesce(m_ta, 0)::INTEGER m_ta, coalesce(m_t, 0)::INTEGER m_t, coalesce(m_a, 0)::INTEGER m_a,
        coalesce(vs, 0)::INTEGER vs, coalesce(v20, 0)::INTEGER v20, coalesce(v21, 0)::INTEGER v21,
        coalesce(ws, 0)::DOUBLE ws, coalesce(w20, 0)::DOUBLE w20, coalesce(w21, 0)::DOUBLE w21,
        coalesce(nmod, 0)::INTEGER nmod, coalesce(nvii, 0)::INTEGER nvii
      FROM mo FULL OUTER JOIN vi USING (l0, m, dn) ORDER BY l0, m, dn)
      TO '{posix(out)}' (FORMAT parquet, COMPRESSION zstd)""")


def main(force: bool = False) -> None:
    files = sorted(POINTS_DIR.glob("*/*.parquet"))
    from .screen import EXCLUDED, WATER
    deps = [MASK, AVAIL, WATER, EXCLUDED]
    if not force and fresh(OUT, files + deps):
        print("[afcd] up to date")
        return
    con = connect()
    m_last = month_last(con)
    years = sorted({int(f.stem) for f in files})
    CUBE_DIR.mkdir(parents=True, exist_ok=True)
    for y in range(years[0], years[-1] + 1):
        ys = [f for f in files if int(f.stem) in (y - 1, y, y + 1)]
        out = CUBE_DIR / f"{y}.parquet"
        if not force and fresh(out, ys + deps):
            continue
        with timed(f"afcd {y}"):
            tmp = out.with_suffix(".tmp.parquet")
            cube_year(con, y, ys, m_last, tmp)
            tmp.replace(out)
    for stale in CUBE_DIR.glob("*.parquet"):
        if not stale.stem.isdigit() or not years[0] <= int(stale.stem) <= years[-1]:
            stale.unlink()
    with timed("afcd concat"):
        tmp = OUT.with_suffix(".tmp.parquet")
        con.execute(f"""COPY (SELECT * FROM read_parquet('{posix(CUBE_DIR)}/*.parquet') ORDER BY l0, m, dn)
                        TO '{posix(tmp)}' (FORMAT parquet, COMPRESSION zstd)""")
        tmp.replace(OUT)
        print(con.execute(f"""SELECT count(*) rows, count(DISTINCT l0) cells, sum(m_ta) m_ta, sum(m_t) m_t,
            sum(vs) vs, sum(v20) v20, sum(v21) v21, round(sum(ws+w20+w21)) w, sum(nmod) nmod, sum(nvii) nvii
            FROM '{posix(OUT)}'""").df().to_string(index=False))
