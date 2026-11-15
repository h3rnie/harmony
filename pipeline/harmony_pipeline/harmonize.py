"""Harmonization science core: sensor error model, MODIS orbit-drift fingerprint, conformal interval
multipliers, and the validation of the fused record. Runs after `calibrate`; `build_tiles` copies the
kernel parameters into meta.json and this stage adds its tables to validation.json.

Data: `units` = the cube summed to (1-degree cell c1, stratum s, dn, month m) from VIIRS start, each stream
coverage-corrected by its own satellite's monthly availability (NULL when < COV_MIN, so a month without a
satellite is missing, never zero). Streams (AFCD): U Terra∪Aqua (`m_ta`), T Terra (`m_t`), A Aqua (`m_a`),
SN S-NPP (`vs`), N20 NOAA-20, N21 NOAA-21, V the production S-NPP-equivalent VIIRS mean, KV = V k r (the tiles'
`kv`), KV2 = sum of kv^2 at L0. LOYO predictions of `kv` come from calibrate (loyo_c1.parquet).

1. Error model (strata[].err in meta.json). Each stream j is a noisy measurement of the latent MODIS-equivalent
   activity mu of a stratum x dn group: Var_j(mu) = rho_j mu^2 + phi_j mu (rho: stratum-coherent relative variance,
   phi: cell-level dispersion, 1 = Poisson).
   a. phi by triple collocation (TC; Stoffelen 1998, McColl et al. 2014) at 1-degree cell-month on Anscombe
      sqrt values sqrt(X + 3/8 g) of streams rescaled to the Terra∪Aqua scale (g = ratio per s x dn x moy over
      TC_WINDOW), as anomalies from each unit's month-of-year mean (pooled within-unit covariances, so the
      degrees of freedom lose one per unit x moy). Units with a climatological level < 1 AFCD are left out
      (the square root does not stabilise Poisson variance there); zeros of active units are kept.
      Triplets: (Terra, Aqua, S-NPP) 2012-02..2019-12; (Terra, Aqua, VIIRS composite) per number of VIIRS
      satellites (VIIRS_ERAS); (Terra, Aqua, NOAA-20) 2018-2019; (Terra, Aqua, NOAA-21) 2023-03..2025-12.
      phi = 4 e (e = TC error variance on the sqrt scale). Terra∪Aqua is not in a triplet (it contains both);
      under thinned-Poisson sampling with equal native dispersion, phi_U = mean(phi_T'/g_T, phi_A'/g_A).
   b. rho by TC on log stratum-month anomalies (Terra, Aqua, LOYO-calibrated VIIRS, TC_WINDOW) minus the
      Poisson part: rho_j = max(0, e_j - phi_j mean(1/S_jt)); rho_U = (rho_T + rho_A)/4 (Terra∪Aqua ~ mean of
      the two); rho_B = rho_T + relvar_bridge; rho_V is the same for every number of VIIRS satellites (errors
      common to the VIIRS satellites do not average out) and excludes relvar (the kernel adds it).
   c. Common mode kappa: TC cannot separate a shared Aqua/VIIRS (afternoon overpass) error from signal. A second
      identification (equal Terra and Aqua error, free Aqua-VIIRS error covariance g, pooled over strata per dn)
      gives kappa_AV = g / sqrt(e_A e_V) and kappa = kappa_AV / sqrt(2) for Terra∪Aqua, clipped to [0, 0.9].
   d. Cross-check: the variance of the sqrt-scale difference VIIRS - Terra∪Aqua (S-NPP-only years) split in
      proportion to the Poisson expectations of the two streams.
   Fallback when a level is thin or TC is invalid (a non-positive covariance or error variance):
   stratum x dn -> biome x dn -> global x dn (pooled sufficient statistics).
2. Drift fingerprint: ratio observed / expected for Terra, Aqua and Terra∪Aqua, expected = k_ref(s, dn, moy) V
   with satellite-specific ratios fitted on DRIFT_REF_YEARS only; by year, biome, dn, globally and by hemisphere.
   Reference years use leave-one-year-out ratios (placebo: should sit at 1). Intervals: delete-a-group jackknife
   over JACK_GROUPS random groups of 5-degree blocks (the reference ratios are refitted in every replicate).
   Overpass time: mean local-solar time of detections per satellite x stratum x month x dn (night shifted by
   12 h); its shift from the satellite's own 2012-2019 mean for the same stratum x dn x moy is regressed against
   log(ratio) (through the origin) per biome group x dn x satellite: the drift as a natural experiment on the
   diurnal sensitivity of detections. Kernel factors: Terra∪Aqua log ratio per biome x dn x year from
   DRIFT_START_YEAR, sd^2 = jackknife variance + placebo variance (mean square of the reference-year log ratios).
3. Conformal multipliers: scores |log(obs/pred)| / sigma_log of (pred - obs) for LOYO-calibrated VIIRS against
   observed Terra∪Aqua, at three supports (1-degree x biome group, 5-degree x biome group, stratum), pooled per
   (biome group x size class of pred); q = ceil((n+1)p)-th smallest score (split conformal), bins with fewer
   than CONF_MIN_N scores merged with a neighbour size class. Coverage is then measured out of time
   (OOT_TEST_YEARS, frozen fit, against raw and drift-corrected MODIS) next to the legacy ci_scale interval.
4. Validation of the fused record (validation.json): non-circular test (fuse Aqua with VIIRS, score against
   Terra, which neither input contains), MODIS weight by era, change points of the fused global series,
   NOAA-21 blind test, NOAA-20 closure test, power-law diagnostic, and the k change when refitted on 2012-2019.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from .afcd import OUT as CUBE
from .availability import OUT_M as AVAIL_M
from .calibrate import CALIB_JSON, COEF, VALIDATION, fit_k, l0_values_sql, pettitt, r3, sdiv
from .common import connect, fresh, points_glob, posix, timed, write_json
from .config import (BIOME_GROUPS, CONF_MIN_N, CONF_Q_MAX, CONF_SIZE_EDGES, COV_MAX_CORR, COV_MIN, DRIFT_ATTR_FRAC,
                     DRIFT_MIN_EXP, DRIFT_REF_YEARS, DRIFT_START_YEAR, FIT_END, FIT_START, JACK_GROUPS,
                     OOT_TEST_YEARS, TC_MIN_DOF_CELL, TC_MIN_DOF_STRATUM, TC_WINDOW, VIIRS_ERAS, month_index,
                     ym_index)
from .strata import OUT_CELLS, OUT_STRATA

HARM_JSON = COEF / "harmonize.json"
UNITS = COEF / "units_c1.parquet"
LOYO_C1 = COEF / "loyo_c1.parquet"
OVERPASS = COEF / "overpass.parquet"
STRAT_FULL = COEF / "strata_monthly.parquet"
Z80, Z95 = 1.2816, 1.96
C_SHIFT = 0.5        # AFCD; intervals and scores on log(x + C_SHIFT) so that a zero can be covered
CENTER = "unit_moy"  # 1-degree TC centring: "unit_moy" (anomalies) or "group" (stratum x dn mean only)
LEVEL_NAMES = ("stratum_dn", "biome_dn", "global_dn")
STREAMS = ("U", "T", "A", "SN", "N20", "N21", "V", "KV")


def cfn(cov: str) -> str:
    """Coverage factor 1/cov capped at COV_MAX_CORR; NULL (stream missing) below COV_MIN."""
    return f"(CASE WHEN {cov} >= {COV_MIN} THEN least(1.0 / {cov}, {COV_MAX_CORR}) ELSE NULL END)"


# ------------------------------------------------------------------------------------------
# inputs

def build_inputs(con, cal: dict, force: bool) -> None:
    deps = [CUBE, OUT_CELLS, AVAIL_M, COEF / "k.parquet", COEF / "r.parquet", COEF / "noaa.parquet"]
    if force or not fresh(UNITS, deps):
        with timed("harmonize units"):
            v = "(c.ws + nf.c20 * c.w20 + nf.c21 * c.w21)"
            con.execute(f"""COPY (
              WITH c AS (SELECT cu.*, sc.stratum AS s, am.* EXCLUDE (m)
                         FROM read_parquet('{posix(CUBE)}') cu JOIN read_parquet('{posix(OUT_CELLS)}') sc USING (l0)
                         JOIN read_parquet('{posix(AVAIL_M)}') am USING (m)
                         WHERE cu.m BETWEEN {cal['viirs_start_m']} AND {cal['m_last']})
              SELECT (((c.l0 // 7200) // 20) * 360 + (c.l0 % 7200) // 20)::UINTEGER AS c1, c.s::USMALLINT AS s,
                c.dn, c.m,
                sum(c.m_ta * {cfn('c.cov_modis')}) U, sum(c.m_t * {cfn('c.f_terra')}) T,
                sum(c.m_a * {cfn('c.f_aqua')}) A, sum(c.vs * {cfn('c.f_snpp')}) SN,
                sum(c.v20 * {cfn('c.f_noaa20')}) N20, sum(c.v21 * {cfn('c.f_noaa21')}) N21,
                sum({v} * {cfn('c.cov_viirs')}) V,
                sum({v} * {cfn('c.cov_viirs')} * kc.k * coalesce(rc.r, 1)) KV,
                sum(({v} * {cfn('c.cov_viirs')} * kc.k * coalesce(rc.r, 1)) ^ 2) KV2
              FROM c JOIN read_parquet('{posix(COEF / 'k.parquet')}') kc ON kc.s = c.s AND kc.dn = c.dn AND kc.moy = c.m % 12
              JOIN read_parquet('{posix(COEF / 'noaa.parquet')}') nf ON nf.s = c.s AND nf.dn = c.dn
              LEFT JOIN read_parquet('{posix(COEF / 'r.parquet')}') rc ON rc.l0 = c.l0 AND rc.dn = c.dn
              GROUP BY ALL) TO '{posix(UNITS)}' (FORMAT parquet, COMPRESSION zstd)""")
    if force or not fresh(STRAT_FULL, deps):
        with timed("harmonize strata monthly"):
            con.execute(f"""COPY (SELECT s, dn, m, sum(meq) meq, sum(kv) kv, sum(v) v, sum(nmod) nmod, sum(nvii) nvii
                                  FROM ({l0_values_sql()}) GROUP BY ALL)
                            TO '{posix(STRAT_FULL)}' (FORMAT parquet)""")
    pts = sorted((CUBE.parent / "points").glob("*/*.parquet"))
    if force or not fresh(OVERPASS, pts + [OUT_CELLS]):
        with timed("harmonize overpass time"):
            # Mean local-solar time of detections (hours; night shifted by 12 h so it does not wrap at midnight).
            # VIIRS (reference, fixed overpass) is subsampled by sub-cell id to keep the scan short.
            con.execute(f"""COPY (
              WITH p AS (SELECT satellite, l0, m, dn,
                    (hour(acq_time_utc) + minute(acq_time_utc) / 60.0 + longitude / 15.0 + 48 + 12 * dn) % 24 AS h
                  FROM read_parquet('{points_glob()}', union_by_name = true)
                  WHERE conf_ok AND coalesce(type, 0) = 0 AND (instrument = 'MODIS' OR sub % 8 = 0))
              SELECT satellite, sc.stratum AS s, m, dn, count(*) n, avg(h) h, var_samp(h) hvar
              FROM p JOIN read_parquet('{posix(OUT_CELLS)}') sc USING (l0) GROUP BY ALL)
              TO '{posix(OVERPASS)}' (FORMAT parquet)""")


class Ctx:
    """Strata, biome groups, months and production coefficients."""

    def __init__(self, con, cal: dict):
        self.cal = cal
        st = con.execute(f"SELECT * FROM '{posix(OUT_STRATA)}' ORDER BY id").df()
        self.nS = len(st)
        self.biome_code = st.biome.to_numpy().astype(int)
        self.biome_codes, self.biome = np.unique(self.biome_code, return_inverse=True)
        self.nB = len(self.biome_codes)
        self.bname = dict(zip(st.biome, st.biome_name))
        gi = {b: i for i, (_, bs) in enumerate(BIOME_GROUPS) for b in bs}
        self.group_names = [g for g, _ in BIOME_GROUPS]
        self.nG = len(BIOME_GROUPS)
        self.group = np.array([gi.get(int(b), self.nG - 1) for b in self.biome_code])     # per stratum
        sp = con.execute(f"SELECT * FROM '{posix(COEF / 'strata_params.parquet')}' ORDER BY s, dn").df()
        self.relvar = np.zeros((self.nS, 2))
        self.relvar_b = np.zeros((self.nS, 2))
        self.alpha = np.zeros((self.nS, 2))
        self.relvar[sp.s, sp.dn] = sp.relvar
        self.relvar_b[sp.s, sp.dn] = sp.relvar_bridge
        self.alpha[sp.s, sp.dn] = sp.alpha
        k = con.execute(f"SELECT * FROM '{posix(COEF / 'k.parquet')}'").df()
        self.k = np.zeros((self.nS, 2, 12))
        self.k[k.s, k.dn, k.moy] = k.k
        nf = con.execute(f"SELECT * FROM '{posix(COEF / 'noaa.parquet')}'").df()
        self.c20 = np.ones((self.nS, 2))
        self.c21 = np.ones((self.nS, 2))
        self.c20[nf.s, nf.dn] = nf.c20
        self.c21[nf.s, nf.dn] = nf.c21
        am = con.execute(f"SELECT * FROM '{posix(AVAIL_M)}' ORDER BY m").df().set_index("m")
        self.am = am.reindex(range(cal["m_last"] + 1), fill_value=0)
        self.nsat = np.array([bin(int(x)).count("1") for x in self.am.viirs_sats])
        self.ci_scale = float(cal["ci_scale"])


def m_of(ym) -> int:
    return ym_index(ym)


def load_units() -> pd.DataFrame:
    d = pd.read_parquet(UNITS)
    for c in ("c1", "s", "dn", "m"):
        d[c] = d[c].astype(np.int64)
    return d


def ratio_k(num, den, keys, ctx: Ctx, mask) -> np.ndarray:
    """k (nS, 2, 12) = sum num / sum den with the calibrate fallback chain, over rows in `mask`."""
    nK = ctx.nS * 24
    ok = mask & np.isfinite(num) & np.isfinite(den)
    N = np.bincount(keys[ok], num[ok], minlength=nK).reshape(ctx.nS, 2, 12)
    D = np.bincount(keys[ok], den[ok], minlength=nK).reshape(ctx.nS, 2, 12)
    return fit_k(N, D, ctx.biome, ctx.nB)[0]


def key_sdm(d: pd.DataFrame) -> np.ndarray:
    return (d.s.to_numpy() * 2 + d.dn.to_numpy()) * 12 + d.m.to_numpy() % 12


# ------------------------------------------------------------------------------------------
# triple collocation

def anom_stats(X: np.ndarray, unit: np.ndarray, grp: np.ndarray, nGrp: int):
    """Pooled within-(unit) covariance sums of the 3 columns of X, by group.
    `unit` already encodes unit x month-of-year. Returns S (nGrp, 3, 3) and residual dof (nGrp,)."""
    u, inv = np.unique(unit, return_inverse=True)
    cnt = np.bincount(inv)
    means = np.stack([np.bincount(inv, X[:, i]) for i in range(3)], 1) / cnt[:, None]
    Xc = X - means[inv]
    S = np.zeros((nGrp, 3, 3))
    for i in range(3):
        for j in range(i, 3):
            S[:, i, j] = S[:, j, i] = np.bincount(grp, Xc[:, i] * Xc[:, j], minlength=nGrp)
    ugrp = np.zeros(len(u), dtype=np.int64)
    ugrp[inv] = grp
    dof = np.bincount(grp, minlength=nGrp) - np.bincount(ugrp, minlength=nGrp)
    return S, dof.astype(float)


def tc(C: np.ndarray):
    """Classic TC on a 3x3 covariance (or a stack): error variances e (..., 3) and signal parts u^2 (..., 3).
    NaN where a cross-covariance is not positive."""
    c12, c13, c23 = C[..., 0, 1], C[..., 0, 2], C[..., 1, 2]
    ok = (c12 > 0) & (c13 > 0) & (c23 > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        u2 = np.stack([c12 * c13 / c23, c12 * c23 / c13, c13 * c23 / c12], -1)
    e = np.stack([C[..., 0, 0], C[..., 1, 1], C[..., 2, 2]], -1) - u2
    e = np.where(ok[..., None], e, np.nan)
    return e, np.where(ok[..., None], u2, np.nan)


def tc_symmetric(C: np.ndarray):
    """Alternative identification: e_T = e_A, Terra independent, Aqua-VIIRS error covariance g free.
    Returns (e_T(=e_A), e_V, g, kappa_AV)."""
    D = C[0, 0] - C[1, 1]
    X = (D + math.sqrt(D * D + 4 * C[0, 1] ** 2)) / 2
    uT = math.sqrt(X)
    uA, uV = C[0, 1] / uT, C[0, 2] / uT
    eT = C[0, 0] - X
    eV = C[2, 2] - uV * uV
    g = C[1, 2] - uA * uV
    kap = g / math.sqrt(eT * eV) if eT > 0 and eV > 0 else float("nan")
    return eT, eV, g, kap


def tc_hier(S: np.ndarray, dof: np.ndarray, ctx: Ctx, min_dof: float, floor: np.ndarray | None = None):
    """TC per stratum x dn with fallback biome x dn -> global x dn. S, dof indexed by s*2+dn.
    `floor` (nS, 2, 3): an error variance below it is implausible (a quarter of the Poisson expectation) and
    counts as a failed estimate at that level.
    Returns e (nS, 2, 3), u2 (nS, 2, 3), level (nS, 2) in 0..2 (3 = none)."""
    S = S.reshape(ctx.nS, 2, 3, 3)
    dof = dof.reshape(ctx.nS, 2)
    Sb = np.zeros((ctx.nB, 2, 3, 3))
    db = np.zeros((ctx.nB, 2))
    np.add.at(Sb, ctx.biome, S)
    np.add.at(db, ctx.biome, dof)
    Sg, dg = S.sum(0), dof.sum(0)

    def est(Sx, dx):
        with np.errstate(divide="ignore", invalid="ignore"):
            C = Sx / np.maximum(dx, 1)[..., None, None]
        e, u2 = tc(C)
        lo = 0.0 if floor is None else floor
        ok = (dx >= min_dof) & np.all(np.isfinite(e) & (e > lo), -1)
        return e, u2, ok

    e0, u0, ok0 = est(S, dof)
    e1, u1, ok1 = est(Sb[ctx.biome], db[ctx.biome])
    e2, u2_, ok2 = est(np.broadcast_to(Sg, S.shape), np.broadcast_to(dg, dof.shape))
    level = np.where(ok0, 0, np.where(ok1, 1, np.where(ok2, 2, 3)))
    e = np.where(ok0[..., None], e0, np.where(ok1[..., None], e1, e2))
    if floor is not None:      # no level passed: the global estimate, raised to the plausibility floor
        e = np.where((level == 3)[..., None], np.fmax(e, floor), e)
    u2 = np.where(ok0[..., None], u0, np.where(ok1[..., None], u1, u2_))
    return e, u2, level


def cell_tc(d: pd.DataFrame, cols: list[str], g: list, window, ctx: Ctx, extra_mask=None, center: str = CENTER,
            nsat=(1, 1, 1)):
    """1-degree TC on Anscombe sqrt anomalies. d: unit rows (c1, s, dn, m) with zero months filled.
    cols: three MODIS-equivalent streams; g: their rescale factors per row (arrays). Returns tc_hier output
    plus the number of rows used."""
    m0, m1 = (m_of(window[0]), m_of(window[1]))
    sel = (d.m.to_numpy() >= m0) & (d.m.to_numpy() <= m1)
    X = np.stack([d[c].to_numpy(float) for c in cols], 1)
    G = np.stack(g, 1)
    sel &= np.all(np.isfinite(X), 1)
    if extra_mask is not None:
        sel &= extra_mask
    unit = (d.c1.to_numpy() * 64 + d.s.to_numpy()) * 2 + d.dn.to_numpy()
    moy = d.m.to_numpy() % 12
    # climatological level of the unit x moy (mean of the three streams) >= 1 AFCD
    lvl = X.mean(1)
    um = unit * 12 + moy
    u, inv = np.unique(um[sel], return_inverse=True)
    clim = np.bincount(inv, lvl[sel]) / np.bincount(inv)
    keep = np.zeros(len(d), bool)
    keep[np.flatnonzero(sel)] = clim[inv] >= 1.0
    Y = np.sqrt(np.maximum(X[keep], 0) + 0.375 * G[keep])
    grp = (d.s.to_numpy()[keep] * 2 + d.dn.to_numpy()[keep])
    S, dof = anom_stats(Y, um[keep] if center == "unit_moy" else grp, grp, ctx.nS * 2)
    # plausibility floor: a quarter of the Poisson expectation g/4 on the sqrt scale (g/n for an n-satellite mean)
    cnt = np.maximum(np.bincount(grp, minlength=ctx.nS * 2), 1)
    gbar = np.stack([np.bincount(grp, G[keep][:, i], minlength=ctx.nS * 2) / cnt for i in range(3)], 1)
    gbar = np.where(gbar > 0, gbar, np.nanmax(gbar, 0, initial=1.0))
    floor = (gbar / 16 / np.asarray(nsat, float)[None, :]).reshape(ctx.nS, 2, 3)
    e, u2, level = tc_hier(S, dof, ctx, TC_MIN_DOF_CELL, floor)
    return e, u2, level, int(keep.sum()), (S, dof)


def fill_zeros(d: pd.DataFrame, window, active_min: float = 5.0) -> pd.DataFrame:
    """Unit rows (c1, s, dn) x every month of `window`, zero where the cube has no row. Streams that are
    missing for a month (satellite coverage < COV_MIN) stay NaN: the month-level mask is re-applied."""
    m0, m1 = m_of(window[0]), m_of(window[1])
    w = d[(d.m >= m0) & (d.m <= m1)]
    tot = w.groupby(["c1", "s", "dn"]).U.sum()
    act = tot[tot >= active_min].index.to_frame(index=False)
    months = pd.DataFrame({"m": np.arange(m0, m1 + 1)})
    grid = act.merge(months, how="cross")
    out = grid.merge(w, on=["c1", "s", "dn", "m"], how="left")
    # month-level availability: a stream is NaN for every unit when it is NaN for all rows of that month
    for c in STREAMS:
        if c not in out:
            continue
        avail = w.groupby("m")[c].apply(lambda x: x.notna().any())
        ok = out.m.map(avail).fillna(False).to_numpy(bool)
        out[c] = np.where(ok, out[c].fillna(0.0), np.nan)
    for c in ("KV2", "P", "P2", "O"):
        if c in out:
            out[c] = out[c].fillna(0.0)
    return out


# ------------------------------------------------------------------------------------------
# fusion (mirror of crates/harmony-core/src/series.rs; contract "Series formula")

def fuse(M, V, rM, pM, rV, pV, cM, hasM, hasV, rM0=None, rV0=None, kappa=0.0, iters=3):
    """Per-group fusion. Arrays broadcast. rM/rV include drift terms and relvar; rM0/rV0 exclude them;
    cM = extra common-mode coefficient (relvar in drift-corrected months). Returns (H, Var, w_modis)."""
    M = np.where(hasM, M, 0.0)
    V = np.where(hasV, V, 0.0)
    rM0 = rM if rM0 is None else rM0
    rV0 = rV if rV0 is None else rV0
    both = hasM & hasV
    mu = np.where(both, (M + V) / 2, np.where(hasM, M, V))
    w = np.where(hasM, 1.0, 0.0)
    for _ in range(iters):
        aM, aV = rM * mu + pM, rV * mu + pV
        c = np.minimum((kappa * np.sqrt(rM0 * rV0) + cM) * mu, 0.99 * np.sqrt(aM * aV))
        den = aM + aV - 2 * c
        wb = np.where(den > 1e-12, np.clip(sdiv(aV - c, den), 0, 1), 0.5)
        w = np.where(both, wb, np.where(hasM, 1.0, 0.0))
        mu = w * M + (1 - w) * V
    aM, aV = rM * mu + pM, rV * mu + pV
    c = np.minimum((kappa * np.sqrt(rM0 * rV0) + cM) * mu, 0.99 * np.sqrt(aM * aV))
    var = (w ** 2 * aM + (1 - w) ** 2 * aV + 2 * w * (1 - w) * c) * mu
    return mu, np.maximum(var, 0.0), w


# ------------------------------------------------------------------------------------------

def main(force: bool = False) -> None:
    deps = [CUBE, CALIB_JSON, COEF / "k.parquet", COEF / "r.parquet", LOYO_C1]
    if not force and fresh(HARM_JSON, deps):
        print("[harmonize] up to date")
        return
    cal = json.loads(CALIB_JSON.read_text())
    con = connect()
    build_inputs(con, cal, force)
    run(con, cal)


def run(con, cal: dict, units: pd.DataFrame | None = None, loyo: pd.DataFrame | None = None,
        strat_full: pd.DataFrame | None = None, overpass: pd.DataFrame | None = None) -> dict:
    ctx = Ctx(con, cal)
    d = load_units() if units is None else units
    if loyo is None:
        loyo = pd.read_parquet(LOYO_C1)
    for c in ("c1", "s", "dn", "m"):
        loyo[c] = loyo[c].astype(np.int64)
    d = d.merge(loyo[["c1", "s", "dn", "m", "P", "P2", "O"]], on=["c1", "s", "dn", "m"], how="left")
    sf = pd.read_parquet(STRAT_FULL) if strat_full is None else strat_full
    ov = pd.read_parquet(OVERPASS) if overpass is None and OVERPASS.exists() else overpass
    out: dict = {}
    val: dict = {}

    with timed("harmonize rescale"):
        sc = rescale(d, ctx)
    with timed("harmonize error model"):
        em, em_val = error_model(d, sc, ctx)
        val["error_model"] = em_val
    with timed("harmonize drift"):
        dr, dr_val = drift(d, ctx, ov)
        val["drift"] = dr_val
        out["drift"] = dr
    with timed("harmonize conformal"):
        cf_meta, cf_val = conformal(d, sc, em, dr, ctx)
        val["conformal"] = cf_val
        out["conformal"] = cf_meta
    with timed("harmonize fusion validation"):
        val["fusion"] = fusion_validation(d, sc, em, dr, ctx, sf)
    with timed("harmonize sensor tests"):
        val["noaa21_blind"] = noaa21_blind(d, sc, dr, ctx)
        val["closure"] = closure(d, sc, ctx)
        val["power_law"] = power_law(d, ctx)
        val["k_refit_2012_2019"] = k_refit(d, ctx)
    out["strata_err"] = [{
        "modis": {"rho": rr(em["rho_U"][s]), "phi": rr(em["phi_U"][s])},
        "bridge": {"rho": rr(em["rho_B"][s]), "phi": rr(em["phi_B"][s])},
        "viirs": {"rho": [rr(em["rho_V"][s])] * 3, "phi": [rr(em["phi_V"][n][s]) for n in (1, 2, 3)]},
    } for s in range(ctx.nS)]
    out["fusion"] = {"kappa": rr(em["kappa"])}
    out["strata_err_level"] = em["levels"]
    write_json(HARM_JSON, r3(out))
    # extend validation.json written by calibrate
    v = json.loads(VALIDATION.read_text()) if VALIDATION.exists() else {}
    v.update(r3(val))
    write_json(VALIDATION, v)
    print(f"[harmonize] kappa={em['kappa']}, conformal global q80={cf_meta['global']['q80']}")
    return {"out": out, "val": val}


def rr(x, nd: int = 6):
    return [round(float(v), nd) for v in np.ravel(x)]


# ------------------------------------------------------------------------------------------
# rescale factors (to the Terra∪Aqua scale) over the TC window

def rescale(d: pd.DataFrame, ctx: Ctx) -> dict:
    key = key_sdm(d)
    m = d.m.to_numpy()
    w = (m >= m_of(TC_WINDOW[0])) & (m <= m_of(TC_WINDOW[1]))
    U = d.U.to_numpy(float)
    sc = {"key": key}
    for c in ("T", "A", "SN", "V"):
        sc["g_" + c] = ratio_k(U, d[c].to_numpy(float), key, ctx, w & np.isfinite(U))
    w20 = (m >= month_index(2018, 1)) & (m <= month_index(2019, 12))
    sc["g_N20"] = ratio_k(U, d.N20.to_numpy(float), key, ctx, w20 & np.isfinite(U))
    # NOAA-21: production chain (c21 to S-NPP, then the VIIRS->MODIS k): it never enters a MODIS fit (blind)
    sc["g_N21"] = ctx.c21[:, :, None] * ctx.k
    # overall Terra->U, Aqua->U per s x dn (for the thinned-Poisson mapping)
    for c in ("T", "A"):
        ok = w & np.isfinite(U) & np.isfinite(d[c].to_numpy(float))
        nk = ctx.nS * 2
        sd = d.s.to_numpy() * 2 + d.dn.to_numpy()
        num = np.bincount(sd[ok], U[ok], minlength=nk)
        den = np.bincount(sd[ok], d[c].to_numpy(float)[ok], minlength=nk)
        sc["G_" + c] = np.where(den > 0, sdiv(num, den), 1.0).reshape(ctx.nS, 2)
    return sc


def scaled(d: pd.DataFrame, sc: dict, c: str, key=None) -> tuple[np.ndarray, np.ndarray]:
    key = key_sdm(d) if key is None else key
    g = sc["g_" + c].reshape(-1)[key]
    return d[c].to_numpy(float) * g, g


# ------------------------------------------------------------------------------------------
# 1. error model

def error_model(d: pd.DataFrame, sc: dict, ctx: Ctx):
    nS = ctx.nS
    res: dict = {}
    val: dict = {"assumptions": [
        "errors of the three streams in a triplet are independent of each other and of the signal",
        "Terra and Aqua share instrument design and algorithm (shared omission is absorbed as signal); Aqua and "
        "the VIIRS satellites share the early-afternoon overpass (shared diurnal and cloud state): classic TC "
        "then understates Aqua and VIIRS error and overstates Terra error",
        "Terra's differences include the real morning-afternoon difference in burning, counted as Terra error",
        "phi from the sqrt scale assumes Poisson-like variance (Var proportional to the mean) within a cell-month",
    ]}
    # --- (a) 1-degree TC ---------------------------------------------------------------------------------
    win = TC_WINDOW
    f = fill_zeros(d, (win[0], (2025, 12)))
    key = key_sdm(f)
    T_, gT = scaled(f, sc, "T", key)
    A_, gA = scaled(f, sc, "A", key)
    S_, gS = scaled(f, sc, "SN", key)
    N20_, g20 = scaled(f, sc, "N20", key)
    N21_, g21 = scaled(f, sc, "N21", key)
    kbar = ctx.k.reshape(-1)[key]
    f = f.assign(T_=T_, A_=A_, S_=S_, N20_=N20_, N21_=N21_)
    # VIIRS composite: LOYO prediction inside the fit window, production kv after it
    VL = np.where(np.isfinite(f.P.to_numpy(float)) & (f.m.to_numpy() <= ym_index(FIT_END)), f.P, f.KV)
    VL = np.where(np.isfinite(f.V.to_numpy(float)), VL, np.nan)
    f["VL"] = VL
    e_main, u_main, lv_main, n_main, st_main = cell_tc(f, ["T_", "A_", "S_"], [gT, gA, gS], win, ctx)
    phi_T, phi_A, phi_S = 4 * e_main[..., 0], 4 * e_main[..., 1], 4 * e_main[..., 2]
    phi_V, lv_V, n_V = {}, {}, {}
    for n, w in VIIRS_ERAS.items():
        e, _, lv, nn, _ = cell_tc(f, ["T_", "A_", "VL"], [gT, gA, kbar], w, ctx, nsat=(1, 1, n))
        phi_V[n], lv_V[n], n_V[n] = 4 * e[..., 2], lv, nn
    e20, _, lv20, n20, _ = cell_tc(f, ["T_", "A_", "N20_"], [gT, gA, g20], ((2018, 1), (2019, 12)), ctx)
    e21, _, lv21, n21, _ = cell_tc(f, ["T_", "A_", "N21_"], [gT, gA, g21], VIIRS_ERAS[3], ctx)
    phi_U = 0.5 * (phi_T / sc["G_T"] + phi_A / sc["G_A"])
    phi_B = phi_T
    # --- (d) Poisson-split cross-check, S-NPP-only years ---------------------------------------------------
    w1 = VIIRS_ERAS[1]
    m = f.m.to_numpy()
    sel = (m >= m_of(w1[0])) & (m <= m_of(w1[1])) & np.isfinite(f.U.to_numpy(float)) & np.isfinite(VL)
    unit = ((f.c1.to_numpy() * 64 + f.s.to_numpy()) * 2 + f.dn.to_numpy()) * 12 + m % 12
    Uv = f.U.to_numpy(float)
    lvl = 0.5 * (Uv + VL)
    u, inv = np.unique(unit[sel], return_inverse=True)
    clim = np.bincount(inv, lvl[sel]) / np.bincount(inv)
    keep = np.zeros(len(f), bool)
    keep[np.flatnonzero(sel)] = clim[inv] >= 1.0
    yU = np.sqrt(Uv[keep] + 0.375)
    yV = np.sqrt(np.maximum(VL[keep], 0) + 0.375 * kbar[keep])
    grp = f.s.to_numpy()[keep] * 2 + f.dn.to_numpy()[keep]
    Sd, dofd = anom_stats(np.stack([yV - yU, yV, yU], 1), unit[keep], grp, nS * 2)
    Dvar = Sd[:, 0, 0] / np.maximum(dofd, 1)
    kgrp = np.bincount(grp, kbar[keep], minlength=nS * 2) / np.maximum(np.bincount(grp, minlength=nS * 2), 1)
    pU, pV = 0.25, kgrp / 4
    phi_U_pois = (4 * Dvar * pU / (pU + pV)).reshape(nS, 2)
    phi_V_pois = (4 * Dvar * pV / (pU + pV)).reshape(nS, 2)
    D_excess = (Dvar / (pU + pV)).reshape(nS, 2)       # common dispersion factor implied by the split
    # --- (b) stratum-month log anomaly TC ------------------------------------------------------------------
    m0, m1 = m_of(win[0]), m_of(win[1])
    g = f[(f.m >= m0) & (f.m <= m1)].groupby(["s", "dn", "m"], as_index=False)[["T_", "A_", "VL", "U"]].sum(min_count=1)
    g = g.dropna()
    g = g[(g[["T_", "A_", "VL", "U"]] > 0).all(1)]
    X = np.log(g[["T_", "A_", "VL"]].to_numpy(float))
    sdg = g.s.to_numpy() * 2 + g.dn.to_numpy()
    um = sdg * 12 + g.m.to_numpy() % 12
    S2, dof2 = anom_stats(X, um, sdg, nS * 2)
    # mean level per s x dn (for the Poisson part and the eligibility of strata for the pooled kappa)
    inv_mean = {c: np.bincount(sdg, 1.0 / g[c].to_numpy(float), minlength=nS * 2)
                / np.maximum(np.bincount(sdg, minlength=nS * 2), 1) for c in ("T_", "A_", "VL")}
    meanU = np.bincount(sdg, g.U.to_numpy(float), minlength=nS * 2) / np.maximum(np.bincount(sdg, minlength=nS * 2), 1)
    e2, u2_2, lv2 = tc_hier(S2, dof2, ctx, TC_MIN_DOF_STRATUM)
    pois = np.stack([phi_T * inv_mean["T_"].reshape(nS, 2), phi_A * inv_mean["A_"].reshape(nS, 2),
                     phi_V[1] * inv_mean["VL"].reshape(nS, 2)], -1)
    rho = np.maximum(e2 - pois, 1e-5)
    rho_T, rho_A, rho_V = rho[..., 0], rho[..., 1], rho[..., 2]
    rho_U = (rho_T + rho_A) / 4
    rho_B = rho_T + ctx.relvar_b
    # union vs mean-of-two diagnostic (stratum-month log anomalies)
    xU = np.log(g.U.to_numpy(float))
    xM = np.log(0.5 * (g.T_.to_numpy(float) + g.A_.to_numpy(float)))
    Sx, dx = anom_stats(np.stack([xU - xM, xU, xM], 1), um, sdg, nS * 2)
    diag_union = float(Sx[:, 0, 0].sum() / max(dx.sum(), 1))
    # --- (c) common mode: pooled per dn over strata with mean U >= 500 ---------------------------------------
    big = (meanU >= 500).reshape(nS, 2)
    kappa = np.zeros(2)
    sym = {}
    S2r, dof2r = S2.reshape(nS, 2, 3, 3), dof2.reshape(nS, 2)
    for dn in (0, 1):
        sel_s = big[:, dn]
        C = S2r[sel_s, dn].sum(0) / max(dof2r[sel_s, dn].sum(), 1)
        eT, eV, gcov, kap = tc_symmetric(C)
        e_cl, _ = tc(C)
        kappa[dn] = float(np.clip(kap / math.sqrt(2), 0.0, 0.9)) if np.isfinite(kap) else 0.0
        sym["day" if dn == 0 else "night"] = {"strata": int(sel_s.sum()), "classic_e": [float(x) for x in e_cl],
                                              "sym_eT_eA": eT, "sym_eV": eV, "g_aqua_viirs": gcov,
                                              "kappa_aqua_viirs": kap, "kappa_modis_viirs": float(kappa[dn])}
    em = {"phi_U": np.maximum(phi_U, 1e-3), "phi_B": np.maximum(phi_B, 1e-3),
          "phi_V": {n: np.maximum(phi_V[n], 1e-3) for n in phi_V},
          "phi_A": np.maximum(phi_A, 1e-3), "phi_T": np.maximum(phi_T, 1e-3),
          "rho_U": rho_U, "rho_B": rho_B, "rho_V": rho_V, "rho_A": rho_A, "rho_T": rho_T, "kappa": kappa,
          "kappa_av": np.array([sym[k]["kappa_aqua_viirs"] for k in ("day", "night")]),
          "levels": {"cell_main": lv_main.tolist(), "stratum": lv2.tolist()}}
    # --- summaries by biome group (U-weighted over strata) -------------------------------------------------
    wU = np.bincount(sdg, g.U.to_numpy(float), minlength=nS * 2).reshape(nS, 2)

    def bygroup(a):
        o = {}
        for gi, name in enumerate(ctx.group_names):
            sel_s = ctx.group == gi
            ww = wU[sel_s]
            if ww.sum() <= 0:
                continue
            o[name] = [float((a[sel_s][:, dn] * ww[:, dn]).sum() / max(ww[:, dn].sum(), 1e-9)) for dn in (0, 1)]
        o["all"] = [float((a[:, dn] * wU[:, dn]).sum() / max(wU[:, dn].sum(), 1e-9)) for dn in (0, 1)]
        return o

    def share(lv):
        return {LEVEL_NAMES[i] if i < 3 else "none": float((np.asarray(lv) == i).mean()) for i in range(4)}

    val.update({
        "unit": "MODIS-equivalent AFCD; phi = Var/mean at cell scale (1 = Poisson); rho = relative variance of "
                "the stratum-coherent error; pairs are [day, night]; group values are weighted by Terra∪Aqua AFCD",
        "window": [f"{TC_WINDOW[0][0]}-{TC_WINDOW[0][1]:02d}", f"{TC_WINDOW[1][0]}-{TC_WINDOW[1][1]:02d}"],
        "n_cell_months": {"terra_aqua_snpp": n_main, "viirs_by_sats": n_V, "noaa20": n20, "noaa21": n21},
        "phi": {"terra_aqua": bygroup(em["phi_U"]), "terra_bridged": bygroup(em["phi_B"]),
                "terra_rescaled": bygroup(phi_T), "aqua_rescaled": bygroup(phi_A),
                "snpp": bygroup(phi_S), "noaa20": bygroup(4 * e20[..., 2]), "noaa21": bygroup(4 * e21[..., 2]),
                "viirs_1sat": bygroup(phi_V[1]), "viirs_2sat": bygroup(phi_V[2]), "viirs_3sat": bygroup(phi_V[3])},
        "phi_terra_aqua_from": {"terra": bygroup(phi_T / sc["G_T"]), "aqua": bygroup(phi_A / sc["G_A"])},
        "poisson_split": {"phi_terra_aqua": bygroup(phi_U_pois), "phi_viirs_1sat": bygroup(phi_V_pois),
                          "common_dispersion_factor": bygroup(D_excess),
                          "note": "Var(sqrt VIIRS - sqrt Terra∪Aqua) split in proportion to the Poisson expectations "
                                  "1/4 and k/4 (S-NPP-only years)"},
        "rho": {"terra_aqua": bygroup(rho_U), "terra_bridged": bygroup(rho_B), "viirs": bygroup(rho_V),
                "terra_rescaled": bygroup(rho_T), "aqua_rescaled": bygroup(rho_A),
                "viirs_relvar_floor": bygroup(ctx.relvar)},
        "common_mode": sym,
        "kappa": [float(x) for x in kappa],
        "union_vs_mean_of_two_var": diag_union,
        "level_share": {"cell_terra_aqua_snpp": share(lv_main), "cell_noaa20": share(lv20),
                        "cell_noaa21": share(lv21), "stratum_month": share(lv2),
                        **{f"cell_viirs_{n}sat": share(lv_V[n]) for n in lv_V}},
        "signal_fraction_cell": bygroup(np.nanmean(u_main / np.maximum(u_main + e_main, 1e-12), -1)),
    })
    return em, val


def model_var(mu, s, dn, em: dict, nsat, stream: str, ctx: Ctx):
    """Variance of one stream at level mu for rows (s, dn); nsat per row (VIIRS)."""
    if stream == "V":
        n = np.clip(nsat, 1, 3)
        phi = np.select([n == 1, n == 2, n == 3], [em["phi_V"][1][s, dn], em["phi_V"][2][s, dn], em["phi_V"][3][s, dn]])
        return (em["rho_V"][s, dn] + ctx.relvar[s, dn]) * mu ** 2 + phi * mu
    return em["rho_" + stream][s, dn] * mu ** 2 + em["phi_" + stream][s, dn] * mu


# ------------------------------------------------------------------------------------------
# 2. drift fingerprint

def drift(d: pd.DataFrame, ctx: Ctx, ov: pd.DataFrame | None):
    rng = np.random.default_rng(20261115)
    c1 = d.c1.to_numpy()
    iy, ix = c1 // 360, c1 % 360
    blk = (iy // 5) * 72 + ix // 5
    ublk = np.unique(blk)
    grp_of_blk = dict(zip(ublk, rng.integers(0, JACK_GROUPS, len(ublk))))
    jg = np.vectorize(grp_of_blk.get)(blk)
    hemi = (iy >= 90).astype(int)                 # 1 = northern
    year = 2000 + d.m.to_numpy() // 12
    y0, y1 = int(year.min()), int(year.max())
    Y = y1 - y0 + 1
    nS = ctx.nS
    moy = d.m.to_numpy() % 12
    V = d.V.to_numpy(float)
    sums = {}
    for c in ("T", "A", "U"):
        x = d[c].to_numpy(float)
        ok = np.isfinite(x) & np.isfinite(V)
        idx = ((((jg * 2 + hemi) * Y + (year - y0)) * nS + d.s.to_numpy()) * 2 + d.dn.to_numpy()) * 12 + moy
        shape = (JACK_GROUPS, 2, Y, nS, 2, 12)
        n = int(np.prod(shape))
        sums[c] = (np.bincount(idx[ok], x[ok], minlength=n).reshape(shape),
                   np.bincount(idx[ok], V[ok], minlength=n).reshape(shape))
    ref = [y - y0 for y in range(DRIFT_REF_YEARS[0], DRIFT_REF_YEARS[1] + 1) if y0 <= y <= y1]
    years = list(range(y0, y1 + 1))

    def ratios(c, drop: int | None):
        O, E = sums[c]
        if drop is not None:
            O = O.sum(0) - O[drop]
            E = E.sum(0) - E[drop]
        else:
            O, E = O.sum(0), E.sum(0)
        # O, E: (2 hemi, Y, nS, 2, 12)
        Oy, Ey = O.sum(0), E.sum(0)                   # (Y, nS, 2, 12)
        k_all = fit_k(Oy[ref].sum(0), Ey[ref].sum(0), ctx.biome, ctx.nB)[0]
        kk = np.broadcast_to(k_all, Oy.shape).copy()
        for r in ref:                                  # placebo: leave the reference year out
            kk[r] = fit_k(Oy[ref].sum(0) - Oy[r], Ey[ref].sum(0) - Ey[r], ctx.biome, ctx.nB)[0]
        exp = kk[None] * E                             # (2, Y, nS, 2, 12)
        ob = O.sum(-1)                                 # (2, Y, nS, 2)
        ex = exp.sum(-1)
        Ob = np.zeros((2, Y, ctx.nB, 2))
        Eb = np.zeros((2, Y, ctx.nB, 2))
        for s in range(nS):
            Ob[:, :, ctx.biome[s]] += ob[:, :, s]
            Eb[:, :, ctx.biome[s]] += ex[:, :, s]
        return Ob, Eb

    out = {}
    for c in ("T", "A", "U"):
        full = ratios(c, None)
        reps = [ratios(c, g) for g in range(JACK_GROUPS)]
        out[c] = (full, reps)

    def summarize(c, agg):
        """agg(Ob, Eb) -> (O, E) arrays (Y, dn); returns log ratio, jackknife se, expected sums."""
        (Ob, Eb), reps = out[c]
        O, E = agg(Ob, Eb)
        lr = np.log(sdiv(O, E) + 1e-300)
        lr = np.where((O > 0) & (E > 0), lr, np.nan)
        rl = []
        for Ob_r, Eb_r in reps:
            o, e = agg(Ob_r, Eb_r)
            rl.append(np.where((o > 0) & (e > 0), np.log(sdiv(o, e) + 1e-300), np.nan))
        rl = np.stack(rl)
        G = JACK_GROUPS
        se = np.sqrt((G - 1) / G * np.nansum((rl - np.nanmean(rl, 0)) ** 2, 0))
        return lr, se, E

    tq = 2.023  # t(0.975, 39)
    okm = d.U.notna() & d.V.notna()
    months_by_year = (d.loc[okm, "m"].drop_duplicates() // 12 + 2000).value_counts().to_dict()
    sat_name = {"T": "terra", "A": "aqua", "U": "terra_aqua"}
    table = []
    biome_lr = {}
    for c in ("T", "A", "U"):
        scopes = {"global": lambda O, E: (O.sum((0, 2)), E.sum((0, 2))),
                  "north": lambda O, E: (O[1].sum(1), E[1].sum(1)),
                  "south": lambda O, E: (O[0].sum(1), E[0].sum(1))}
        for bi, b in enumerate(ctx.biome_codes):
            scopes[f"biome_{int(b)}"] = (lambda bi: lambda O, E: (O[:, :, bi].sum(0), E[:, :, bi].sum(0)))(bi)
        for gi, gname in enumerate(ctx.group_names):
            bis = [bi for bi, b in enumerate(ctx.biome_codes) if ctx.group[np.argmax(ctx.biome_code == b)] == gi]
            if bis:
                scopes[f"group_{gi}"] = (lambda bis: lambda O, E: (O[:, :, bis].sum((0, 2)), E[:, :, bis].sum((0, 2))))(bis)
        for scope, agg in scopes.items():
            lr, se, E = summarize(c, agg)
            if scope.startswith("biome_"):
                biome_lr[(c, int(scope[6:]))] = (lr, se, E)
            ri = [yi for yi, y in enumerate(years) if DRIFT_REF_YEARS[0] <= y <= DRIFT_REF_YEARS[1]]
            pv = np.nanmean(lr[ri] ** 2, 0)            # placebo (year-to-year) variance per dn
            for yi, y in enumerate(years):
                for dn in (0, 1):
                    if not np.isfinite(lr[yi, dn]):
                        continue
                    st = math.sqrt(se[yi, dn] ** 2 + pv[dn])
                    table.append({"sat": sat_name[c], "scope": scope, "dn": dn, "year": y,
                                  "months": int(months_by_year.get(y, 0)),
                                  "ratio": math.exp(lr[yi, dn]),
                                  "lo95": math.exp(lr[yi, dn] - tq * se[yi, dn]),
                                  "hi95": math.exp(lr[yi, dn] + tq * se[yi, dn]),
                                  "lo95_total": math.exp(lr[yi, dn] - 1.96 * st),
                                  "hi95_total": math.exp(lr[yi, dn] + 1.96 * st),
                                  "log_se": float(se[yi, dn]), "expected": float(E[yi, dn]),
                                  "placebo": bool(DRIFT_REF_YEARS[0] <= y <= DRIFT_REF_YEARS[1])})
    tb = pd.DataFrame(table)
    # placebo summary: reference years should sit at 1
    pl = tb[tb.placebo]
    placebo = {}
    for (sat, scope, dn), g in pl.groupby(["sat", "scope", "dn"]):
        lr = np.log(g.ratio.to_numpy())
        inside = ((g.lo95 <= 1) & (g.hi95 >= 1)).mean()
        placebo.setdefault(sat, {}).setdefault(scope, {})["day" if dn == 0 else "night"] = {
            "rms_log": float(np.sqrt(np.mean(lr ** 2))), "max_abs_pct": float(100 * np.max(np.abs(np.expm1(lr)))),
            "share_ci_covers_1": float(inside)}
    # kernel factors: Terra∪Aqua per biome x dn x year from DRIFT_START_YEAR
    kyears = [y for y in years if y >= DRIFT_START_YEAR]
    yidx = [years.index(y) for y in kyears]
    ref_idx = [years.index(y) for y in range(DRIFT_REF_YEARS[0], DRIFT_REF_YEARS[1] + 1) if y in years]
    biome_f = {}

    def entry(lr, se, E):
        pv = np.nanmean(lr[ref_idx] ** 2, 0)          # placebo variance per dn
        lf, sd = [], []
        for dn in (0, 1):
            lf.append([float(lr[i, dn]) if np.isfinite(lr[i, dn]) and E[i, dn] >= DRIFT_MIN_EXP else None
                       for i in yidx])
            sd.append([float(math.sqrt(se[i, dn] ** 2 + pv[dn])) if np.isfinite(se[i, dn]) else None for i in yidx])
        return lf, sd

    lrg, seg, Eg = summarize("U", lambda O, E: (O.sum((0, 2)), E.sum((0, 2))))
    lf_all, sd_all = entry(lrg, seg, Eg)
    lf_all = [[0.0 if v is None else v for v in row] for row in lf_all]
    sd_all = [[0.0 if v is None else v for v in row] for row in sd_all]
    biome_f["all"] = {"log_f": lf_all, "log_sd": sd_all}
    for (c, b), (lr, se, E) in biome_lr.items():
        if c != "U":
            continue
        lf, sd = entry(lr, se, E)
        # a biome-year without enough data takes the global value
        lf = [[lf[dn][i] if lf[dn][i] is not None else lf_all[dn][i] for i in range(len(yidx))] for dn in (0, 1)]
        sd = [[sd[dn][i] if lf[dn][i] is not None and sd[dn][i] is not None else sd_all[dn][i]
               for i in range(len(yidx))] for dn in (0, 1)]
        biome_f[str(b)] = {"log_f": lf, "log_sd": sd}
    meta = {"ref_years": list(DRIFT_REF_YEARS), "start_year": DRIFT_START_YEAR, "years": kyears,
            "attr_frac": DRIFT_ATTR_FRAC, "stream": "terra_aqua", "biome": biome_f}
    # overpass-time natural experiment
    otab, oreg = overpass_analysis(ov, tb, ctx, years) if ov is not None and len(ov) else ([], {})
    val = {
        "note": "observed / expected cell-days per satellite; expected = satellite-specific ratio (stratum x dn x "
                "month-of-year, fitted on the reference years) x the production VIIRS stream. Reference years use "
                "leave-one-year-out ratios (placebo). Intervals: delete-a-group jackknife over 5-degree blocks "
                f"({JACK_GROUPS} groups, t with {JACK_GROUPS - 1} df).",
        "ref_years": list(DRIFT_REF_YEARS), "biome_names": {str(int(b)): ctx.bname.get(b, "Unclassified")
                                                              for b in ctx.biome_codes},
        "group_names": ctx.group_names,
        "table": [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()} for r in table
                  if not r["scope"].startswith("biome_")],
        "biome_table": [{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()
                         if k in ("scope", "dn", "year", "ratio", "lo95_total", "hi95_total")} for r in table
                        if r["scope"].startswith("biome_") and r["sat"] == "terra_aqua"],
        "placebo": placebo,
        "overpass": otab, "diurnal_sensitivity": oreg,
    }
    return meta, val


def overpass_analysis(ov: pd.DataFrame, tb: pd.DataFrame, ctx: Ctx, years):
    """Mean local-solar time of detections per satellite x year x dn (shift from the 2012-2019 mean of the same
    stratum x dn x moy), and log ratio ~ beta * shift per biome group x dn x satellite."""
    ov = ov.copy()
    ov["year"] = 2000 + ov.m // 12
    ov["moy"] = ov.m % 12
    ref = ov[(ov.year >= DRIFT_REF_YEARS[0]) & (ov.year <= DRIFT_REF_YEARS[1])]
    base = ref.assign(hn=ref.h * ref.n).groupby(["satellite", "s", "dn", "moy"]).agg(hn=("hn", "sum"), n=("n", "sum"))
    base = (base.hn / base.n).rename("h0").reset_index()
    x = ov.merge(base, on=["satellite", "s", "dn", "moy"], how="inner")
    x["dh"] = (x.h - x.h0) * x.n
    x["g"] = ctx.group[x.s.to_numpy()]
    rows = []
    for (sat, y, dn), g in x.groupby(["satellite", "year", "dn"]):
        rows.append({"sat": sat, "year": int(y), "dn": int(dn), "shift_h": float(g.dh.sum() / g.n.sum()),
                     "n": int(g.n.sum())})
    sh_g = x.groupby(["satellite", "g", "year", "dn"]).apply(lambda g: g.dh.sum() / g.n.sum(), include_groups=False)
    reg = {}
    sat_map = {"Terra": "terra", "Aqua": "aqua"}
    for sat, sname in sat_map.items():
        for gi, gname in enumerate(ctx.group_names):
            for dn in (0, 1):
                t = tb[(tb.sat == sname) & (tb.scope == f"group_{gi}") & (tb.dn == dn)]
                pts = []
                for r in t.itertuples():
                    try:
                        dh = float(sh_g.loc[(sat, gi, r.year, dn)])
                    except KeyError:
                        continue
                    pts.append((dh, math.log(r.ratio), r.log_se, r.year))
                if len(pts) < 6:
                    continue
                dh = np.array([p[0] for p in pts])
                lr = np.array([p[1] for p in pts])
                beta = float((dh * lr).sum() / max((dh * dh).sum(), 1e-12))
                resid = lr - beta * dh
                se = float(math.sqrt((resid ** 2).sum() / max(len(pts) - 1, 1) / max((dh * dh).sum(), 1e-12)))
                post = np.array([p[3] for p in pts]) >= DRIFT_START_YEAR
                ss_post = float((lr[post] ** 2).sum())
                r2 = float(1 - (resid[post] ** 2).sum() / ss_post) if ss_post > 0 else None
                reg.setdefault(sname, {}).setdefault(gname, {})["day" if dn == 0 else "night"] = {
                    "beta_per_hour": beta, "se": se, "n_years": len(pts),
                    "shift_h_latest": float(dh[-1]), "share_post_explained": r2}
    return rows, reg


# ------------------------------------------------------------------------------------------
# 3. conformal multipliers

def size_class(H):
    return np.searchsorted(np.asarray(CONF_SIZE_EDGES), H, side="right")


def unit_level(rows: pd.DataFrame, unit_col: np.ndarray, em: dict, ctx: Ctx, pred: str, obs: str, var_fn):
    """Aggregate rows to (unit, s, dn, m), evaluate the variance per group, then sum to (unit, m).
    Returns DataFrame unit, m, H, O, Var, Q (sum of KV2), legacy variance terms."""
    r = pd.DataFrame({"u": unit_col, "s": rows.s.to_numpy(), "dn": rows.dn.to_numpy(), "m": rows.m.to_numpy(),
                      "P": rows[pred].to_numpy(float), "O": rows[obs].to_numpy(float),
                      "Q": rows["Q"].to_numpy(float) if "Q" in rows else 0.0})
    g = r.groupby(["u", "s", "dn", "m"], as_index=False)[["P", "O", "Q"]].sum()
    s, dn, m = g.s.to_numpy(), g.dn.to_numpy(), g.m.to_numpy()
    nsat = ctx.nsat[np.minimum(m, len(ctx.nsat) - 1)]
    g["Var"] = var_fn(g.P.to_numpy(float), s, dn, nsat)
    P = g.P.to_numpy(float)
    g["Vold"] = ctx.relvar[s, dn] * P ** 2 + P + ctx.alpha[s, dn] * g.Q.to_numpy(float)
    return g.groupby(["u", "m"], as_index=False)[["P", "O", "Var", "Vold"]].sum()


def conformal(d: pd.DataFrame, sc: dict, em: dict, dr: dict, ctx: Ctx):
    fit0, fit1 = ym_index(FIT_START), ym_index(FIT_END)
    grp_row = ctx.group[d.s.to_numpy()]
    c1 = d.c1.to_numpy()
    blk = (c1 // 360 // 5) * 72 + (c1 % 360) // 5
    units = {"cell1deg": c1 * 16 + grp_row, "block5deg": blk * 16 + grp_row, "stratum": d.s.to_numpy() * 16 + grp_row}

    def var_diff(mu, s, dn, nsat):
        vV = model_var(mu, s, dn, em, nsat, "V", ctx)
        vM = model_var(mu, s, dn, em, nsat, "U", ctx)
        c = em["kappa"][dn] * np.sqrt(em["rho_U"][s, dn] * em["rho_V"][s, dn]) * mu ** 2
        return np.maximum(vV + vM - 2 * c, 0)

    def scores(rows, pred, obs):
        allu = []
        for name, u in units.items():
            g = unit_level(rows, u[rows.index.to_numpy()], em, ctx, pred, obs, var_diff)
            g["grp"] = (g.u % 16).astype(int)
            g["support"] = name
            allu.append(g)
        g = pd.concat(allu, ignore_index=True)
        H, O = g.P.to_numpy(float), g.O.to_numpy(float)
        sig = np.sqrt(g.Var.to_numpy(float)) / (H + C_SHIFT)
        sig_old = ctx.ci_scale * np.sqrt(g.Vold.to_numpy(float)) / np.maximum(H, 0.5)
        lr = np.abs(np.log((O + C_SHIFT) / (H + C_SHIFT)))
        with np.errstate(divide="ignore", invalid="ignore"):
            lr_old = np.where((O > 0) & (H > 0), np.abs(np.log(O / H)), np.inf)
        g["score"] = np.where(sig > 0, lr / sig, np.where(lr > 0, np.inf, 0.0))
        g["lr"] = lr_old
        g["sig_old"] = sig_old
        g["cls"] = size_class(H)
        return g[(H > 0) | (O > 0)]

    # calibration set: LOYO predictions in the fit window
    cal_rows = d[(d.m >= fit0) & (d.m <= fit1) & d.P.notna() & d.U.notna() & d.V.notna()]
    cal_rows = cal_rows.assign(Q=cal_rows.P2.fillna(0.0))
    S = scores(cal_rows, "P", "U")
    ncls = len(CONF_SIZE_EDGES) + 1

    def cq(x, p):
        x = np.sort(x)
        n = len(x)
        if n == 0:
            return CONF_Q_MAX
        k = math.ceil((n + 1) * p)
        return float(min(x[k - 1], CONF_Q_MAX)) if k <= n else CONF_Q_MAX

    def bins_for(sel):
        """Merge size classes with < CONF_MIN_N scores into a neighbour. Returns list of class-lists."""
        n = [int(((S.cls == c) & sel).sum()) for c in range(ncls)]
        bins = [[c] for c in range(ncls)]
        cnt = n[:]
        while len(bins) > 1:
            small = [i for i, b in enumerate(bins) if cnt[i] < CONF_MIN_N]
            if not small:
                break
            i = small[-1]
            j = i - 1 if i > 0 else i + 1
            a, b_ = min(i, j), max(i, j)
            bins[a] = bins[a] + bins[b_]
            cnt[a] = cnt[a] + cnt[b_]
            del bins[b_], cnt[b_]
        return bins

    def table(sel):
        q80, q95, nn = [0.0] * ncls, [0.0] * ncls, [0] * ncls
        for b in bins_for(sel):
            x = S.score.to_numpy()[sel.to_numpy() & S.cls.isin(b).to_numpy()]
            for c in b:
                q80[c], q95[c], nn[c] = cq(x, 0.8), cq(x, 0.95), int(len(x))
        return q80, q95, nn

    glob = table(pd.Series(True, index=S.index))
    groups, Q80, Q95, NN = [], [], [], []
    for gi, (name, biomes) in enumerate(BIOME_GROUPS):
        sel = S.grp == gi
        if sel.sum() < CONF_MIN_N:
            q80, q95, nn = glob
        else:
            q80, q95, nn = table(sel)
        groups.append({"name": name, "biomes": list(biomes)})
        Q80.append(q80)
        Q95.append(q95)
        NN.append(nn)
    meta = {"size_edges": list(CONF_SIZE_EDGES), "groups": groups, "q80": Q80, "q95": Q95, "n": NN,
            "global": {"q80": glob[0], "q95": glob[1], "n": glob[2]},
            "score": "|log(obs / pred)| / sigma_log(pred - obs), LOYO calibrated VIIRS vs Terra∪Aqua, 2012-2021"}
    Q80a, Q95a = np.array(Q80), np.array(Q95)

    def coverage(T: pd.DataFrame):
        q80 = Q80a[T.grp.to_numpy(), T.cls.to_numpy()]
        q95 = Q95a[T.grp.to_numpy(), T.cls.to_numpy()]
        c80 = (T.score <= q80)
        c95 = (T.score <= q95)
        o80 = T.lr <= Z80 * T.sig_old
        o95 = T.lr <= Z95 * T.sig_old
        return c80, c95, o80, o95

    def cov_tables(T: pd.DataFrame):
        c80, c95, o80, o95 = coverage(T)
        out = {}
        for sup in ("cell1deg", "block5deg", "stratum", "all"):
            sel = (T.support == sup) if sup != "all" else pd.Series(True, index=T.index)
            rows = {}
            for c in range(ncls):
                b = sel & (T.cls == c)
                if b.sum() == 0:
                    continue
                lab = f"H<{CONF_SIZE_EDGES[0]:g}" if c == 0 else (f"H>={CONF_SIZE_EDGES[-1]:g}" if c == ncls - 1
                                                                     else f"{CONF_SIZE_EDGES[c - 1]:g}-{CONF_SIZE_EDGES[c]:g}")
                rows[lab] = {"n": int(b.sum()), "cov80": float(c80[b].mean()), "cov95": float(c95[b].mean()),
                             "legacy_cov80": float(o80[b].mean()), "legacy_cov95": float(o95[b].mean())}
            out[sup] = rows
        byg = {}
        for gi, name in enumerate(ctx.group_names):
            b = T.grp == gi
            if b.sum():
                byg[name] = {"n": int(b.sum()), "cov80": float(c80[b].mean()), "cov95": float(c95[b].mean()),
                             "legacy_cov80": float(o80[b].mean()), "legacy_cov95": float(o95[b].mean())}
        out["by_group"] = byg
        return out

    in_sample = cov_tables(S)
    # out of time: frozen production kv vs observed (raw and drift-corrected) Terra∪Aqua
    o0, o1 = month_index(OOT_TEST_YEARS[0], 1), month_index(OOT_TEST_YEARS[1], 12)
    oot = d[(d.m >= o0) & (d.m <= o1) & d.KV.notna() & d.U.notna()]
    oot = oot.assign(Q=oot.KV2.fillna(0.0))
    T_raw = scores(oot, "KV", "U")
    f = drift_factor_rows(oot, dr, ctx)
    oot_c = oot.assign(Uc=oot.U.to_numpy(float) / f)
    T_cor = scores(oot_c, "KV", "Uc")
    val = {"meta": meta, "in_sample_loyo_2012_2021": in_sample,
           "out_of_time": {"years": list(OOT_TEST_YEARS), "vs_modis_raw": cov_tables(T_raw),
                           "vs_modis_drift_corrected": cov_tables(T_cor)},
           "note": "coverage = share of unit-months whose observed Terra∪Aqua lies in the interval; units are "
                   "1-degree and 5-degree cells within one biome group, and whole strata; legacy = the "
                   "ci_scale interval. Coverage is empirical, held-out where stated, not guaranteed: months "
                   "are autocorrelated and the out-of-time years contain MODIS drift."}
    return meta, val


def drift_factor_rows(rows: pd.DataFrame, dr: dict, ctx: Ctx) -> np.ndarray:
    """Multiplicative drift factor (Terra∪Aqua) for each row (s, dn, m); 1 before the start year."""
    year = 2000 + rows.m.to_numpy() // 12
    yrs = dr["years"]
    yi = np.clip(np.searchsorted(yrs, year), 0, len(yrs) - 1)
    b = ctx.biome_code[rows.s.to_numpy()]
    dn = rows.dn.to_numpy()
    tab = dr["biome"]
    lf = np.zeros(len(rows))
    for key, ent in tab.items():
        sel = (b == int(key)) if key != "all" else ~np.isin(b, [int(k) for k in tab if k != "all"])
        if not sel.any():
            continue
        arr = np.array(ent["log_f"], float)       # (2, years)
        lf[sel] = arr[dn[sel], yi[sel]]
    out = np.where(year >= dr["start_year"], np.exp(lf), 1.0)
    return out


# ------------------------------------------------------------------------------------------
# 4. validation of the fused record

def fusion_validation(d: pd.DataFrame, sc: dict, em: dict, dr: dict, ctx: Ctx, sf: pd.DataFrame) -> dict:
    out = {}
    # (a) non-circular test: fuse Aqua with LOYO VIIRS, score against Terra (2012-02 .. 2019-12)
    m0, m1 = m_of(TC_WINDOW[0]), m_of(TC_WINDOW[1])
    x = d[(d.m >= m0) & (d.m <= m1) & d.P.notna() & d["T"].notna() & d.A.notna() & d.V.notna()].copy()
    key = key_sdm(x)
    yr = 2000 + x.m.to_numpy() // 12
    # leave-one-year-out rescale factors for Terra and Aqua
    full = d[(d.m >= m0) & (d.m <= m1)]
    fk, fyr = key_sdm(full), 2000 + full.m.to_numpy() // 12
    Tr, Ar = np.zeros(len(x)), np.zeros(len(x))
    for y in np.unique(yr):
        tr = (fyr != y) & full.U.notna().to_numpy()
        gT = ratio_k(full.U.to_numpy(float), full["T"].to_numpy(float), fk, ctx, tr)
        gA = ratio_k(full.U.to_numpy(float), full["A"].to_numpy(float), fk, ctx, tr)
        te = yr == y
        Tr[te] = x["T"].to_numpy(float)[te] * gT.reshape(-1)[key[te]]
        Ar[te] = x["A"].to_numpy(float)[te] * gA.reshape(-1)[key[te]]
    x["Tr"], x["Ar"] = Tr, Ar
    s, dn, m = x.s.to_numpy(), x.dn.to_numpy(), x.m.to_numpy()
    res = {}
    for scale, ucol in (("cell1deg_month", x.c1.to_numpy()), ("stratum_month", x.s.to_numpy())):
        g = pd.DataFrame({"u": ucol, "s": s, "dn": dn, "m": m, "T": Tr, "A": Ar, "V": x.P.to_numpy(float)}) \
            .groupby(["u", "s", "dn", "m"], as_index=False)[["T", "A", "V"]].sum()
        gs, gd, gm = g.s.to_numpy(), g.dn.to_numpy(), g.m.to_numpy()
        nsat = ctx.nsat[gm]
        n = np.clip(nsat, 1, 3)
        phiV = np.select([n == 1, n == 2, n == 3], [em["phi_V"][k][gs, gd] for k in (1, 2, 3)])
        A_, V_ = g.A.to_numpy(float), g.V.to_numpy(float)
        has = np.ones(len(g), bool)
        variants = {}
        for kap_name, kap in (("kappa_estimated", np.clip(em["kappa_av"][gd], 0, 0.9)), ("kappa_0", 0.0)):
            H, Var, w = fuse(A_, V_, em["rho_A"][gs, gd], em["phi_A"][gs, gd],
                             em["rho_V"][gs, gd] + ctx.relvar[gs, gd], phiV, 0.0, has, has,
                             rM0=em["rho_A"][gs, gd], rV0=em["rho_V"][gs, gd],
                             kappa=np.nan_to_num(kap))
            variants[kap_name] = (H, Var, w)
        g["F"], g["Fvar"], g["w"] = variants["kappa_estimated"]
        g["F0"] = variants["kappa_0"][0]
        g["avg"] = 0.5 * (A_ + V_)
        varT = model_var(g["T"].to_numpy(float), gs, gd, {"rho_T": em["rho_T"], "phi_T": em["phi_T"]}, nsat, "T", ctx)
        g["varT"] = varT
        gg = g.groupby(["u", "m"], as_index=False)[["T", "A", "V", "F", "F0", "avg", "Fvar", "varT"]].sum()
        wsum = (g.w * g.F).groupby([g.u, g.m]).sum().to_numpy()
        gg["w"] = sdiv(wsum, gg.F.to_numpy(float))
        live = (gg[["T", "A", "V"]] > 0).any(axis=1)
        gg = gg[live]
        lt = np.log1p(gg["T"].to_numpy(float))
        met = {}
        for name, col in (("switch_aqua_only", "A"), ("viirs_only", "V"), ("fused", "F"), ("fused_kappa0", "F0"),
                          ("equal_weights", "avg")):
            lp = np.log1p(gg[col].to_numpy(float))
            met[name] = {"log_rmse": float(np.sqrt(np.mean((lp - lt) ** 2))),
                         "r_log1p": float(np.corrcoef(lp, lt)[0, 1]),
                         "bias_pct": float(100 * (gg[col].sum() / gg["T"].sum() - 1))}
        eF = np.abs(np.log1p(gg.F) - lt)
        cls = size_class(0.5 * (gg.A.to_numpy(float) + gg.V.to_numpy(float)))
        met["by_size"] = {}
        for ci in range(len(CONF_SIZE_EDGES) + 1):
            b = cls == ci
            if b.sum() < 30:
                continue
            lab = f"H<{CONF_SIZE_EDGES[0]:g}" if ci == 0 else (f"H>={CONF_SIZE_EDGES[-1]:g}" if ci == len(CONF_SIZE_EDGES)
                                                                 else f"{CONF_SIZE_EDGES[ci - 1]:g}-{CONF_SIZE_EDGES[ci]:g}")
            ltb = lt[b]
            met["by_size"][lab] = {"n": int(b.sum()), **{name: float(np.sqrt(np.mean((np.log1p(gg[col].to_numpy(float)[b]) - ltb) ** 2)))
                                   for name, col in (("switch_aqua_only", "A"), ("viirs_only", "V"), ("fused", "F"),
                                                     ("equal_weights", "avg"))}}
        met["fused_beats_both_share"] = float(((eF < np.abs(np.log1p(gg.A) - lt)) & (eF < np.abs(np.log1p(gg.V) - lt))).mean())
        met["mean_aqua_weight"] = float(np.average(gg.w, weights=np.maximum(gg.F, 1e-9)))
        # error-model consistency: does fused +- (its sigma combined with Terra's own error) cover Terra?
        H = gg.F.to_numpy(float)
        sig = np.sqrt(gg.Fvar.to_numpy(float) + gg.varT.to_numpy(float)) / (H + C_SHIFT)
        lr = np.abs(np.log((gg["T"].to_numpy(float) + C_SHIFT) / (H + C_SHIFT)))
        big = H >= 5
        met["model_cov80_vs_terra_H5"] = float((lr[big] <= Z80 * sig[big]).mean()) if big.any() else None
        met["model_cov95_vs_terra_H5"] = float((lr[big] <= Z95 * sig[big]).mean()) if big.any() else None
        met["n"] = int(len(gg))
        res[scale] = met
    out["non_circular_terra_reference"] = {
        "design": "Aqua (rescaled to the Terra∪Aqua scale, leave-one-year-out) is fused with leave-one-year-out "
                  "calibrated VIIRS using the Aqua and VIIRS error models; every candidate is scored against "
                  "Terra (rescaled the same way), which none of them contains. 'switch' = Aqua alone (the "
                  "MODIS stream before the switch). Aqua and VIIRS share the afternoon overpass, so this test "
                  "is mildly favourable to both against a morning reference; Terra's own noise adds the same "
                  "floor to every candidate.",
        "years": [TC_WINDOW[0][0], TC_WINDOW[1][0]], **res}
    # (b) MODIS weight by era and the fused global series (production streams, kernel formula)
    out["modis_weight_by_era"] = weight_by_era(d, em, dr, ctx)
    out["pettitt_fused"] = fused_changepoints(sf, em, dr, ctx)
    return out


def drift_terms(s, dn, m, dr: dict, ctx: Ctx, on: bool = True):
    """(log factor, extra rho) per group row for the drift correction (kernel formula)."""
    year = 2000 + m // 12
    yrs = dr["years"]
    yi = np.clip(np.searchsorted(yrs, year), 0, len(yrs) - 1)
    b = ctx.biome_code[s]
    lf = np.zeros(len(s))
    sd = np.zeros(len(s))
    keys = [k for k in dr["biome"] if k != "all"]
    for key, ent in dr["biome"].items():
        sel = (b == int(key)) if key != "all" else ~np.isin(b, [int(k) for k in keys])
        if sel.any():
            lf[sel] = np.array(ent["log_f"], float)[dn[sel], yi[sel]]
            sd[sel] = np.array(ent["log_sd"], float)[dn[sel], yi[sel]]
    act = (year >= dr["start_year"]) & on
    lf = np.where(act, lf, 0.0)
    extra = np.where(act, sd ** 2 + (dr["attr_frac"] * lf) ** 2, 0.0)
    return lf, extra, act


def fuse_production(M, V, s, dn, m, hasM, hasV, em, dr, ctx, use_drift=True):
    lf, extra, act = drift_terms(s, dn, m, dr, ctx, use_drift)
    Mc = M / np.exp(lf)
    nsat = ctx.nsat[np.minimum(m, len(ctx.nsat) - 1)]
    n = np.clip(nsat, 1, 3)
    phiV = np.select([n == 1, n == 2, n == 3], [em["phi_V"][k][s, dn] for k in (1, 2, 3)])
    bridge = m < ctx.cal["aqua_start_m"]
    rM0 = np.where(bridge, em["rho_B"][s, dn], em["rho_U"][s, dn])
    pM = np.where(bridge, em["phi_B"][s, dn], em["phi_U"][s, dn])
    rV0 = em["rho_V"][s, dn]
    cM = np.where(act, ctx.relvar[s, dn], 0.0)
    return fuse(Mc, V, rM0 + extra, pM, rV0 + ctx.relvar[s, dn], phiV, cM, hasM, hasV, rM0=rM0, rV0=rV0,
                kappa=em["kappa"][dn]), Mc


def weight_by_era(d: pd.DataFrame, em, dr, ctx) -> dict:
    x = d[d.U.notna() & d.KV.notna()]
    s, dn, m = x.s.to_numpy(), x.dn.to_numpy(), x.m.to_numpy()
    g = pd.DataFrame({"c1": x.c1.to_numpy(), "s": s, "dn": dn, "m": m, "M": x.U.to_numpy(float),
                      "V": x.KV.to_numpy(float)})
    has = np.ones(len(g), bool)
    (H, Var, w), _ = fuse_production(g.M.to_numpy(), g.V.to_numpy(), s, dn, m, has, has, em, dr, ctx)
    g["H"], g["wH"] = H, w * H
    c = g.groupby(["c1", "m"], as_index=False)[["H", "wH"]].sum()
    c = c[c.H > 0]
    c["w"] = c.wH / c.H
    c["year"] = 2000 + c.m // 12
    eras = {"2012-2019": (2012, 2019), "2020-2021": (2020, 2021), "2022-2025": (2022, 2025), "2026": (2026, 2026)}
    out = {}
    for name, (a, b) in eras.items():
        e = c[(c.year >= a) & (c.year <= b)]
        if len(e) == 0:
            continue
        big = e[e.H >= 20]
        out[name] = {"cell1deg_median": float(e.w.median()), "cell1deg_activity_weighted": float(np.average(e.w, weights=e.H)),
                     "cell1deg_median_H20": float(big.w.median()) if len(big) else None, "n_cell_months": int(len(e))}
    gy = g.assign(year=2000 + g.m // 12).groupby("year")[["H", "wH"]].sum()
    out["global_by_year"] = {int(y): float(r.wH / r.H) for y, r in gy.iterrows() if r.H > 0}
    return out


def fused_changepoints(sf: pd.DataFrame, em, dr, ctx) -> dict:
    sf = sf.copy()
    for c in ("s", "dn", "m"):
        sf[c] = sf[c].astype(np.int64)
    s, dn, m = sf.s.to_numpy(), sf.dn.to_numpy(), sf.m.to_numpy()
    am = ctx.am
    covm = am.cov_modis.to_numpy()[m]
    covv = am.cov_viirs.to_numpy()[m]
    vs = ctx.cal["viirs_start_m"]
    hasM = covm > 0
    hasV = (covv > 0) & (m >= vs)
    fullM, fullV = covm >= COV_MIN, covv >= COV_MIN
    useM = hasM & (fullM | ~(hasV & fullV))
    useV = hasV & (fullV | ~(hasM & fullM))
    (H, _, _), _ = fuse_production(sf.meq.to_numpy(float), sf.kv.to_numpy(float), s, dn, m, useM, useV, em, dr, ctx)
    sf["fused"] = H
    switch = ctx.cal["default_switch_m"]
    sf["switch"] = np.where((m < switch) & hasM | ~hasV, sf.meq, sf.kv)
    # naive raw-count records, named as in calibrate.py `pettitt`: MODIS counts, then VIIRS counts from the VIIRS
    # start (naive_viirs_from_2012, the tiles' / kernel's `naive`) or from the switch month (naive_switch_2023)
    sf["naive_viirs_from_2012"] = np.where(m < vs, sf.nmod, sf.nvii)
    sf["naive_switch_2023"] = np.where(m < switch, sf.nmod, sf.nvii)
    cols = ("fused", "switch", "naive_switch_2023", "naive_viirs_from_2012")
    tot = sf.groupby("m")[[*cols, "meq", "kv"]].sum()
    tot = tot.reindex(range(ctx.cal["m_first"], ctx.cal["m_last"] + 1), fill_value=0)

    def test(col, lo, hi):
        x = tot[col].loc[lo:hi]
        lg = np.log(np.maximum(x.to_numpy(float), 1.0))
        moy = x.index.to_numpy() % 12
        clim = pd.Series(lg).groupby(moy).transform("mean").to_numpy()
        t, K, p = pettitt(lg - clim)
        cm = int(x.index[t + 1])
        return {"change_m": cm, "change_month": f"{2000 + cm // 12}-{cm % 12 + 1:02d}", "K": K, "p": p,
                "step_log": float(np.mean((lg - clim)[t + 1:]) - np.mean((lg - clim)[:t + 1]))}

    last_full = int(max(i for i in tot.index if ctx.am.cov_viirs.to_numpy()[i] >= COV_MIN and ctx.am.cov_modis.to_numpy()[i] >= COV_MIN))
    events = {"viirs_start": vs, "drift_start": month_index(DRIFT_START_YEAR, 1), "legacy_switch": switch}
    out = {}
    for ev, c in events.items():
        lo, hi = max(c - 36, ctx.cal["m_first"]), min(c + 35, last_full)
        out[ev] = {"window_m": [lo, hi], "event_m": c,
                   **{col: test(col, lo, hi) for col in cols}}
    gy = tot.assign(year=2000 + tot.index // 12).groupby("year")[["fused", "meq", "kv"]].sum()
    out["fused_to_modis_by_year"] = {int(y): float(r.fused / r.meq) if r.meq > 0 else None for y, r in gy.iterrows()
                                     if y >= 2012}
    return out


# ------------------------------------------------------------------------------------------
# sensor tests

def metr(p, o):
    p, o = np.asarray(p, float), np.asarray(o, float)
    k = (p > 0) | (o > 0)
    p, o = p[k], o[k]
    if len(p) < 3 or o.sum() <= 0:
        return {"n": int(len(p))}
    lp, lo = np.log1p(p), np.log1p(o)
    return {"n": int(len(p)), "bias_pct": float(100 * (p.sum() / o.sum() - 1)),
            "log_rmse": float(np.sqrt(np.mean((lp - lo) ** 2))), "r_log1p": float(np.corrcoef(lp, lo)[0, 1])}


def noaa21_blind(d: pd.DataFrame, sc: dict, dr: dict, ctx: Ctx) -> dict:
    m0 = month_index(2023, 3)
    x = d[(d.m >= m0) & d.N21.notna() & d.U.notna()].copy()
    if len(x) == 0:
        return {"note": "no NOAA-21 data"}
    key = key_sdm(x)
    s, dn = x.s.to_numpy(), x.dn.to_numpy()
    x["N21c"] = x.N21.to_numpy(float) * ctx.c21[s, dn] * ctx.k.reshape(-1)[key]
    x["N20c"] = x.N20.to_numpy(float) * ctx.c20[s, dn] * ctx.k.reshape(-1)[key]
    x["Sc"] = x.SN.to_numpy(float) * ctx.k.reshape(-1)[key]
    x["Uc"] = x.U.to_numpy(float) / drift_factor_rows(x, dr, ctx)
    x["year"] = 2000 + x.m // 12
    out = {"note": "NOAA-21 enters no VIIRS->MODIS fit: calibrated NOAA-21 = NOAA-21 x c21 (NOAA-21->S-NPP, from "
                   "the S-NPP overlap) x k (S-NPP-equivalent->MODIS, 2012-2021). No per-cell multiplier.",
           "by_year": []}
    for y, g in x.groupby("year"):
        st = g.groupby(["s", "m"])[["N21c", "N20c", "Sc", "U", "Uc"]].sum(min_count=1)
        c1 = g.groupby(["c1", "m"])[["N21c", "N20c", "Sc", "U", "Uc"]].sum(min_count=1)
        row = {"year": int(y), "months": int(g.m.nunique())}
        for ref in ("U", "Uc"):
            row[f"vs_{'modis' if ref == 'U' else 'modis_drift_corrected'}"] = {
                "stratum_month": metr(st.N21c, st[ref]), "cell1deg_month": metr(c1.N21c, c1[ref])}
        for other in ("N20c", "Sc"):
            ok = st[other].notna()
            row[f"vs_{'noaa20' if other == 'N20c' else 'snpp'}_calibrated"] = metr(st.N21c[ok], st[other][ok])
        row["noaa20_vs_modis_stratum_month"] = metr(st.N20c, st.U)
        out["by_year"].append(row)
    return out


def closure(d: pd.DataFrame, sc: dict, ctx: Ctx) -> dict:
    """NOAA-20 -> MODIS directly vs the chain NOAA-20 -> S-NPP (c20) -> MODIS (k_S), same months (2018-2019)."""
    m = d.m.to_numpy()
    key = key_sdm(d)
    w = (m >= month_index(2018, 1)) & (m <= month_index(2019, 12)) & d.SN.notna().to_numpy() & d.N20.notna().to_numpy()
    U = d.U.to_numpy(float)
    kS = ratio_k(U, d.SN.to_numpy(float), key, ctx, w & np.isfinite(U))
    kN = ratio_k(U, d.N20.to_numpy(float), key, ctx, w & np.isfinite(U))
    chain = ctx.c20[:, :, None] * kS
    lr = np.log(sdiv(chain, kN) + 1e-300)
    wts = np.bincount(key[w], d.N20.to_numpy(float)[w], minlength=ctx.nS * 24).reshape(ctx.nS, 2, 12)
    ok = (kN > 0) & (chain > 0) & (wts > 0)
    out = {"note": "log(chain / direct) of the NOAA-20 -> MODIS factor per stratum x dn x month-of-year, "
                   "NOAA-20-weighted; out-of-sample: 2020-2021 1-degree cell-months vs Terra∪Aqua",
           "weighted_mean_log": float(np.average(lr[ok], weights=wts[ok])),
           "weighted_rms_log": float(np.sqrt(np.average(lr[ok] ** 2, weights=wts[ok]))),
           "by_dn": {("day" if dn == 0 else "night"): float(np.average(lr[:, dn][ok[:, dn]], weights=wts[:, dn][ok[:, dn]]))
                     for dn in (0, 1) if ok[:, dn].any()}}
    t = (m >= month_index(2020, 1)) & (m <= month_index(2021, 12)) & d.N20.notna().to_numpy() & np.isfinite(U)
    x = d[t]
    k2 = key[t]
    pc = x.N20.to_numpy(float) * chain.reshape(-1)[k2]
    pdir = x.N20.to_numpy(float) * kN.reshape(-1)[k2]
    g = pd.DataFrame({"c1": x.c1, "m": x.m, "pc": pc, "pd": pdir, "U": x.U}).groupby(["c1", "m"]).sum()
    out["oos_2020_2021"] = {"chain": metr(g.pc, g.U), "direct": metr(g["pd"], g.U)}
    return out


def power_law(d: pd.DataFrame, ctx: Ctx) -> dict:
    """Diagnostic: M = a(s, dn, moy) V^b(biome group, dn) vs proportional M = k(s, dn, moy) V at the 1-degree x
    stratum row, b chosen by in-sample Poisson deviance on a grid, LOYO scored at 1 degree and stratum-month."""
    fit0, fit1 = ym_index(FIT_START), ym_index(FIT_END)
    x = d[(d.m >= fit0) & (d.m <= fit1) & d.U.notna() & d.V.notna()]
    U, V = x.U.to_numpy(float), x.V.to_numpy(float)
    key = key_sdm(x)
    gdn = ctx.group[x.s.to_numpy()] * 2 + x.dn.to_numpy()
    grid = np.round(np.arange(0.6, 1.51, 0.05), 2)
    dev = np.zeros((len(grid), ctx.nG * 2))
    for i, b in enumerate(grid):
        Vb = V ** b
        a = ratio_k(U, Vb, key, ctx, np.ones(len(x), bool))
        mu = a.reshape(-1)[key] * Vb
        ok = mu > 0
        dv = np.where(U > 0, U * np.log(np.where(U > 0, U, 1) / np.where(ok, mu, 1)), 0) - (U - mu)
        dev[i] = np.bincount(gdn, 2 * dv, minlength=ctx.nG * 2)
    bsel = grid[np.argmin(dev, 0)]
    brow = bsel[gdn]
    yr = 2000 + x.m.to_numpy() // 12
    pp, pl = np.zeros(len(x)), np.zeros(len(x))
    for y in np.unique(yr):
        tr, te = yr != y, yr == y
        k1 = ratio_k(U, V, key, ctx, tr)
        Vb = V ** brow
        a = ratio_k(U, Vb, key, ctx, tr)
        pp[te] = k1.reshape(-1)[key[te]] * V[te]
        pl[te] = a.reshape(-1)[key[te]] * Vb[te]
    g1 = pd.DataFrame({"c1": x.c1, "m": x.m, "pp": pp, "pl": pl, "U": U}).groupby(["c1", "m"]).sum()
    g2 = pd.DataFrame({"s": x.s, "m": x.m, "pp": pp, "pl": pl, "U": U}).groupby(["s", "m"]).sum()
    return {"note": "diagnostic only; a power of V is not additive across cells, so it cannot be applied at L0 "
                    "and summed (the tiles' levels add exactly); no per-cell multiplier in either model",
            "b_by_group": {ctx.group_names[i // 2] + (" day" if i % 2 == 0 else " night"): float(bsel[i])
                           for i in range(ctx.nG * 2) if dev[:, i].any()},
            "loyo_cell1deg": {"proportional": metr(g1.pp, g1.U), "power": metr(g1.pl, g1.U)},
            "loyo_stratum_month": {"proportional": metr(g2.pp, g2.U), "power": metr(g2.pl, g2.U)}}


def k_refit(d: pd.DataFrame, ctx: Ctx) -> dict:
    """How much the VIIRS->MODIS factor changes when the fit window ends in 2019 instead of 2021."""
    m = d.m.to_numpy()
    key = key_sdm(d)
    U, V = d.U.to_numpy(float), d.V.to_numpy(float)
    ok = np.isfinite(U) & np.isfinite(V) & d.A.notna().to_numpy()
    fit0 = ym_index(FIT_START)
    a = ratio_k(U, V, key, ctx, ok & (m >= fit0) & (m <= ym_index(FIT_END)))
    b = ratio_k(U, V, key, ctx, ok & (m >= fit0) & (m <= month_index(2019, 12)))
    w = np.bincount(key[ok & (m >= fit0) & (m <= ym_index(FIT_END))], V[ok & (m >= fit0) & (m <= ym_index(FIT_END))],
                    minlength=ctx.nS * 24).reshape(ctx.nS, 2, 12)
    out = {"note": "V-weighted sum(k_2012-2019 V) / sum(k_2012-2021 V) - 1, in %",
           "global_pct": float(100 * ((b * w).sum() / (a * w).sum() - 1)), "by_group": {}}
    for gi, name in enumerate(ctx.group_names):
        sel = ctx.group == gi
        if (a[sel] * w[sel]).sum() > 0:
            out["by_group"][name] = [float(100 * ((b[sel][:, dn] * w[sel][:, dn]).sum() / (a[sel][:, dn] * w[sel][:, dn]).sum() - 1))
                                     if (a[sel][:, dn] * w[sel][:, dn]).sum() > 0 else None for dn in (0, 1)]
    return out
