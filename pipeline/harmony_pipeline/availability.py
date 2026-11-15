"""Satellite-day availability and monthly stream coverage.

Outputs
- data/work/availability.parquet: satellite, date (UTC), n (all detections), med31, available,
  nviirs (number of VIIRS satellites available that date).
- data/work/availability_monthly.parquet: m, ndays, f_<sat> (fraction of days available),
  cov_terra, cov_modis, cov_viirs, viirs_sats (bitmask 1 S-NPP, 2 NOAA-20, 4 NOAA-21), nrt_rows.

Rules
- Global run: a satellite-day is available if its global count n > 5 % of the centred 31-day
  rolling median of n for that satellite (zero-filled within its operating period). This catches
  outages and partial-coverage days without hand-maintained lists.
- Regional run: regional counts are legitimately zero off-season, so the count rule would flag
  quiet days as outages. Instead a satellite is available on every day inside its operating period
  (nominal period clipped to the first/last date it appears in the data) except the known outages
  in config.KNOWN_OUTAGES.
- Both rules: a satellite is unavailable on dates no input file of its sensor covers (bulk files
  cover their whole year, API files their window), so gaps in an API backfill are never read as
  "no fire".
- Coverage: cov_terra = f_terra; cov_modis = f_terra before AQUA_START, else (f_terra + f_aqua)/2
  (each MODIS satellite contributes half of the nominal overpasses); cov_viirs = fraction of days
  with >= 1 VIIRS satellite available (V is a per-day mean, so one satellite gives a full day).
  Days after data_through count as missing, so a partial last month has cov < 1.
- Day coverage (for completeness, config.COV_COMPLETE): days_modis = fraction of days with >= 1 MODIS
  satellite available (Terra before AQUA_START); days_viirs = cov_viirs. A month whose serving stream
  delivered data on fewer than COV_COMPLETE of its days is not used in statistics (the month in progress,
  or a Terra-only month with an outage); an outage of one MODIS satellite while the other flies leaves
  days_modis at 1 (the month is coverage-corrected, and complete).
"""
from __future__ import annotations

import json

from .common import connect, fresh, is_regional, points_glob, posix, timed
from .config import (AQUA_START, AVAIL_FRACTION, AVAIL_WINDOW, KNOWN_OUTAGES, OPERATING, POINTS_DIR,
                     VIIRS_BIT, WORK, month_index)
from .normalize import STATS_DIR

OUT = WORK / "availability.parquet"
OUT_M = WORK / "availability_monthly.parquet"


def main(force: bool = False) -> None:
    inputs = list(POINTS_DIR.glob("*/*.parquet"))
    if not force and fresh(OUT_M, inputs) and fresh(OUT, inputs):
        print("[availability] up to date")
        return
    regional = is_regional()
    con = connect()
    with timed("availability"):
        con.execute(f"""CREATE TEMP TABLE cnt AS SELECT satellite, utc_date AS date, count(*) AS n,
                        sum((quality = 'nrt')::INT) AS nrt FROM read_parquet('{points_glob()}') GROUP BY ALL""")
        through = con.execute("SELECT max(date) FROM cnt").fetchone()[0]
        op_rows = []
        for sat, (start, end) in OPERATING.items():
            op_rows.append(f"('{sat}', DATE '{start}', {f"DATE '{end}'" if end else 'NULL'})")
        con.execute("CREATE TEMP TABLE op AS SELECT * FROM (VALUES " + ",".join(op_rows) +
                    ") t(satellite, d0, d1)")
        # operating period = nominal period clipped to the dates the satellite appears in the data
        con.execute(f"""CREATE TEMP TABLE per AS
            SELECT op.satellite, greatest(op.d0, c.dmin) AS d0,
                   least(coalesce(op.d1, DATE '{through}'), c.dmax) AS d1
            FROM op JOIN (SELECT satellite, min(date) dmin, max(date) dmax FROM cnt GROUP BY 1) c
            USING (satellite)""")
        # input coverage: a satellite can only be available on dates some input file of its sensor covers
        sat_of = {"modis": ("Terra", "Aqua"), "viirs-snpp": ("SNPP",), "viirs-noaa20": ("NOAA20",),
                  "viirs-noaa21": ("NOAA21",)}
        cov_rows = [f"('{sat}', DATE '{a}', DATE '{b}')"
                    for f in sorted(STATS_DIR.glob("*.json"))
                    for st in [json.loads(f.read_text())]
                    for a, b in st.get("coverage", [(f"{st['year']}-01-01", f"{st['year']}-12-31")])
                    for sat in sat_of[st["sensor"]]]
        con.execute("CREATE TEMP TABLE covered(satellite VARCHAR, d0 DATE, d1 DATE)")
        if cov_rows:
            con.execute("INSERT INTO covered VALUES " + ",".join(cov_rows))
        out_rows = [f"('{s}', DATE '{a}', DATE '{b}')" for s, lst in KNOWN_OUTAGES.items() for a, b in lst]
        con.execute("CREATE TEMP TABLE outage(satellite VARCHAR, d0 DATE, d1 DATE)")
        if out_rows:
            con.execute("INSERT INTO outage VALUES " + ",".join(out_rows))
        con.execute(f"""CREATE TEMP TABLE day AS
            SELECT per.satellite, CAST(g.date AS DATE) AS date, coalesce(c.n, 0) AS n
            FROM per, generate_series(per.d0::TIMESTAMP, per.d1::TIMESTAMP, INTERVAL 1 DAY) g(date)
            LEFT JOIN cnt c ON c.satellite = per.satellite AND c.date = CAST(g.date AS DATE)""")
        half = AVAIL_WINDOW // 2
        if regional:
            rule = """NOT EXISTS (SELECT 1 FROM outage o WHERE o.satellite = x.satellite
                                  AND x.date BETWEEN o.d0 AND o.d1)"""
        else:
            rule = f"n > 0 AND n > {AVAIL_FRACTION} * med31"
        rule += """ AND EXISTS (SELECT 1 FROM covered cv WHERE cv.satellite = x.satellite
                                AND x.date BETWEEN cv.d0 AND cv.d1)"""
        con.execute(f"""CREATE TEMP TABLE av AS
            WITH x AS (SELECT *, median(n) OVER (PARTITION BY satellite ORDER BY date
                         ROWS BETWEEN {half} PRECEDING AND {half} FOLLOWING) AS med31 FROM day)
            SELECT satellite, date, n, med31, ({rule}) AS available FROM x""")
        con.execute(f"""COPY (
            SELECT av.*, coalesce(v.nviirs, 0)::UTINYINT AS nviirs FROM av LEFT JOIN
              (SELECT date, count(*) nviirs FROM av WHERE available AND satellite IN ('SNPP','NOAA20','NOAA21')
               GROUP BY 1) v USING (date) ORDER BY satellite, date)
            TO '{posix(OUT)}' (FORMAT parquet, COMPRESSION zstd)""")

        aqua_m = month_index(*AQUA_START)
        bits = " + ".join(f"(max(CASE WHEN satellite = '{s}' AND available THEN {b} ELSE 0 END))"
                          for s, b in VIIRS_BIT.items())
        con.execute(f"""COPY (
            WITH cal AS (SELECT CAST(g.d AS DATE) AS date FROM
                           generate_series(TIMESTAMP '2000-01-01', last_day(DATE '{through}')::TIMESTAMP, INTERVAL 1 DAY) g(d)),
            mon AS (SELECT (year(date) - 2000) * 12 + month(date) - 1 AS m, count(*) AS ndays FROM cal GROUP BY 1),
            per_sat AS (SELECT (year(date) - 2000) * 12 + month(date) - 1 AS m,
                          sum((satellite = 'Terra' AND available)::INT) AS d_terra,
                          sum((satellite = 'Aqua' AND available)::INT) AS d_aqua,
                          sum((satellite = 'SNPP' AND available)::INT) AS d_snpp,
                          sum((satellite = 'NOAA20' AND available)::INT) AS d_noaa20,
                          sum((satellite = 'NOAA21' AND available)::INT) AS d_noaa21,
                          {bits} AS viirs_sats
                        FROM av GROUP BY 1),
            vday AS (SELECT (year(date) - 2000) * 12 + month(date) - 1 AS m, count(DISTINCT date) AS d_viirs
                     FROM av WHERE available AND satellite IN ('SNPP','NOAA20','NOAA21') GROUP BY 1),
            mday AS (SELECT (year(date) - 2000) * 12 + month(date) - 1 AS m, count(DISTINCT date) AS d_modis
                     FROM av WHERE available AND satellite IN ('Terra','Aqua') GROUP BY 1),
            nrt AS (SELECT m, count(*) AS nrt_rows FROM read_parquet('{points_glob()}')
                    WHERE quality = 'nrt' GROUP BY 1)
            SELECT mon.m::USMALLINT AS m, ndays, -- calendar days in month (based on true month)
              coalesce(d_terra, 0) / ndays AS f_terra, coalesce(d_aqua, 0) / ndays AS f_aqua,
              coalesce(d_snpp, 0) / ndays AS f_snpp, coalesce(d_noaa20, 0) / ndays AS f_noaa20,
              coalesce(d_noaa21, 0) / ndays AS f_noaa21,
              f_terra AS cov_terra,
              CASE WHEN mon.m < {aqua_m} THEN f_terra ELSE (f_terra + f_aqua) / 2 END AS cov_modis,
              coalesce(d_viirs, 0) / ndays AS cov_viirs,
              coalesce(d_modis, 0) / ndays AS days_modis,
              coalesce(d_viirs, 0) / ndays AS days_viirs,
              coalesce(viirs_sats, 0)::UTINYINT AS viirs_sats,
              coalesce(nrt_rows, 0) AS nrt_rows
            FROM mon LEFT JOIN per_sat USING (m) LEFT JOIN vday USING (m) LEFT JOIN mday USING (m) LEFT JOIN nrt USING (m)
            ORDER BY m) TO '{posix(OUT_M)}' (FORMAT parquet)""")
        print(f"  rule={'regional (operating period - known outages)' if regional else 'global count'}; "
              f"data_through={through}")
        print(con.execute(f"""SELECT satellite, count(*) AS n_days, sum((NOT available)::INT) AS n_unavailable
                              FROM '{posix(OUT)}' GROUP BY 1 ORDER BY 1""").df().to_string(index=False))
