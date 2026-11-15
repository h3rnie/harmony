"""Tile pyramid + meta.json per schema/data-contract.md.

- L0 values come from calibrate.l0_values_sql() (cube x coefficients, coverage-corrected), are
  scaled x100 and rounded to integers at L0 only; L1/L2 are exact integer sums of L0 rows, so the
  levels are additive by construction. kvsq at L0 = (kv/100)^2 from the rounded kv, summed upward.
- One Parquet file per tile, written by DuckDB COPY (Parquet v1, ZSTD), sorted (cell, stratum, m, dn),
  integer columns as UINT32 / UINT16 / UINT8 exactly as in the contract (hyparquet-readable).
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone

import numpy as np

from .afcd import OUT as CUBE, data_through
from .availability import OUT_M as AVAIL_M
from .calibrate import CALIB_JSON, COEF, l0_values_sql
from .harmonize import HARM_JSON
from .common import connect, fresh, is_regional, posix, run_info, timed, write_json
from .config import DIST, FIT_END, FIT_START, BRIDGE_END, BRIDGE_START, K_MIN_SUM, LEVELS, L0_NX
from . import config as C
from .normalize import api_span
from .strata import OUT_STRATA

TILES = DIST / "tiles"
META = DIST / "meta.json"
COLS = "cell, stratum, m, dn, meq, kv, kvsq, v, nmod, nvii"


def level_sql(level: int) -> str:
    """Rows of level `level` with tile coordinates, aggregated from table t0 (L0 rows)."""
    cdeg, tdeg = LEVELS[level]
    f = round(cdeg / LEVELS[0][0])            # L0 cells per cell side
    nx = round(360 / cdeg)
    per_tile = round(tdeg / cdeg)             # cells per tile side
    ix, iy = f"((cell % {L0_NX}) // {f})", f"((cell // {L0_NX}) // {f})"
    return f"""SELECT ({iy} * {nx} + {ix})::UINTEGER AS cell, stratum, m, dn,
                 sum(meq)::UINTEGER meq, sum(kv)::UINTEGER kv, sum(kvsq)::FLOAT kvsq, sum(v)::UINTEGER v,
                 sum(nmod)::UINTEGER nmod, sum(nvii)::UINTEGER nvii,
                 {ix} // {per_tile} AS tx, {iy} // {per_tile} AS ty
               FROM t0 GROUP BY ALL"""


def write_level(con, level: int) -> dict:
    out_dir = TILES / f"L{level}"
    out_dir.mkdir(parents=True, exist_ok=True)
    con.execute(f"CREATE OR REPLACE TEMP TABLE lv AS {level_sql(level)} ORDER BY tx, ty, cell, stratum, m, dn")
    index = {}
    for tx, ty, n in con.execute("SELECT tx, ty, count(*) FROM lv GROUP BY ALL ORDER BY 1, 2").fetchall():
        path = out_dir / f"{tx}_{ty}.parquet"
        con.execute(f"""COPY (SELECT {COLS} FROM lv WHERE tx = {tx} AND ty = {ty} ORDER BY cell, stratum, m, dn)
                        TO '{posix(path)}' (FORMAT parquet, COMPRESSION zstd, PARQUET_VERSION v1)""")
        index[f"{tx}_{ty}"] = [path.stat().st_size, int(n)]
    return index


def build_meta(con, cal: dict) -> dict:
    m_last = cal["m_last"]
    am = con.execute(f"SELECT * FROM '{posix(AVAIL_M)}' WHERE m <= {m_last} ORDER BY m").df().set_index("m")
    am = am.reindex(range(m_last + 1), fill_value=0)
    strata = con.execute(f"SELECT * FROM '{posix(OUT_STRATA)}' ORDER BY id").df()
    k = con.execute(f"SELECT * FROM '{posix(COEF / 'k.parquet')}' ORDER BY s, dn, moy").df()
    sp = con.execute(f"SELECT * FROM '{posix(COEF / 'strata_params.parquet')}' ORDER BY s, dn").df()
    st = []
    for r in strata.itertuples():
        p = sp[sp.s == r.id].sort_values("dn")
        kk = k[k.s == r.id]
        st.append({"id": int(r.id), "biome": int(r.biome), "realm": r.realm, "name": r.name,
                   "relvar": [round(float(x), 6) for x in p.relvar],
                   "alpha": [round(float(x), 6) for x in p.alpha],
                   "relvar_bridge": [round(float(x), 6) for x in p.relvar_bridge],
                   "k": [[round(float(x), 5) for x in kk[kk.dn == d].sort_values("moy").k] for d in (0, 1)]})
    through = data_through(con)
    api = {}
    for d in sorted(p for p in C.API_DIR.glob("*") if p.is_dir()):
        spans = [sp for f in d.glob("*.csv") if (sp := api_span(f))]
        if spans:
            api[d.name] = f"{min(a for a, _ in spans)}..{max(b for _, b in spans)}"
    sources = [
        {"name": "FIRMS MODIS C6.1 (MCD14ML) Terra+Aqua, country yearly files", "years": "2000-2025",
         "quality": "standard"},
        {"name": "FIRMS VIIRS 375 m S-NPP (VNP14IMGT), country yearly files", "years": "2012-2025",
         "quality": "standard"},
        {"name": "FIRMS VIIRS 375 m NOAA-20 (VJ114IMGT), country yearly files", "years": "2018-2025",
         "quality": "standard"},
        *({"name": f"FIRMS area API {s} (world, 5-day windows)", "years": span,
           "quality": "nrt" if s.endswith("NRT") else "standard"} for s, span in api.items()),
        {"name": "RESOLVE Ecoregions 2017 (biome x realm strata)", "years": "2017", "quality": "reference"},
    ]
    harm = json.loads(HARM_JSON.read_text()) if HARM_JSON.exists() else None
    if harm:
        for s in st:
            err = harm["strata_err"][s["id"]] if s["id"] < len(harm["strata_err"]) else None
            if err:
                s["err"] = err
    meta = {
        "version": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data_through": through,
        "m_first": cal["m_first"], "m_last": m_last,
        "levels": [{"level": lv, "cell_deg": c, "tile_deg": t, "nx": round(360 / c), "ny": round(180 / c)}
                   for lv, (c, t) in LEVELS.items()],
        "aqua_start_m": cal["aqua_start_m"],
        "viirs_start_m": cal["viirs_start_m"],
        "default_switch_m": cal["default_switch_m"],
        "fit_window_m": cal["fit_window_m"],
        "months": {
            "cov_modis": [round(float(x), 4) for x in am.cov_modis],
            "cov_viirs": [round(float(x), 4) for x in am.cov_viirs],
            "provisional": [int(x > 0) for x in am.nrt_rows],
            "viirs_sats": [int(x) for x in am.viirs_sats],
            "days_modis": [round(float(x), 4) for x in am.days_modis],
            "days_viirs": [round(float(x), 4) for x in am.days_viirs],
        },
        # A month drives statistics only when its serving stream(s) delivered data on >= this share of its days.
        "complete_min_coverage": C.COV_COMPLETE,
        "strata": st,
        "ci_scale": round(cal["ci_scale"], 4),    # legacy: used only when the harmonization fields are absent
        "method": {
            "unit": "AFCD-M: MODIS-equivalent active-fire cell-days (distinct 0.0125 deg sub-cell x local-solar "
                    "date x day|night with >= 1 accepted detection)",
            "filters": {"modis_min_confidence": C.MODIS_MIN_CONFIDENCE, "viirs_confidence": list(C.VIIRS_OK_CONFIDENCE),
                        "type": "0 (NULL for NRT)",
                        "static_mask": {"sub_deg": C.SUB_DEG, "typed_min": C.MASK_TYPED_MIN,
                                        "typed_share_min_n": C.MASK_TYPED_SHARE_N,
                                        "persist_months": C.MASK_PERSIST_MONTHS, "persist_years": C.MASK_PERSIST_YEARS,
                                        "dilation": "8-neighbourhood, 1 sub-cell"}},
            "availability": "regional: operating period minus known outages" if is_regional()
                            else f"global: count > {C.AVAIL_FRACTION} x centred {C.AVAIL_WINDOW}-day median",
            # Read by the kernel to undo the scaling of a partial (in-progress) month: it shows what was
            # detected so far and keeps the scaled value as the full-month projection.
            "coverage_correction": {"min_cov": C.COV_MIN, "max_factor": C.COV_MAX_CORR},
            "completeness": f"a month enters statistics when its serving stream(s) delivered data on >= "
                            f"{C.COV_COMPLETE} of its days (months.days_modis / days_viirs); below that it is "
                            "drawn and flagged partial (in progress)",
            "viirs_stream": "per-day mean over available VIIRS satellites, NOAA-20/21 scaled to S-NPP per stratum x dn",
            "calibration": "ratio of sums (quasi-Poisson, log link, log V offset) per stratum x dn x month-of-year "
                           "with fallback stratum x dn -> biome x dn -> global x dn",
            "k_min_sum": K_MIN_SUM,
            "fit_window": [f"{FIT_START[0]}-{FIT_START[1]:02d}", f"{FIT_END[0]}-{FIT_END[1]:02d}"],
            "bridge_window": [f"{BRIDGE_START[0]}-{BRIDGE_START[1]:02d}", f"{BRIDGE_END[0]}-{BRIDGE_END[1]:02d}"],
            "tau": cal["tau"], "tau_bridge": cal["tau_bridge"], "tau_grid": [None if np.isinf(t) else t for t in C.TAU_GRID],
            "cell_multiplier": "r = (sum M + tau) / (sum k V + tau) per L0 cell x dn (tau null = no multiplier)",
            "strata": "RESOLVE Ecoregions 2017 biome x realm; nearest ecoregion within 0.25 deg, else Unclassified",
            "scope": "regional: " + ", ".join(run_info()["countries"]) if is_regional() else "global",
        },
        "sources": sources,
    }
    if harm:
        meta["fusion"] = harm["fusion"]
        meta["drift"] = harm["drift"]
        meta["conformal"] = harm["conformal"]
        meta["method"]["harmonization"] = (
            "default series = per stratum x dn precision-weighted fusion of MODIS-derived meq and calibrated VIIRS kv "
            "(error model by triple collocation, strata[].err; common-mode correlation fusion.kappa); MODIS corrected "
            "for orbit drift from drift.start_year (drift); 80/95 % bounds from split-conformal multipliers "
            "(conformal) on a shifted log, log(x + 0.5); ci_scale is legacy")
    return meta


def main(force: bool = False) -> None:
    deps = [CUBE, CALIB_JSON, COEF / "k.parquet", COEF / "r.parquet", HARM_JSON]
    if not force and fresh(TILES / "index.json", deps) and fresh(META, deps):
        print("[tiles] up to date")
        return
    cal = json.loads(CALIB_JSON.read_text())
    con = connect()
    shutil.rmtree(TILES, ignore_errors=True)
    index = {}
    with timed("tiles L0 rows"):
        con.execute(f"""CREATE TEMP TABLE t0 AS
            WITH x AS (SELECT l0, s, m, dn, round(meq * 100)::UINTEGER meq, round(kv * 100)::UINTEGER kv,
                         round(v * 100)::UINTEGER v, nmod::UINTEGER nmod, nvii::UINTEGER nvii
                       FROM ({l0_values_sql()}))
            SELECT l0::UINTEGER AS cell, s::USMALLINT AS stratum, m::USMALLINT AS m, dn::UTINYINT AS dn,
                   meq, kv, ((kv / 100.0) ^ 2)::FLOAT AS kvsq, v, nmod, nvii
            FROM x WHERE meq > 0 OR kv > 0 OR v > 0 OR nmod > 0 OR nvii > 0""")
    for level in LEVELS:
        with timed(f"tiles L{level}"):
            index[f"L{level}"] = write_level(con, level)
            print(f"  L{level}: {len(index[f'L{level}'])} tiles, "
                  f"{sum(b for b, _ in index[f'L{level}'].values()) / 1e6:.1f} MB, "
                  f"{sum(r for _, r in index[f'L{level}'].values()):,} rows")
    write_json(TILES / "index.json", index, compact=True)
    write_json(META, build_meta(con, cal))
