"""Reconciliation checks; prints a report and writes data/work/verify.json.

1. raw CSV lines vs rows read vs normalized rows per sensor-year
   (rows_out = read - dups - URT superseded - NRT superseded).
2. Quality and supersession: no (satellite, UTC date) holds both SP and NRT rows; no row whose FIRMS version
   is not purely numeric (NRT / URT / RT suffix) is labelled sp, and no numeric version is labelled nrt; no
   satellite-month loses more than SUPERSEDE_MAX_SHARE of its rows to supersession unless SP covers the whole
   month.
3. Sum of nmod / nvii in L0 tiles equals the count of `used` MODIS / VIIRS rows in [m_first, m_last].
4. L0, L1, L2 totals of meq, kv, v, nmod, nvii are identical (levels are additive); kvsq within 1e-4.
5. Points archive rows equal normalized rows; row groups <= 50 000; files sorted by the documented order
   (1-degree block = floor(lat), floor(lon); UTC month; L0 cell; acq_time_utc), checked on the largest,
   median and smallest file.
6. Official per-country CSVs (fresh download) match the rows read from the zip and the rows kept.
7. Top harmonized anomaly months per realm (H / median of the same month-of-year, 2003-2022).
"""
from __future__ import annotations

import json
import subprocess

from .build_points import INDEX as POINTS_INDEX, OUT_DIR as POINTS_OUT
from .build_tiles import META, TILES
from .common import connect, posix, run_info, timed, write_json
from .config import COUNTRY_CSV_DIR, FIRMS_COUNTRY_BASE, POINTS_DIR, RAW, WORK
from .normalize import SP_VERSION_RE, STATS_DIR
from .static_mask import used_sql

OUT = WORK / "verify.json"
SAMPLES = [("modis", 2019, "Bolivia"), ("viirs-snpp", 2020, "Zambia"), ("viirs-jpss1", 2023, "Paraguay"),
           ("modis", 2005, "Angola"), ("viirs-snpp", 2024, "Argentina")]
GLOBAL_SAMPLES = [("modis", 2019, "Brazil"), ("viirs-snpp", 2020, "Australia"), ("viirs-jpss1", 2023, "Canada")]
SENSOR_OF_PREFIX = {"modis": "modis", "viirs-snpp": "viirs-snpp", "viirs-jpss1": "viirs-noaa20"}
SUPERSEDE_MAX_SHARE = 0.02    # max share of a satellite-month's rows lost to supersession without whole-month SP


def main(force: bool = False) -> None:
    con = connect()
    res: dict = {}
    ok_all = True

    def check(name: str, ok: bool, detail) -> None:
        nonlocal ok_all
        ok_all &= bool(ok)
        res[name] = {"ok": bool(ok), "detail": detail}
        print(f"  [{'OK ' if ok else 'FAIL'}] {name}: {json.dumps(detail, default=str)[:300]}", flush=True)

    with timed("verify"):
        meta = json.loads(META.read_text())
        m0, m1 = meta["m_first"], meta["m_last"]
        # 1. raw vs normalized
        rows, bad = [], []
        for f in sorted(STATS_DIR.glob("*.json")):
            s = json.loads(f.read_text())
            r = {k: s.get(k) for k in ("sensor", "year", "raw_lines", "rows_read_bulk", "rows_read_api", "rows_read",
                                       "dup_rows", "cross_country_dup_rows", "urt_superseded", "nrt_superseded",
                                       "rows_out")}
            consistent = (s["rows_read"] - s["dup_rows"] - s.get("urt_superseded", 0) - s["nrt_superseded"]
                          == s["rows_out"]
                          and s.get("rows_read_bulk", 0) == s["raw_lines"])
            r["ok"] = consistent
            rows.append(r)
            if not consistent:
                bad.append(f.stem)
        tot_read = sum(r["rows_read"] for r in rows)
        check("raw_vs_normalized", not bad, {"sensor_years": len(rows), "bad": bad,
              "rows_read": tot_read, "rows_out": sum(r["rows_out"] for r in rows),
              "dup_rate": sum(r["dup_rows"] for r in rows) / max(tot_read, 1),
              "cross_country_dup_rate": sum(r["cross_country_dup_rows"] for r in rows) / max(tot_read, 1)})
        res["per_sensor_year"] = rows

        pts = f"read_parquet('{posix(POINTS_DIR)}/*/*.parquet', union_by_name=true)"
        # 2. quality labels and SP/NRT supersession
        ov = con.execute(f"""SELECT count(*) FROM (SELECT satellite, CAST(acq_time_utc AS DATE) d FROM {pts}
                             GROUP BY ALL HAVING count(DISTINCT quality) > 1)""").fetchone()[0]
        check("sp_nrt_overlap_zero", ov == 0, {"satellite_days_with_both": ov})
        lab = con.execute(f"""SELECT quality, coalesce(version, 'NULL') version, count(*) n,
                regexp_full_match(trim(coalesce(version, '')), '{SP_VERSION_RE}') numeric
            FROM {pts} GROUP BY ALL ORDER BY 1, 2""").fetchall()
        wrong = [{"quality": q, "version": v, "rows": n} for q, v, n, num in lab if (q == "sp") != bool(num)]
        check("quality_label", not wrong, {"mislabelled": wrong,
              "versions": {f"{q}|{v}": n for q, v, n, _ in lab}})
        sup_bad, sup_rows, no_detail = [], [], []
        for r in rows:
            st = json.loads((STATS_DIR / f"{r['sensor']}_{r['year']}.json").read_text())
            if "supersession" not in st:
                if st.get("nrt_superseded", 0):
                    no_detail.append(f"{r['sensor']}_{r['year']}")
                continue
            for e in st["supersession"]:
                share = e["superseded"] / max(e["nrt_rows"] + e["sp_rows"], 1)
                row = {**e, "sensor": r["sensor"], "share_lost": round(share, 4)}
                if e["superseded"]:
                    sup_rows.append(row)
                if share > SUPERSEDE_MAX_SHARE and not e["sp_covers_month"]:
                    sup_bad.append(row)
        check("supersession_bounded", not sup_bad and not no_detail,
              {"max_share_without_whole_month_sp": SUPERSEDE_MAX_SHARE, "violations": sup_bad,
               "stats_without_detail": no_detail, "superseded_satellite_months": sup_rows})

        # 3. used rows vs tile detection counts
        used = con.execute(f"""SELECT count(*) FILTER (instrument = 'MODIS'), count(*) FILTER (instrument = 'VIIRS')
                               FROM ({used_sql(pts)}) WHERE used AND m BETWEEN {m0} AND {m1}""").fetchone()
        lv = {}
        for L in (0, 1, 2):
            lv[L] = con.execute(f"""SELECT sum(meq), sum(kv), sum(v), sum(nmod), sum(nvii), sum(kvsq), count(*)
                                    FROM read_parquet('{posix(TILES)}/L{L}/*.parquet')""").fetchone()
        check("tiles_counts_equal_used_rows", (lv[0][3], lv[0][4]) == used,
              {"used_modis": used[0], "used_viirs": used[1], "tile_nmod": lv[0][3], "tile_nvii": lv[0][4]})
        # 4. additivity
        same = all(lv[L][:5] == lv[0][:5] for L in (1, 2))
        kvsq_ok = all(abs(lv[L][5] - lv[0][5]) <= 1e-4 * max(lv[0][5], 1) for L in (1, 2))
        check("levels_additive", same and kvsq_ok,
              {f"L{L}": dict(zip(["meq", "kv", "v", "nmod", "nvii", "kvsq", "rows"], lv[L])) for L in lv})
        idx = json.loads((TILES / "index.json").read_text())
        res["tiles"] = {L: {"files": len(t), "bytes": sum(b for b, _ in t.values()), "rows": sum(r for _, r in t.values())}
                        for L, t in idx.items()}

        # 5. points archive
        pidx = json.loads(POINTS_INDEX.read_text())
        prow = sum(r for t in pidx.values() for _, r in t.values())
        nrow = con.execute(f"SELECT count(*) FROM {pts}").fetchone()[0]
        rg = con.execute(f"SELECT max(row_group_num_rows) FROM parquet_metadata('{posix(POINTS_OUT)}/*/*.parquet')").fetchone()[0]
        by_size = sorted(POINTS_OUT.glob("*/*.parquet"), key=lambda p: p.stat().st_size)
        samples_sort = list(dict.fromkeys([by_size[-1], by_size[len(by_size) // 2], by_size[0]]))
        # documented order (build_points.py): floor(lat), floor(lon), UTC month, L0 cell (normalize's grid), time;
        # rows are compared with their predecessor in file order (file_row_number), so the result is exact
        key = """floor(latitude) AS k1, floor(longitude) AS k2, month(acq_time_utc) AS k3,
              (least(greatest(floor((latitude + 90) * 80), 0), 14399)::BIGINT // 4) * 7200
                + least(greatest(floor((longitude + 180) * 80), 0), 28799)::BIGINT // 4 AS k4, acq_time_utc AS k5"""
        unsorted = {}
        for f in samples_sort:
            unsorted[f"{f.parent.name}/{f.name}"] = con.execute(f"""
                WITH r AS (SELECT {key}, file_row_number fr FROM read_parquet('{posix(f)}', file_row_number=true)),
                l AS (SELECT *, lag(k1) OVER w p1, lag(k2) OVER w p2, lag(k3) OVER w p3, lag(k4) OVER w p4,
                             lag(k5) OVER w p5 FROM r WINDOW w AS (ORDER BY fr))
                SELECT count(*) FROM l WHERE p1 IS NOT NULL AND (k1 < p1 OR (k1 = p1 AND (k2 < p2 OR (k2 = p2 AND
                  (k3 < p3 OR (k3 = p3 AND (k4 < p4 OR (k4 = p4 AND k5 < p5))))))))""").fetchone()[0]
        check("points_archive", prow == nrow and rg <= 50000 and not any(unsorted.values()),
              {"rows": prow, "normalized_rows": nrow, "max_row_group": rg,
               "bytes": sum(b for t in pidx.values() for b, _ in t.values()),
               "files": sum(len(t) for t in pidx.values()),
               "sort_order": "floor(lat), floor(lon), UTC month, L0 cell, acq_time_utc",
               "sort_violations": unsorted})

        # 6. official per-country CSVs
        countries = run_info().get("countries")
        samples = [s for s in SAMPLES if not countries or s[2] in countries] if countries else GLOBAL_SAMPLES
        idx_sizes = {}
        with (RAW / "yearly_summary_files.txt").open() as fh:
            for line in fh.read().splitlines()[1:]:
                n, sz, _ = line.split(",", 2)
                idx_sizes[n] = int(sz)
        out = []
        for prefix, year, country in samples:
            name = f"{prefix}_{year}_{country}.csv"
            dest = COUNTRY_CSV_DIR / name
            if not dest.exists() or dest.stat().st_size != idx_sizes.get(name):
                dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    subprocess.run(["curl", "-sSfL", "--retry", "3", "-o", str(dest), f"{FIRMS_COUNTRY_BASE}/{name}"],
                                   check=True)
                except subprocess.CalledProcessError as e:
                    out.append({"file": name, "error": str(e)})
                    continue
            official = con.execute(f"SELECT count(*) FROM read_csv('{posix(dest)}', header=true, all_varchar=true)").fetchone()[0]
            st = json.loads((STATS_DIR / f"{SENSOR_OF_PREFIX[prefix]}_{year}.json").read_text())
            out.append({"file": name, "official_rows": official,
                        "zip_rows": st["rows_read_by_country"].get(country),
                        "normalized_rows": st["rows_kept_by_country"].get(country)})
        check("official_country_csv", all(o.get("official_rows") == o.get("zip_rows") for o in out), out)

        # 7. top anomaly months per realm
        sw = meta["default_switch_m"]
        realm = {s["id"]: s["realm"] or "?" for s in meta["strata"]}
        df = con.execute(f"""SELECT stratum, m, sum(CASE WHEN m < {sw} THEN meq ELSE kv END) / 100.0 h
                             FROM read_parquet('{posix(TILES)}/L2/*.parquet') GROUP BY ALL""").df()
        df["realm"] = df.stratum.map(realm)
        g = df.groupby(["realm", "m"]).h.sum().unstack(0).reindex(range(m0, m1 + 1)).fillna(0)
        tops = {}
        for r in g.columns:
            s = g[r]
            base = s[(s.index // 12 >= 3) & (s.index // 12 <= 22)]
            med = base.groupby(base.index % 12).median()
            ratio = s / s.index.map(lambda m: max(med.get(m % 12, 0), 1.0))
            excess = s - s.index.map(lambda m: med.get(m % 12, 0))

            def fmt(m):
                return {"month": f"{2000 + m // 12}-{m % 12 + 1:02d}", "h": round(float(s[m])),
                        "x_median": round(float(ratio[m]), 2), "excess": round(float(excess[m]))}
            tops[r] = {"by_ratio": [fmt(m) for m in ratio.sort_values(ascending=False).head(6).index],
                       "by_excess": [fmt(m) for m in excess.sort_values(ascending=False).head(6).index]}
        res["top_anomalies_by_realm"] = tops
        for r, t in tops.items():
            for kind, lst in t.items():
                print(f"  top anomalies {r} {kind}: " + ", ".join(f"{x['month']} x{x['x_median']}" for x in lst))
    res["ok"] = ok_all
    write_json(OUT, res)
    print(f"[verify] {'ALL OK' if ok_all else 'FAILURES'} -> {OUT}")
