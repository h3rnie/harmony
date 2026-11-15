"""Static / persistent heat-source mask at sub-cell (0.0125 deg) resolution over the whole record.

A sub-cell is masked (core) if, over all sensors and years:
- it has >= 5 detections labelled type 1/2/3 (volcano, static land source, offshore), or
- type 1/2/3 detections are > 50 % of its typed detections, with >= 3 typed detections, or
- it is persistent: accepted VIIRS detections (n|h, type 0 or NULL) in >= 10 distinct months of a
  calendar year, in >= 3 different years (gas flares, industry, kilns that FIRMS `type` misses).
The core set is dilated by one sub-cell (8-neighbourhood) to absorb geolocation jitter.
NRT rows have no `type`; the mask is the only static-source filter applied to them.
Output: data/work/static_mask.parquet (sub UINTEGER, core BOOLEAN, reason VARCHAR).
"""
from __future__ import annotations

from .common import connect, fresh, posix, timed
from .config import (MASK_PERSIST_MONTHS, MASK_PERSIST_YEARS, MASK_TYPED_MIN, MASK_TYPED_SHARE_N,
                     POINTS_DIR, SUB_NX, WORK)

OUT = WORK / "static_mask.parquet"


def main(force: bool = False) -> None:
    files = sorted(POINTS_DIR.glob("*/*.parquet"))
    if not force and fresh(OUT, files):
        print("[static_mask] up to date")
        return
    con = connect()
    with timed("static_mask"):
        con.execute("CREATE TEMP TABLE typed(sub UINTEGER, n_static BIGINT, n_typed BIGINT)")
        con.execute("CREATE TEMP TABLE pers(sub UINTEGER, y INTEGER)")
        years = sorted({int(f.stem) for f in files})
        for y in years:  # year by year to bound memory on the global run
            src = "[" + ",".join(f"'{posix(f)}'" for f in files if f.stem == str(y)) + "]"
            con.execute(f"""INSERT INTO typed SELECT sub, sum((type IN (1,2,3))::INT), sum((type IS NOT NULL)::INT)
                            FROM read_parquet({src}) GROUP BY sub HAVING sum((type IN (1,2,3))::INT) > 0""")
            con.execute(f"""INSERT INTO pers SELECT sub, year(lsd) FROM read_parquet({src})
                            WHERE instrument = 'VIIRS' AND conf_ok AND coalesce(type, 0) = 0
                            GROUP BY sub, year(lsd) HAVING count(DISTINCT m) >= {MASK_PERSIST_MONTHS}""")
        # a year split across two UTC-year files can appear twice in pers -> count distinct years
        con.execute(f"""CREATE TEMP TABLE core AS
            WITH t AS (SELECT sub, sum(n_static) ns, sum(n_typed) nt FROM typed GROUP BY sub),
            p AS (SELECT sub FROM pers GROUP BY sub HAVING count(DISTINCT y) >= {MASK_PERSIST_YEARS})
            SELECT sub, 'typed' AS reason FROM t WHERE ns >= {MASK_TYPED_MIN}
                 OR (nt >= {MASK_TYPED_SHARE_N} AND ns > 0.5 * nt)
            UNION SELECT sub, 'persistent' FROM p""")
        con.execute(f"""COPY (
            WITH c AS (SELECT sub, string_agg(DISTINCT reason, '+') reason FROM core GROUP BY sub),
            nb AS (SELECT DISTINCT (sub // {SUB_NX} + dy) * {SUB_NX} + (sub % {SUB_NX} + dx) AS sub
                   FROM c, range(-1, 2) a(dy), range(-1, 2) b(dx)
                   WHERE sub // {SUB_NX} + dy BETWEEN 0 AND 14399 AND sub % {SUB_NX} + dx BETWEEN 0 AND {SUB_NX - 1})
            SELECT nb.sub::UINTEGER AS sub, c.sub IS NOT NULL AS core, coalesce(c.reason, 'dilated') AS reason
            FROM nb LEFT JOIN c USING (sub) ORDER BY sub) TO '{posix(OUT)}' (FORMAT parquet)""")
        print(con.execute(f"SELECT reason, count(*) n FROM '{posix(OUT)}' GROUP BY 1 ORDER BY 1").df()
              .to_string(index=False))


def used_sql(points: str) -> str:
    """Rows of `points` (a relation) with the `used` flag: confidence ok, type 0 (or none), outside the static mask,
    and not removed by the land and burst screen (screen.py): a row without `type` (near-real-time) in a water
    cell, or a suspect row of a near-real-time burst day. Before the screen stage has run, only the first three
    conditions apply."""
    from .screen import EXCLUDED, WATER
    if not (WATER.exists() and EXCLUDED.exists()):
        return f"""SELECT p.*, (p.conf_ok AND coalesce(p.type, 0) = 0 AND sm.sub IS NULL) AS used
                   FROM {points} p LEFT JOIN read_parquet('{posix(OUT)}') sm ON p.sub = sm.sub"""
    return f"""SELECT p.*, (p.conf_ok AND coalesce(p.type, 0) = 0 AND sm.sub IS NULL
                            AND NOT (p.type IS NULL AND sw.l0 IS NOT NULL)
                            AND sx.l0 IS NULL) AS used
               FROM {points} p LEFT JOIN read_parquet('{posix(OUT)}') sm ON p.sub = sm.sub
               LEFT JOIN read_parquet('{posix(WATER)}') sw ON sw.l0 = p.l0
               LEFT JOIN read_parquet('{posix(EXCLUDED)}') sx
                 ON sx.l0 = p.l0 AND sx.satellite = p.satellite AND sx.utc_date = p.utc_date"""
