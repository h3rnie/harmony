"""Normalize FIRMS CSVs (bulk country-year zips / per-country CSVs + area-API pulls) into one
Parquet per sensor-year: data/work/points/{sensor}/{year}.parquet.

Method choices (auditable):
- acq_time and confidence are read as text (acq_time loses leading zeros as int; VIIRS confidence
  is l/n/h). acq_time_utc = acq_date + HHMM.
- Quality from the FIRMS `version`: "sp" (standard, science quality) only for a purely numeric version
  (MODIS `6.03`, `6.2`, `61.03`; VIIRS `2`, `2.0`); every other value, including the near-real-time
  suffixes `NRT` (`6.1NRT`, `2.0NRT`), `URT` (ultra real-time, `2.1URT`), `RT` and a missing version, is
  "nrt" (provisional). `rt_kind` keeps the suffix family (NRT / URT / RT) for de-duplication and stats.
- Exact duplicates on (satellite, acq_time_utc, latitude, longitude) are dropped (neighbouring
  country files overlap along borders); SP is kept over NRT, NRT over URT/RT, then the alphabetically
  first country.
- NRT supersedes URT/RT per granule: an ultra-real-time row is dropped when the same satellite has NRT rows
  at the same acq_time_utc (URT is the provisional first pass of a granule that NRT later reprocesses). In
  the 2026-11 pulls URT rows cover only granules after the last NRT granule and match no NRT row exactly or
  within 10 min / 0.005 deg, so none is dropped; `urt_superseded` counts them.
- SP supersedes NRT per (satellite, UTC month) only where SP genuinely covers the month: the month must be
  covered day by day by the SP inputs (bulk country files = the whole year; API files from an `*_SP`
  source = their date span) and the satellite must have SP rows in it. Where SP covers only some days of a
  month, NRT rows are dropped on those days only (never happens with fetch_api, which pulls SP for whole
  months). `supersession` in the stats lists every satellite-month that lost rows.
- Grid: sub-cell (0.0125 deg) sx = floor((lon+180)*80), sy = floor((lat+90)*80), sub = sy*28800+sx;
  L0 (0.05 deg) = (sy//4)*7200 + sx//4, so sub-cells nest exactly in L0 cells.
- Local-solar date lsd = date(acq_time_utc + lon/15 h); month index m is taken from lsd.
- conf_ok: MODIS confidence >= 30; VIIRS confidence n or h.
- Regional runs keep API rows (which are global) only in L0 cells that occur in the region's
  country-file rows, approximating the country borders used by the bulk files.
"""
from __future__ import annotations

import csv
import json
import re
import shutil
import subprocess
import zipfile
from datetime import date, timedelta
from pathlib import Path

from .common import connect, fresh, posix, timed, write_json
from .config import (API_DIR, API_SOURCES, COUNTRY_CSV_DIR, FIRMS_COUNTRY_BASE,
                     MODIS_MIN_CONFIDENCE, POINTS_DIR, RAW, RUN_JSON, SENSORS, TMP_DIR, WORK, ZIP_DIR)

STATS_DIR = WORK / "normalize_stats"
API_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(\d+)\.csv$")     # {start}_{days}.csv from fetch_api
# Standard (science-quality) FIRMS versions are purely numeric (6.03, 6.2, 61.03, 2, 2.0); anything with a
# letter suffix (NRT, URT, RT, ...) or no version is near-real-time / provisional.
SP_VERSION_RE = r"^[0-9]+(\.[0-9]+)*$"
QUALITY_SQL = f"CASE WHEN regexp_full_match(trim(CAST(version AS VARCHAR)), '{SP_VERSION_RE}') THEN 'sp' ELSE 'nrt' END"
RT_KIND_SQL = (f"CASE WHEN regexp_full_match(trim(CAST(version AS VARCHAR)), '{SP_VERSION_RE}') THEN NULL "
               "WHEN upper(CAST(version AS VARCHAR)) LIKE '%NRT%' THEN 'NRT' "
               "WHEN upper(CAST(version AS VARCHAR)) LIKE '%URT%' THEN 'URT' ELSE 'RT' END")


def api_span(p: Path) -> tuple[date, date] | None:
    m = API_FILE_RE.match(p.name)
    if not m:
        return None
    d0 = date.fromisoformat(m.group(1))
    return d0, d0 + timedelta(days=int(m.group(2)) - 1)


def load_index() -> dict[str, int]:
    with (RAW / "yearly_summary_files.txt").open(newline="") as fh:
        return {r["filename"]: int(r["size"]) for r in csv.DictReader(fh)}


def zip_complete(name: str, idx: dict[str, int]) -> bool:
    p = ZIP_DIR / name
    return name in idx and p.exists() and p.stat().st_size == idx[name]


def country_of(member: str) -> str:
    return Path(member).stem.split("_", 2)[2]


def curl(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(".part")
    subprocess.run(["curl", "-sSfL", "--retry", "5", "--retry-delay", "5", "-o", str(part), url], check=True)
    part.replace(dest)


def bulk_files(sensor: str, year: int, countries: list[str] | None, workdir: Path,
               idx: dict[str, int]) -> list[Path]:
    """CSV files for one sensor-year: extracted from the complete zip, else per-country downloads."""
    prefix, _, y0, y1 = SENSORS[sensor]
    if prefix is None or not (y0 <= year <= y1):
        return []
    zname = f"{prefix}_{year}_all_countries.zip"
    files: list[Path] = []
    if zip_complete(zname, idx):
        workdir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(ZIP_DIR / zname) as z:
            for n in z.namelist():
                if not n.endswith(".csv") or (countries and country_of(n) not in countries):
                    continue
                dest = workdir / Path(n).name
                with z.open(n) as src, dest.open("wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 22)
                files.append(dest)
        return files
    if not countries:
        raise RuntimeError(f"{zname} is missing or incomplete; run fetch_country first")
    for c in countries:
        name = f"{prefix}_{year}_{c}.csv"
        if name not in idx:
            continue
        dest = COUNTRY_CSV_DIR / name
        if not (dest.exists() and dest.stat().st_size == idx[name]):
            curl(f"{FIRMS_COUNTRY_BASE}/{name}", dest)
        files.append(dest)
    return files


def api_files(sensor: str, year: int) -> list[Path]:
    out = []
    for src in API_SOURCES[sensor]:
        for p in sorted((API_DIR / src).glob("*.csv")):
            span = api_span(p)
            if span and span[0].year <= year <= span[1].year and p.stat().st_size > 0:
                out.append(p)
    return out


def api_years(sensor: str) -> set[int]:
    years = set()
    for src in API_SOURCES[sensor]:
        for p in (API_DIR / src).glob("*.csv"):
            span = api_span(p)
            if span:
                years.update(range(span[0].year, span[1].year + 1))
    return years


def count_lines(files: list[Path]) -> int:
    n = 0
    for f in files:
        with f.open("rb") as fh:
            n += max(sum(buf.count(b"\n") for buf in iter(lambda: fh.read(1 << 24), b"")) - 1, 0)
    return n


def normalized_select(con, files: list[Path], sensor: str, from_api: bool) -> str:
    """SELECT statement mapping one homogeneous file set onto the normalized schema."""
    flist = "[" + ",".join(f"'{posix(f)}'" for f in files) + "]"
    reader = (f"read_csv({flist}, header=true, union_by_name=true, filename=true, "
              "types={'acq_time':'VARCHAR','confidence':'VARCHAR','version':'VARCHAR',"
              "'satellite':'VARCHAR','acq_date':'DATE','latitude':'DOUBLE','longitude':'DOUBLE'})")
    cols = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()}
    is_modis = SENSORS[sensor][1] == "MODIS"
    b1 = "brightness" if "brightness" in cols else "bright_ti4"
    b2 = "bright_t31" if "bright_t31" in cols else "bright_ti5"
    typ = "TRY_CAST(type AS TINYINT)" if "type" in cols else "CAST(NULL AS TINYINT)"
    default_sat = {"modis": "NULL", "viirs-snpp": "'SNPP'", "viirs-noaa20": "'NOAA20'",
                   "viirs-noaa21": "'NOAA21'"}[sensor]
    country = ("CAST(NULL AS VARCHAR)" if from_api
               else r"regexp_extract(filename, '_\d{4}_([^/\\]+)\.csv$', 1)")
    conf_ok = (f"TRY_CAST(confidence AS INTEGER) >= {MODIS_MIN_CONFIDENCE}" if is_modis
               else "lower(left(trim(confidence), 1)) IN ('n', 'h')")
    t = "lpad(replace(trim(acq_time), ':', ''), 4, '0')"
    return f"""
    WITH r AS (SELECT * FROM {reader}),
    n AS (
      SELECT latitude, longitude,
        CAST(acq_date AS TIMESTAMP) + to_minutes(CAST(substr({t},1,2) AS INTEGER)*60
                                                 + CAST(substr({t},3,2) AS INTEGER)) AS acq_time_utc,
        coalesce(CASE WHEN satellite IN ('Terra','T') THEN 'Terra'
                      WHEN satellite IN ('Aqua','A') THEN 'Aqua'
                      WHEN satellite IN ('N','NPP','SNPP','S-NPP','Suomi NPP','Suomi-NPP') THEN 'SNPP'
                      WHEN satellite IN ('N20','1','NOAA-20','NOAA20','J1') THEN 'NOAA20'
                      WHEN satellite IN ('N21','2','NOAA-21','NOAA21','J2') THEN 'NOAA21' END,
                 {default_sat}) AS satellite,
        '{SENSORS[sensor][1]}' AS instrument,
        CAST(trim(confidence) AS VARCHAR) AS confidence,
        CAST(frp AS FLOAT) AS frp, CAST(daynight AS VARCHAR) AS daynight,
        {typ} AS type,
        {QUALITY_SQL} AS quality,
        {RT_KIND_SQL} AS rt_kind,
        CAST({b1} AS FLOAT) AS brightness, CAST({b2} AS FLOAT) AS bright_2,
        CAST(scan AS FLOAT) AS scan, CAST(track AS FLOAT) AS track,
        CAST(version AS VARCHAR) AS version,
        {country} AS country,
        {conf_ok} AS conf_ok
      FROM r WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND acq_date IS NOT NULL)
    SELECT *,
      least(greatest(floor((latitude + 90) * 80), 0), 14399)::UINTEGER AS sy,
      least(greatest(floor((longitude + 180) * 80), 0), 28799)::UINTEGER AS sx
    FROM n"""


DERIVED = """
  SELECT latitude, longitude, acq_time_utc, satellite, instrument, confidence, frp, daynight, type,
    quality, brightness, bright_2, scan, track, version, country,
    (sy // 4) * 7200 + sx // 4 AS l0,
    sy * 28800 + sx AS sub,
    CAST(acq_time_utc AS DATE) AS utc_date,
    CAST(acq_time_utc + to_microseconds(CAST(longitude / 15 * 3600e6 AS BIGINT)) AS DATE) AS lsd,
    CAST((year(lsd) - 2000) * 12 + month(lsd) - 1 AS SMALLINT) AS m,
    CAST(CASE WHEN daynight = 'N' THEN 1 ELSE 0 END AS UTINYINT) AS dn,
    coalesce(conf_ok, false) AS conf_ok
"""


def region_cells_sql() -> str:
    """L0 cells seen in country-file rows of the current (regional) run."""
    return (f"SELECT DISTINCT l0 FROM read_parquet('{posix(POINTS_DIR)}/*/*.parquet') "
            "WHERE country IS NOT NULL")


def normalize_one(sensor: str, year: int, countries: list[str] | None, idx: dict[str, int],
                  force: bool) -> dict | None:
    out = POINTS_DIR / sensor / f"{year}.parquet"
    stats_path = STATS_DIR / f"{sensor}_{year}.json"
    afiles = api_files(sensor, year)
    zpath = ZIP_DIR / f"{SENSORS[sensor][0]}_{year}_all_countries.zip"
    if out.exists() and stats_path.exists() and not force and fresh(stats_path, [*afiles, zpath]):
        st = json.loads(stats_path.read_text())
        if st.get("api_files", 0) == len(afiles):
            return st
    workdir = TMP_DIR / f"extract_{sensor}_{year}"
    con = connect()
    try:
        bfiles = bulk_files(sensor, year, countries, workdir, idx)
        if not bfiles and not afiles:
            return None
        # date spans this sensor-year's inputs cover (bulk files = the whole year), for availability
        spans = [(f"{year}-01-01", f"{year}-12-31")] if bfiles else []
        for f in afiles:
            a, b = api_span(f)
            spans.append((max(a, date(year, 1, 1)).isoformat(), min(b, date(year, 12, 31)).isoformat()))
        stats = {"sensor": sensor, "year": year, "raw_lines": count_lines(bfiles),
                 "bulk_files": len(bfiles), "api_files": len(afiles), "coverage": spans}
        parts = []
        if bfiles:
            con.execute(f"CREATE TEMP TABLE b AS {normalized_select(con, bfiles, sensor, False)}")
            parts.append("SELECT * FROM b")
            stats["rows_read_bulk"] = con.execute("SELECT count(*) FROM b").fetchone()[0]
            stats["rows_read_by_country"] = dict(con.execute(
                "SELECT country, count(*) FROM b GROUP BY ALL ORDER BY 1").fetchall())
        if afiles:
            con.execute(f"CREATE TEMP TABLE a AS {normalized_select(con, afiles, sensor, True)}")
            con.execute(f"DELETE FROM a WHERE year(acq_time_utc) <> {year}")
            if countries:
                con.execute(f"CREATE TEMP TABLE rc AS {region_cells_sql()}")
                con.execute("DELETE FROM a WHERE (sy // 4) * 7200 + sx // 4 NOT IN (SELECT l0 FROM rc)")
            parts.append("SELECT * FROM a")
            stats["rows_read_api"] = con.execute("SELECT count(*) FROM a").fetchone()[0]
        con.execute("CREATE TEMP TABLE u AS " + " UNION ALL BY NAME ".join(parts))
        key = "satellite, acq_time_utc, latitude, longitude"
        stats["rows_read"] = con.execute("SELECT count(*) FROM u").fetchone()[0]
        stats["cross_country_dup_rows"] = con.execute(f"""
            SELECT coalesce(sum(n - 1), 0) FROM (SELECT count(*) n FROM u GROUP BY {key}
            HAVING count(DISTINCT country) > 1)""").fetchone()[0]
        stats["rows_read_by_version"] = {f"{q}|{v}": n for q, v, n in con.execute(
            "SELECT quality, coalesce(version, 'NULL'), count(*) FROM u GROUP BY ALL ORDER BY 1, 2").fetchall()}
        con.execute(f"""CREATE TEMP TABLE d AS SELECT * FROM u QUALIFY row_number() OVER (
            PARTITION BY {key} ORDER BY quality = 'nrt', coalesce(rt_kind, '') <> 'NRT' AND quality = 'nrt',
                                        country NULLS LAST) = 1""")
        stats["dup_rows"] = stats["rows_read"] - con.execute("SELECT count(*) FROM d").fetchone()[0]
        # URT / RT rows of a granule (satellite, acq_time_utc) that NRT also delivers: keep the NRT pass
        stats["urt_rows"] = con.execute("SELECT count(*) FROM d WHERE rt_kind IN ('URT', 'RT')").fetchone()[0]
        stats["urt_superseded"] = con.execute("""
            DELETE FROM d WHERE rt_kind IN ('URT', 'RT') AND (satellite, acq_time_utc) IN
              (SELECT DISTINCT satellite, acq_time_utc FROM d WHERE rt_kind = 'NRT')""").fetchone()[0]
        # days covered by SP inputs: bulk files = whole year, SP API files = their span
        sp_spans = [(date(year, 1, 1), date(year, 12, 31))] if bfiles else []
        for f in afiles:
            if f.parent.name.endswith("_SP"):
                a, b = api_span(f)
                sp_spans.append((max(a, date(year, 1, 1)), min(b, date(year, 12, 31))))
        sp_days = sorted({a + timedelta(days=i) for a, b in sp_spans for i in range((b - a).days + 1)})
        con.execute("CREATE TEMP TABLE spd (d DATE)")
        if sp_days:
            con.executemany("INSERT INTO spd VALUES (?)", [(x,) for x in sp_days])
        con.execute(f"""CREATE TEMP TABLE spm AS
            SELECT mo, count(*) = day(last_day(mo)) AS whole FROM (SELECT date_trunc('month', d)::DATE mo FROM spd)
            GROUP BY mo""")
        # satellite-months with SP rows; NRT rows are dropped on SP-covered days of those months only
        con.execute("""CREATE TEMP TABLE sup AS
            SELECT satellite, date_trunc('month', acq_time_utc)::DATE mo,
                   count(*) FILTER (quality = 'nrt') nrt_rows, count(*) FILTER (quality = 'sp') sp_rows
            FROM d GROUP BY ALL HAVING count(*) FILTER (quality = 'sp') > 0 AND count(*) FILTER (quality = 'nrt') > 0""")
        stats["nrt_superseded"] = con.execute("""
            DELETE FROM d WHERE quality = 'nrt'
              AND (satellite, date_trunc('month', acq_time_utc)::DATE) IN (SELECT satellite, mo FROM sup)
              AND CAST(acq_time_utc AS DATE) IN (SELECT d FROM spd)""").fetchone()[0]
        stats["supersession"] = [
            {"satellite": sat, "month": str(mo)[:7], "nrt_rows": int(n), "sp_rows": int(sp),
             "superseded": int(n - left), "sp_covers_month": bool(whole)}
            for sat, mo, n, sp, left, whole in con.execute("""
                SELECT sup.satellite, sup.mo, sup.nrt_rows, sup.sp_rows,
                       (SELECT count(*) FROM d WHERE d.quality = 'nrt' AND d.satellite = sup.satellite
                          AND date_trunc('month', d.acq_time_utc)::DATE = sup.mo),
                       coalesce(spm.whole, false)
                FROM sup LEFT JOIN spm ON spm.mo = sup.mo ORDER BY 1, 2""").fetchall()]
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp.parquet")
        con.execute(f"""COPY ({DERIVED} FROM d ORDER BY acq_time_utc) TO '{posix(tmp)}'
                        (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)""")
        tmp.replace(out)
        stats["rows_out"] = con.execute(f"SELECT count(*) FROM '{posix(out)}'").fetchone()[0]
        stats["rows_kept_by_country"] = dict(con.execute(
            f"SELECT country, count(*) FROM '{posix(out)}' GROUP BY ALL ORDER BY 1").fetchall())
        stats["date_min"], stats["date_max"] = [str(x) for x in con.execute(
            f"SELECT min(utc_date), max(utc_date) FROM '{posix(out)}'").fetchone()]
        write_json(stats_path, stats)
        return stats
    finally:
        con.close()
        shutil.rmtree(workdir, ignore_errors=True)


def sensor_years(sensor: str) -> list[int]:
    _, _, y0, y1 = SENSORS[sensor]
    years = set(range(y0, y1 + 1)) if y0 else set()
    return sorted(years | api_years(sensor))


def main(countries: list[str] | None = None, force: bool = False,
         sensors: list[str] | None = None, years: list[int] | None = None) -> None:
    countries = sorted(c.replace(" ", "_") for c in countries) if countries else None
    prev = json.loads(RUN_JSON.read_text()).get("countries", "unset") if RUN_JSON.exists() else "unset"
    if prev != "unset" and prev != countries:
        print(f"country set changed ({prev} -> {countries}); rebuilding points", flush=True)
        shutil.rmtree(POINTS_DIR, ignore_errors=True)
        shutil.rmtree(STATS_DIR, ignore_errors=True)
        force = True
    write_json(RUN_JSON, {"countries": countries})
    idx = load_index()
    todo = [(s, y) for s in (sensors or SENSORS) for y in sensor_years(s) if not years or y in years]
    # country-file years first: regional API filtering needs the region's cells
    todo.sort(key=lambda sy: (bool(api_files(*sy)), sy))
    for sensor, year in todo:
        with timed(f"normalize {sensor} {year}"):
            st = normalize_one(sensor, year, countries, idx, force)
        if st:
            print(f"  rows_read={st['rows_read']:,} dup={st['dup_rows']:,} "
                  f"(cross-country {st['cross_country_dup_rows']:,}) nrt_superseded={st['nrt_superseded']:,} "
                  f"urt_superseded={st.get('urt_superseded', 0):,} rows_out={st['rows_out']:,}", flush=True)
