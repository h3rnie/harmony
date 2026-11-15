"""Cross-calibration VIIRS -> MODIS-equivalent and Terra-only -> Terra+Aqua, plus validation.

All ratios are quasi-Poisson MLEs of a multiplicative model E[M] = k * V (log link, log V offset),
whose estimate is the ratio of sums k = sum M / sum V. Streams are coverage-corrected before fitting
(value / cov, months with cov < 0.5 excluded), the same correction applied when tiles are built.

1. NOAA-20 / NOAA-21 -> S-NPP: c = sum vs / sum v20 (resp. v21) per stratum x dn over months in which
   both satellites were available every day; fallback biome x dn, then global x dn, when either sum
   < K_MIN_SUM. Without NOAA-21 data, c21 = c20 (same JPSS VIIRS design). Then the S-NPP-equivalent
   per-day mean is V = ws + c20*w20 + c21*w21.
2. k[s, dn, month-of-year] = sum M / sum V over FIT_START..FIT_END (M = Terra+Aqua AFCD), fallback
   chain stratum x dn x moy -> stratum x dn -> biome x dn -> global x dn (first level whose sum M >=
   K_MIN_SUM).
3. Per-cell multiplier, empirical-Bayes gamma-Poisson shrinkage toward 1:
   r[l0, dn] = (sum M + tau) / (sum k V + tau). tau is chosen from TAU_GRID by leave-one-year-out
   (LOYO) RMSE of log1p at 1-degree cell-month scale.
4. Terra -> Terra+Aqua bridge: same model with M = m_ta, V = m_t over BRIDGE_START..BRIDGE_END, applied
   to months before AQUA_START.
5. relvar[s, dn] = year-jackknife Var(k)/k^2 averaged over month-of-year (weights sum V). This is the
   estimation error of k; year-to-year variability of the true ratio is absorbed by ci_scale.
   alpha[s, dn] = NB dispersion by method of moments on in-sample L0 cell-month residuals:
   alpha = max(0, sum((M - mu)^2 - mu) / sum mu^2), mu = k r V.
   ci_scale = the factor that makes the contract's 80 % interval cover 80 % of LOYO 1-degree
   cell-months with predicted H >= 5 AFCD.
Outputs: data/work/coefficients/*.parquet, data/work/coefficients/calib.json, data/dist/validation.json.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .afcd import OUT as CUBE, month_last
from .availability import OUT_M as AVAIL_M
from .common import connect, fresh, is_regional, posix, timed, write_json
from .config import (AQUA_START, BRIDGE_END, BRIDGE_START, COV_MAX_CORR, COV_MIN, DEFAULT_SWITCH, DIST,
                     FIT_END, FIT_START, K_MIN_SUM, L0_NX, TAU_GRID, WORK, ym_index)
from .strata import OUT_CELLS, OUT_STRATA

COEF = WORK / "coefficients"
CALIB_JSON = COEF / "calib.json"
VALIDATION = DIST / "validation.json"
Z80, Z95 = 1.2816, 1.96
LEVELS = ["stratum_dn_moy", "stratum_dn", "biome_dn", "global_dn", "none"]


def cf(cov: str) -> str:
    """SQL coverage-correction factor: 1/cov capped at COV_MAX_CORR; uncorrected below COV_MIN."""
    return f"(CASE WHEN {cov} >= {COV_MIN} THEN least(1.0 / {cov}, {COV_MAX_CORR}) ELSE 1.0 END)"


def sdiv(a, b):
    a, b = np.broadcast_arrays(np.asarray(a, float), np.asarray(b, float))
    return np.divide(a, b, out=np.zeros(a.shape), where=b > 0)


def fit_k(num: np.ndarray, den: np.ndarray, biome: np.ndarray, n_biome: int):
    """Ratio with fallback chain. num/den: (nS, 2, 12) sums. Returns k (nS,2,12), level index."""
    l2n, l2d = num.sum(2, keepdims=True), den.sum(2, keepdims=True)
    b3n, b3d = np.zeros((n_biome, 2)), np.zeros((n_biome, 2))
    np.add.at(b3n, biome, num.sum(2))
    np.add.at(b3d, biome, den.sum(2))
    l3n, l3d = b3n[biome][:, :, None], b3d[biome][:, :, None]
    l4n, l4d = num.sum((0, 2))[None, :, None], den.sum((0, 2))[None, :, None]
    shape = num.shape
    ok = [(num >= K_MIN_SUM) & (den > 0), np.broadcast_to((l2n >= K_MIN_SUM) & (l2d > 0), shape),
          np.broadcast_to((l3n >= K_MIN_SUM) & (l3d > 0), shape), np.broadcast_to(l4d > 0, shape)]
    vals = [sdiv(num, den), np.broadcast_to(sdiv(l2n, l2d), shape),
            np.broadcast_to(sdiv(l3n, l3d), shape), np.broadcast_to(sdiv(l4n, l4d), shape)]
    k = np.select(ok, vals, 1.0)
    level = np.select(ok, [0, 1, 2, 3], 4)
    return k, level


def ratio2d(A: np.ndarray, B: np.ndarray, biome: np.ndarray, n_biome: int):
    """Ratio A/B per (stratum, dn) with fallback biome -> global when min(sum A, sum B) < K_MIN_SUM.
    Returns (ratio with NaN where no data at any level, level index into LEVELS)."""
    bA, bB = np.zeros((n_biome, 2)), np.zeros((n_biome, 2))
    np.add.at(bA, biome, A)
    np.add.at(bB, biome, B)
    gA, gB = np.broadcast_to(A.sum(0), A.shape), np.broadcast_to(B.sum(0), A.shape)
    ok = [(np.minimum(A, B) >= K_MIN_SUM) & (B > 0),
          (np.minimum(bA, bB)[biome] >= K_MIN_SUM) & (bB[biome] > 0), gB > 0]
    c = np.select(ok, [sdiv(A, B), sdiv(bA, bB)[biome], sdiv(gA, gB)], np.nan)
    return c, np.select(ok, [1, 2, 3], 4)


@dataclass
class Rows:
    """Fit rows at L0 x month x dn (numpy columns)."""
    l0: np.ndarray
    s: np.ndarray
    dn: np.ndarray
    m: np.ndarray
    num: np.ndarray   # MODIS-side (observed) stream
    den: np.ndarray   # predictor stream

    def sel(self, mask) -> "Rows":
        return Rows(*(getattr(self, f)[mask] for f in ("l0", "s", "dn", "m", "num", "den")))

    @property
    def yr(self):
        return 2000 + self.m // 12

    @property
    def moy(self):
        return self.m % 12

    @property
    def key(self):
        return (self.s.astype(np.int64) * 2 + self.dn) * 12 + self.moy

    @property
    def c1(self):
        l0 = self.l0.astype(np.int64)
        return (l0 // L0_NX // 20) * 360 + (l0 % L0_NX) // 20


@dataclass
class Fit:
    k: np.ndarray
    level: np.ndarray
    tau: float
    tau_rmse: dict
    cells: np.ndarray        # (l0*2+dn) keys
    r: np.ndarray            # multiplier per cell key
    pred_loyo: np.ndarray    # held-out prediction per fit row
    relvar: np.ndarray       # (nS, 2)
    alpha: np.ndarray        # (nS, 2)
    k_loyo: dict = field(default_factory=dict)


def group_sum(keys: np.ndarray, *vals):
    u, inv = np.unique(keys, return_inverse=True)
    return u, [np.bincount(inv, v, minlength=len(u)) for v in vals]


def fit_stream(R: Rows, nS: int, biome: np.ndarray, n_biome: int, years: list[int], taus) -> Fit:
    """Fit k (with fallbacks), choose tau by LOYO at 1 deg cell-month, final r, relvar, alpha."""
    key, yr = R.key, R.yr
    nK = nS * 24
    years = [y for y in years if (yr == y).any()]
    Snum = {y: np.bincount(key[yr == y], R.num[yr == y], minlength=nK).reshape(nS, 2, 12) for y in years}
    Sden = {y: np.bincount(key[yr == y], R.den[yr == y], minlength=nK).reshape(nS, 2, 12) for y in years}
    Tn, Td = sum(Snum.values()), sum(Sden.values())
    k, level = fit_k(Tn, Td, biome, n_biome)
    cells, cid = np.unique(R.l0.astype(np.int64) * 2 + R.dn, return_inverse=True)
    nC = len(cells)
    c1m = R.c1 * 400 + R.m

    def loyo(y, tau_list):
        te = yr == y
        ky, _ = fit_k(Tn - Snum[y], Td - Sden[y], biome, n_biome)
        kr = ky.reshape(-1)[key]
        tr = ~te
        numc = np.bincount(cid[tr], R.num[tr], minlength=nC)
        kden = np.bincount(cid[tr], kr[tr] * R.den[tr], minlength=nC)
        out = {}
        for tau in tau_list:
            rr = np.ones(nC) if math.isinf(tau) else (numc + tau) / (kden + tau)
            out[tau] = kr[te] * rr[cid[te]] * R.den[te]
        return te, ky, out

    sse = {t: 0.0 for t in taus}
    cnt = {t: 0 for t in taus}
    for y in years:
        te, _, preds = loyo(y, taus)
        for t, p in preds.items():
            _, (P, O) = group_sum(c1m[te], p, R.num[te])
            e = np.log1p(P) - np.log1p(O)
            sse[t] += float((e ** 2).sum())
            cnt[t] += len(e)
    rmse = {("inf" if math.isinf(t) else t): math.sqrt(sse[t] / max(cnt[t], 1)) for t in taus}
    # Selection effect: tau is the grid value that minimises these LOYO predictions, and the same LOYO predictions
    # (at this tau) are then reported as validation, so the reported 1-degree LOYO scores carry a small optimism from
    # the five-way choice. k and the per-cell multiplier r are refitted without the held-out year in every fold.
    # Documented in docs/METHOD.md, section 11.
    tau = min(taus, key=lambda t: sse[t])
    pred = np.zeros(len(R.num))
    k_loyo = {}
    for y in years:
        te, ky, preds = loyo(y, [tau])
        pred[te] = preds[tau]
        k_loyo[y] = ky
    kr = k.reshape(-1)[key]
    numc = np.bincount(cid, R.num, minlength=nC)
    kden = np.bincount(cid, kr * R.den, minlength=nC)
    r = np.ones(nC) if math.isinf(tau) else (numc + tau) / (kden + tau)
    # jackknife relative variance of k, V-weighted over month-of-year
    n = len(years)
    if n > 1:
        ks = np.stack([k_loyo[y] for y in years])
        jv = (n - 1) / n * ((ks - ks.mean(0)) ** 2).sum(0)
        rv = sdiv(jv, k ** 2)
        relvar = sdiv((rv * Td).sum(2), Td.sum(2))
    else:
        relvar = np.zeros((nS, 2))
    # NB dispersion by method of moments on in-sample residuals; global per dn when sparse
    mu = kr * r[cid] * R.den
    sk = R.s.astype(np.int64) * 2 + R.dn
    A = np.bincount(sk, (R.num - mu) ** 2 - mu, minlength=nS * 2).reshape(nS, 2)
    B = np.bincount(sk, mu ** 2, minlength=nS * 2).reshape(nS, 2)
    Mu = np.bincount(sk, mu, minlength=nS * 2).reshape(nS, 2)
    glob = np.clip(sdiv(A.sum(0), B.sum(0)), 0, None)
    alpha = np.where(Mu >= K_MIN_SUM, np.clip(sdiv(A, B), 0, None), glob[None, :])
    return Fit(k, level, tau, rmse, cells, r, pred, relvar, alpha, k_loyo)


# ------------------------------------------------------------------------------------------
# validation helpers

def pettitt(x: np.ndarray):
    """Pettitt (1979) change-point test. Returns (index of last point before change, K, p)."""
    x = np.asarray(x, float)
    n = len(x)
    sg = np.sign(x[None, :] - x[:, None])           # sg[i, j] = sign(x_j - x_i)
    U = np.array([sg[: t + 1, t + 1:].sum() for t in range(n - 1)])
    t = int(np.argmax(np.abs(U)))
    K = float(abs(U[t]))
    p = min(1.0, 2 * math.exp(-6 * K ** 2 / (n ** 3 + n ** 2)))
    return t, K, p


def unit_metrics(df: pd.DataFrame, min_peak: float = 10.0) -> dict:
    """df: unit, yr, moy, pred, obs at unit-month scale (missing months = 0)."""
    d = df[(df.pred > 0) | (df.obs > 0)]
    if len(d) < 3 or d.obs.sum() <= 0:
        return {"n": int(len(d))}
    lp, lo = np.log1p(d.pred.to_numpy()), np.log1p(d.obs.to_numpy())
    out = {"n": int(len(d)), "r_log1p": float(np.corrcoef(lp, lo)[0, 1]),
           "log_rmse": float(np.sqrt(np.mean((lp - lo) ** 2))),
           "bias_pct": float(100 * (d.pred.sum() - d.obs.sum()) / d.obs.sum()),
           "slope": float(np.polyfit(lp, lo, 1)[0])}
    full = df.pivot_table(index=["unit", "yr"], columns="moy", values=["pred", "obs"], aggfunc="sum",
                          fill_value=0.0)
    P = full["pred"].reindex(columns=range(12), fill_value=0).to_numpy()
    O = full["obs"].reindex(columns=range(12), fill_value=0).to_numpy()
    ok = O.sum(1) >= min_peak
    if ok.any():
        dp = np.abs(P[ok].argmax(1) - O[ok].argmax(1))
        dp = np.minimum(dp, 12 - dp)
        out["peak_exact"] = float((dp == 0).mean())
        out["peak_within1"] = float((dp <= 1).mean())
        out["n_unit_years"] = int(ok.sum())
    units = full.index.get_level_values(0).to_numpy()
    u, inv = np.unique(units, return_inverse=True)
    cnt = np.bincount(inv, minlength=len(u))[:, None]
    climP = np.zeros((len(u), 12)); np.add.at(climP, inv, P)
    climO = np.zeros((len(u), 12)); np.add.at(climO, inv, O)
    aP, aO = P - (climP / cnt)[inv], O - (climO / cnt)[inv]
    sel = ((climO / cnt)[inv] >= 1.0) & (aO != 0) & (cnt[inv] >= 3)
    if sel.any():
        out["anomaly_sign_agree"] = float((np.sign(aP[sel]) == np.sign(aO[sel])).mean())
    return out


def r3(x):
    if isinstance(x, dict):
        return {k: r3(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [r3(v) for v in x]
    if isinstance(x, (float, np.floating)):
        return None if not np.isfinite(x) else round(float(x), 4)
    if isinstance(x, np.integer):
        return int(x)
    return x


# ------------------------------------------------------------------------------------------

def load_rows(con, sql: str) -> dict:
    return {k: v for k, v in con.execute(sql).fetchnumpy().items()}


def l0_values_sql() -> str:
    """Harmonized per (l0, stratum, m, dn) values in AFCD units from cube + coefficients.

    meq: Terra+Aqua AFCD / cov_modis from AQUA_START; before, Terra AFCD x kb x rb / cov_terra.
    v:   S-NPP-equivalent per-day VIIRS mean / cov_viirs, from viirs_start_m. kv = v x k x r.
    """
    cal = json.loads(CALIB_JSON.read_text())
    aqua_m, vs_m = cal["aqua_start_m"], cal["viirs_start_m"]
    return f"""
    WITH c AS (
      SELECT cu.*, sc.stratum AS s, cu.m % 12 AS moy, am.cov_modis, am.cov_terra, am.cov_viirs
      FROM read_parquet('{posix(CUBE)}') cu JOIN read_parquet('{posix(OUT_CELLS)}') sc USING (l0)
      JOIN read_parquet('{posix(AVAIL_M)}') am USING (m)
      WHERE cu.m BETWEEN {cal['m_first']} AND {cal['m_last']})
    SELECT c.l0, c.s, c.m, c.dn,
      CASE WHEN c.m < {aqua_m} THEN c.m_t * kc.kb * coalesce(rc.rb, 1) * {cf('c.cov_terra')}
           ELSE c.m_ta * {cf('c.cov_modis')} END AS meq,
      CASE WHEN c.m >= {vs_m} THEN (c.ws + nf.c20 * c.w20 + nf.c21 * c.w21) * {cf('c.cov_viirs')}
           ELSE 0 END AS v,
      v * kc.k * coalesce(rc.r, 1) AS kv,
      c.nmod, c.nvii
    FROM c
    JOIN read_parquet('{posix(COEF / "k.parquet")}') kc ON kc.s = c.s AND kc.dn = c.dn AND kc.moy = c.moy
    JOIN read_parquet('{posix(COEF / "noaa.parquet")}') nf ON nf.s = c.s AND nf.dn = c.dn
    LEFT JOIN read_parquet('{posix(COEF / "r.parquet")}') rc ON rc.l0 = c.l0 AND rc.dn = c.dn"""


def main(force: bool = False) -> None:
    deps = [CUBE, OUT_CELLS, OUT_STRATA, AVAIL_M]
    if not force and fresh(VALIDATION, deps) and fresh(CALIB_JSON, deps):
        print("[calibrate] up to date")
        return
    COEF.mkdir(parents=True, exist_ok=True)
    con = connect()
    t_all = __import__("time").time()
    strata = con.execute(f"SELECT * FROM '{posix(OUT_STRATA)}' ORDER BY id").df()
    nS = len(strata)
    biome_codes, biome = np.unique(strata.biome.to_numpy(), return_inverse=True)
    nB = len(biome_codes)
    m_last = month_last(con)
    am = con.execute(f"SELECT * FROM '{posix(AVAIL_M)}' ORDER BY m").df().set_index("m")
    viirs_start_m = int(am.index[(am.cov_viirs >= COV_MIN)].min())
    aqua_m, fit0, fit1 = ym_index(AQUA_START), ym_index(FIT_START), ym_index(FIT_END)
    b0, b1 = ym_index(BRIDGE_START), ym_index(BRIDGE_END)
    cube = f"read_parquet('{posix(CUBE)}') c JOIN read_parquet('{posix(OUT_CELLS)}') sc USING (l0) " \
           f"JOIN read_parquet('{posix(AVAIL_M)}') am USING (m)"

    # 1. NOAA-20 / NOAA-21 -> S-NPP ------------------------------------------------------
    with timed("calibrate noaa factors"):
        ov = con.execute(f"""SELECT sc.stratum s, c.dn,
              coalesce(sum(vs) FILTER (am.f_snpp = 1 AND am.f_noaa20 = 1), 0) AS a20,
              coalesce(sum(v20) FILTER (am.f_snpp = 1 AND am.f_noaa20 = 1), 0) AS b20,
              coalesce(sum(vs) FILTER (am.f_snpp = 1 AND am.f_noaa21 = 1), 0) AS a21,
              coalesce(sum(v21) FILTER (am.f_snpp = 1 AND am.f_noaa21 = 1), 0) AS b21
            FROM {cube} GROUP BY ALL""").df()
        noaa = {}
        for sat in ("20", "21"):
            A, Bv = np.zeros((nS, 2)), np.zeros((nS, 2))
            A[ov.s, ov.dn] = ov[f"a{sat}"]
            Bv[ov.s, ov.dn] = ov[f"b{sat}"]
            noaa[sat] = ratio2d(A, Bv, biome, nB)
        (c20, l20), (c21, l21) = noaa["20"], noaa["21"]
        c20 = np.where(np.isnan(c20), 1.0, c20)
        c21 = np.where(np.isnan(c21), c20, c21)     # no NOAA-21 overlap -> same as NOAA-20
        nrows = [(s, d, float(c20[s, d]), float(c21[s, d]), LEVELS[l20[s, d]],
                  LEVELS[l21[s, d]] if l21[s, d] < 4 else "as_noaa20")
                 for s in range(nS) for d in (0, 1)]
        ndf = pd.DataFrame(nrows, columns=["s", "dn", "c20", "c21", "level20", "level21"])
        ndf.s, ndf.dn = ndf.s.astype("uint16"), ndf.dn.astype("uint8")
        con.register("ndf", ndf)
        con.execute(f"COPY ndf TO '{posix(COEF / 'noaa.parquet')}' (FORMAT parquet)")

    vexpr = "(c.ws + nf.c20 * c.w20 + nf.c21 * c.w21)"
    base = f"{cube} JOIN read_parquet('{posix(COEF / 'noaa.parquet')}') nf ON nf.s = sc.stratum AND nf.dn = c.dn"

    # 2-3. VIIRS -> MODIS ------------------------------------------------------------------
    with timed("calibrate viirs->modis"):
        d = load_rows(con, f"""SELECT c.l0, sc.stratum AS s, c.dn, c.m,
                c.m_ta / am.cov_modis AS num, {vexpr} / am.cov_viirs AS den,
                c.m_a / nullif(am.f_aqua, 0) AS num_aqua
            FROM {base} WHERE c.m BETWEEN {viirs_start_m} AND {m_last}
              AND am.cov_modis >= {COV_MIN} AND am.cov_viirs >= {COV_MIN} AND am.f_aqua >= {COV_MIN}""")
        A = Rows(d["l0"], d["s"], d["dn"], d["m"], d["num"], d["den"])
        in_fit = (A.m >= fit0) & (A.m <= fit1)
        F = A.sel(in_fit)
        fit = fit_stream(F, nS, biome, nB, list(range(FIT_START[0], FIT_END[0] + 1)), TAU_GRID)
        print(f"  tau={fit.tau} rmse={fit.tau_rmse}")

    # 4. Terra -> Terra+Aqua bridge ------------------------------------------------------------
    with timed("calibrate bridge"):
        d = load_rows(con, f"""SELECT c.l0, sc.stratum AS s, c.dn, c.m,
                c.m_ta / am.cov_modis AS num, c.m_t / am.f_terra AS den
            FROM {cube} WHERE c.m BETWEEN {b0} AND {b1} AND am.f_terra >= {COV_MIN} AND am.f_aqua >= {COV_MIN}""")
        BR = Rows(d["l0"], d["s"], d["dn"], d["m"], d["num"], d["den"])
        bfit = fit_stream(BR, nS, biome, nB, list(range(BRIDGE_START[0], BRIDGE_END[0] + 1)), TAU_GRID)
        print(f"  bridge tau={bfit.tau} rmse={bfit.tau_rmse}")

    # LOYO predictions at (1-degree cell, stratum, dn, month) for harmonize.py (conformal, error model) ----------
    with timed("calibrate loyo table"):
        lk = ((F.c1.astype(np.int64) * nS + F.s) * 2 + F.dn) * 400 + F.m
        u, (P, P2, O) = group_sum(lk, fit.pred_loyo, fit.pred_loyo ** 2, F.num)
        ldf = pd.DataFrame({"c1": (u // 400 // 2 // nS).astype("uint32"), "s": (u // 400 // 2 % nS).astype("uint16"),
                            "dn": (u // 400 % 2).astype("uint8"), "m": (u % 400).astype("uint16"),
                            "P": P, "P2": P2, "O": O})
        con.register("ldf", ldf)
        con.execute(f"COPY ldf TO '{posix(COEF / 'loyo_c1.parquet')}' (FORMAT parquet)")
        con.unregister("ldf")

    # ci_scale (legacy, kept for the legacy interval) from LOYO predictions at 1 deg cell-months ----------
    with timed("calibrate ci_scale"):
        sdn = F.s.astype(np.int64) * 2 + F.dn
        g = (F.c1 * 400 + F.m) * (nS * 2) + sdn
        u, (P1, P2, O) = group_sum(g, fit.pred_loyo, fit.pred_loyo ** 2, F.num)
        us = u % (nS * 2)
        rv, al = fit.relvar.reshape(-1)[us], fit.alpha.reshape(-1)[us]
        term = rv * P1 ** 2 + P1 + al * P2
        _, (H, V, Ob) = group_sum(u // (nS * 2), P1, term, O)
        sig = np.sqrt(V) / np.maximum(H, 0.5)
        ev = H >= 5
        need = np.where(Ob[ev] > 0, np.abs(np.log(np.maximum(Ob[ev], 1e-9) / H[ev])) / (Z80 * sig[ev]), np.inf)
        ci_scale = float(np.quantile(need, 0.8)) if ev.any() else 1.0
        if not np.isfinite(ci_scale):
            ci_scale = float(np.nanmax(need[np.isfinite(need)])) if np.isfinite(need).any() else 1.0
        cover = {}
        for lo_, hi_ in [(5, 20), (20, 100), (100, 1e12), (5, 1e12)]:
            b = ev & (H >= lo_) & (H < hi_)
            if b.any():
                lr = np.abs(np.log(np.maximum(Ob[b], 1e-9) / H[b]))
                cover[f"H_{lo_}_{'inf' if hi_ > 1e11 else int(hi_)}"] = {
                    "n": int(b.sum()),
                    "cov80": float((lr <= Z80 * ci_scale * sig[b]).mean()),
                    "cov95": float((lr <= Z95 * ci_scale * sig[b]).mean()),
                    "cov80_unscaled": float((lr <= Z80 * sig[b]).mean())}
        print(f"  ci_scale={ci_scale:.3f} coverage={cover.get('H_5_inf')}")

    # write coefficients ------------------------------------------------------------------
    with timed("calibrate write coefficients"):
        rows_k = []
        for s in range(nS):
            for dn in (0, 1):
                for moy in range(12):
                    rows_k.append((s, dn, moy, fit.k[s, dn, moy], LEVELS[fit.level[s, dn, moy]],
                                   bfit.k[s, dn, moy], LEVELS[bfit.level[s, dn, moy]]))
        kdf = pd.DataFrame(rows_k, columns=["s", "dn", "moy", "k", "level", "kb", "level_b"])
        kdf.s, kdf.dn, kdf.moy = kdf.s.astype("uint16"), kdf.dn.astype("uint8"), kdf.moy.astype("int64")
        con.register("kdf", kdf)
        con.execute(f"COPY kdf TO '{posix(COEF / 'k.parquet')}' (FORMAT parquet)")
        rdf = pd.DataFrame({"key": fit.cells, "r": fit.r}).merge(
            pd.DataFrame({"key": bfit.cells, "rb": bfit.r}), on="key", how="outer").fillna(1.0)
        rdf["l0"] = (rdf.key // 2).astype("uint32")
        rdf["dn"] = (rdf.key % 2).astype("uint8")
        rdf = rdf[["l0", "dn", "r", "rb"]]
        con.register("rdf", rdf)
        con.execute(f"COPY (SELECT * FROM rdf ORDER BY l0, dn) TO '{posix(COEF / 'r.parquet')}' (FORMAT parquet)")
        sp = pd.DataFrame([(s, dn, fit.relvar[s, dn], fit.alpha[s, dn], bfit.relvar[s, dn])
                           for s in range(nS) for dn in (0, 1)],
                          columns=["s", "dn", "relvar", "alpha", "relvar_bridge"])
        con.register("sp", sp)
        con.execute(f"COPY sp TO '{posix(COEF / 'strata_params.parquet')}' (FORMAT parquet)")
        calib = {"tau": None if math.isinf(fit.tau) else fit.tau, "tau_rmse_1deg": fit.tau_rmse,
                 "tau_bridge": None if math.isinf(bfit.tau) else bfit.tau, "tau_bridge_rmse_1deg": bfit.tau_rmse,
                 "ci_scale": ci_scale, "interval_coverage_loyo_1deg": cover,
                 "m_first": 10, "m_last": m_last, "aqua_start_m": aqua_m, "viirs_start_m": viirs_start_m,
                 "fit_window_m": [fit0, fit1], "bridge_window_m": [b0, b1],
                 "default_switch_m": ym_index(DEFAULT_SWITCH), "regional": is_regional()}
        write_json(CALIB_JSON, calib)

    with timed("calibrate validation"):
        validation = build_validation(con, strata, biome, biome_codes, nS, nB, A, F, fit, bfit, calib)
        write_json(VALIDATION, r3(validation))
    print(f"[calibrate] total {__import__('time').time() - t_all:.1f}s")


def build_validation(con, strata, biome, biome_codes, nS, nB, A: Rows, F: Rows, fit: Fit, bfit: Fit,
                     calib: dict) -> dict:
    bname = dict(zip(strata.biome, strata.biome_name))
    m_last, switch = calib["m_last"], calib["default_switch_m"]
    b_row = biome_codes[biome[F.s]]

    def scale_frames(R: Rows, pred, brow):
        st = pd.DataFrame({"unit": R.s, "b": brow, "m": R.m, "pred": pred, "obs": R.num}) \
            .groupby(["unit", "b", "m"], as_index=False)[["pred", "obs"]].sum()
        c1 = pd.DataFrame({"unit": R.c1 * 100 + brow, "c1": R.c1, "b": brow, "m": R.m, "pred": pred,
                           "obs": R.num}).groupby(["unit", "c1", "b", "m"], as_index=False)[["pred", "obs"]].sum()
        c1all = c1.groupby(["c1", "m"], as_index=False)[["pred", "obs"]].sum().rename(columns={"c1": "unit"})
        out = {}
        for name, df_all, df_b in (("stratum_month", st.groupby(["unit", "m"], as_index=False)[["pred", "obs"]].sum(), st),
                                   ("cell1deg_month", c1all, c1)):
            for df in (df_all, df_b):
                df["yr"], df["moy"] = 2000 + df.m // 12, df.m % 12
            out[name] = {"overall": unit_metrics(df_all),
                         "by_biome": {str(int(b)): unit_metrics(g) for b, g in df_b.groupby("b")}}
        return out

    loyo = scale_frames(F, fit.pred_loyo, b_row)
    # naive contrast: one global VIIRS->MODIS ratio (LOYO), no strata / season / day-night / cells
    naive = np.zeros(len(F.num))
    for y in np.unique(F.yr):
        te = F.yr == y
        naive[te] = F.den[te] * F.num[~te].sum() / F.den[~te].sum()
    loyo_naive = scale_frames(F, naive, b_row)

    # out-of-time: final coefficients on years after the fit window
    oot = A.sel(A.m > calib["fit_window_m"][1])
    cells_idx = pd.Index(fit.cells)
    ci = cells_idx.get_indexer(oot.l0.astype(np.int64) * 2 + oot.dn)
    r_oot = np.where(ci >= 0, fit.r[np.maximum(ci, 0)], 1.0)
    p_oot = fit.k.reshape(-1)[oot.key] * r_oot * oot.den
    oot_by_year = []
    for y in np.unique(oot.yr):
        sel = oot.yr == y
        st = pd.DataFrame({"s": oot.s[sel], "m": oot.m[sel], "p": p_oot[sel], "o": oot.num[sel]}) \
            .groupby(["s", "m"])[["p", "o"]].sum()
        lp, lo = np.log1p(st.p), np.log1p(st.o)
        oot_by_year.append({"year": int(y), "pred": float(p_oot[sel].sum()), "obs": float(oot.num[sel].sum()),
                            "bias_pct": float(100 * (p_oot[sel].sum() / max(oot.num[sel].sum(), 1e-9) - 1)),
                            "r_log1p_stratum_month": float(np.corrcoef(lp, lo)[0, 1]) if len(st) > 2 else None,
                            "months": int(len(np.unique(oot.m[sel])))})

    # Aqua-only sensitivity: k fitted against Aqua AFCD (no cell multiplier), anomaly correlation
    aq = load_rows(con, f"""SELECT c.l0, sc.stratum AS s, c.dn, c.m, c.m_a / am.f_aqua AS num,
            (c.ws + nf.c20 * c.w20 + nf.c21 * c.w21) / am.cov_viirs AS den
        FROM read_parquet('{posix(CUBE)}') c JOIN read_parquet('{posix(OUT_CELLS)}') sc USING (l0)
        JOIN read_parquet('{posix(AVAIL_M)}') am USING (m)
        JOIN read_parquet('{posix(COEF / 'noaa.parquet')}') nf ON nf.s = sc.stratum AND nf.dn = c.dn
        WHERE c.m BETWEEN {calib['viirs_start_m']} AND {m_last} AND am.cov_viirs >= {COV_MIN} AND am.f_aqua >= {COV_MIN}""")
    AQ = Rows(aq["l0"], aq["s"], aq["dn"], aq["m"], aq["num"], aq["den"])
    fa = (AQ.m >= calib["fit_window_m"][0]) & (AQ.m <= calib["fit_window_m"][1])
    nK = nS * 24
    ka, _ = fit_k(np.bincount(AQ.key[fa], AQ.num[fa], minlength=nK).reshape(nS, 2, 12),
                  np.bincount(AQ.key[fa], AQ.den[fa], minlength=nK).reshape(nS, 2, 12), biome, nB)
    ci = cells_idx.get_indexer(AQ.l0.astype(np.int64) * 2 + AQ.dn)
    r_aq = np.where(ci >= 0, fit.r[np.maximum(ci, 0)], 1.0)
    sm = pd.DataFrame({"s": AQ.s, "m": AQ.m, "main": fit.k.reshape(-1)[AQ.key] * r_aq * AQ.den,
                       "aqua": ka.reshape(-1)[AQ.key] * AQ.den}).groupby(["s", "m"], as_index=False)[["main", "aqua"]].sum()
    sm = sm[(sm.main > 0) & (sm.aqua > 0)].copy()
    sm["moy"] = sm.m % 12
    for col in ("main", "aqua"):
        lg = np.log(sm[col])
        sm[col + "_anom"] = lg - lg.groupby([sm.s, sm.moy]).transform("mean")
    aqua_sens = {"anomaly_corr_stratum_month": float(np.corrcoef(sm.main_anom, sm.aqua_anom)[0, 1]),
                 "aqua_to_main_ratio": float(sm.aqua.sum() / sm.main.sum()),
                 "by_biome": {}}
    sm["b"] = biome_codes[biome[sm.s.to_numpy()]]
    for b, g in sm.groupby("b"):
        if len(g) > 10:
            aqua_sens["by_biome"][str(int(b))] = float(np.corrcoef(g.main_anom, g.aqua_anom)[0, 1])

    # log-log slope beta per biome at 1 deg cell-month in the fit window (diagnostic)
    c1f = pd.DataFrame({"c1": F.c1, "b": b_row, "m": F.m, "M": F.num, "V": F.den}) \
        .groupby(["c1", "b", "m"], as_index=False)[["M", "V"]].sum()
    c1f = c1f[(c1f.M > 0) & (c1f.V > 0)]
    beta = {str(int(b)): {"beta": float(np.polyfit(np.log(g.V), np.log(g.M), 1)[0]), "n": int(len(g))}
            for b, g in c1f.groupby("b") if len(g) > 20}

    # yearly ratios and change-point tests on the harmonized vs naive series (tiles' own formulas)
    yearly = con.execute(f"""SELECT m, sum(meq) meq, sum(v) v, sum(kv) kv, sum(nmod) nmod, sum(nvii) nvii
                             FROM ({l0_values_sql()}) GROUP BY m ORDER BY m""").df().set_index("m")
    yearly = yearly.reindex(range(calib["m_first"], m_last + 1), fill_value=0)
    yr = 2000 + yearly.index // 12
    ys = yearly.groupby(yr).sum()
    by_year = [{"year": int(y), "nmod": int(r.nmod), "nvii": int(r.nvii),
                "count_ratio": float(r.nvii / r.nmod) if r.nmod else None,
                "afcd_ratio_raw": float(r.v / r.meq) if r.meq and r.v else None,
                "harmonized_ratio": float(r.kv / r.meq) if r.meq and r.kv else None}
               for y, r in ys.iterrows() if y >= 2012]

    def deseason_test(series: pd.Series, lo: int, hi: int):
        x = series.loc[lo:hi]
        lg = np.log(np.maximum(x.to_numpy(float), 1.0))
        moy = x.index.to_numpy() % 12
        clim = pd.Series(lg).groupby(moy).transform("mean").to_numpy()
        t, K, p = pettitt(lg - clim)
        cm = int(x.index[t + 1])
        return {"change_m": cm, "change_month": f"{2000 + cm // 12}-{cm % 12 + 1:02d}", "K": K, "p": p,
                "step_log": float(np.mean((lg - clim)[t + 1:]) - np.mean((lg - clim)[:t + 1]))}

    lo, hi = switch - 36, min(switch + 35, m_last)
    harm = pd.Series(np.where(yearly.index < switch, yearly.meq, yearly.kv), index=yearly.index)
    naive_s = pd.Series(np.where(yearly.index < switch, yearly.nmod, yearly.nvii), index=yearly.index)
    v0 = calib["viirs_start_m"]
    harm12 = pd.Series(np.where(yearly.index < v0, yearly.meq, yearly.kv), index=yearly.index)
    naive12 = pd.Series(np.where(yearly.index < v0, yearly.nmod, yearly.nvii), index=yearly.index)
    pett = {"window_m": [lo, hi], "switch_m": switch,
            "harmonized": deseason_test(harm, lo, hi), "naive": deseason_test(naive_s, lo, hi),
            "at_viirs_start": {"window_m": [v0 - 36, v0 + 35],
                               "harmonized": deseason_test(harm12, v0 - 36, v0 + 35),
                               "naive": deseason_test(naive12, v0 - 36, v0 + 35)}}

    # k summary by biome x dn (V-weighted over strata and months of year)
    Td = np.bincount(F.key, F.den, minlength=nS * 24).reshape(nS, 2, 12)
    k_biome = {}
    for bi, b in enumerate(biome_codes):
        w = Td[biome == bi]
        kk = fit.k[biome == bi]
        k_biome[str(int(b))] = {"name": bname.get(b, "Unclassified"),
                                "k_day": float((kk[:, 0] * w[:, 0]).sum() / max(w[:, 0].sum(), 1e-9)),
                                "k_night": float((kk[:, 1] * w[:, 1]).sum() / max(w[:, 1].sum(), 1e-9))}
    noaa = con.execute(f"SELECT * FROM '{posix(COEF / 'noaa.parquet')}' ORDER BY s, dn").df()
    lvl_share = {lv: float((fit.level == i).mean()) for i, lv in enumerate(LEVELS)}
    return {
        "version": 1,
        "scope": "regional" if calib["regional"] else "global",
        "fit_window_m": calib["fit_window_m"], "loyo_years": [2012, 2021],
        "params": {"tau": calib["tau"], "tau_rmse_1deg": calib["tau_rmse_1deg"],
                   "tau_bridge": calib["tau_bridge"], "ci_scale": calib["ci_scale"],
                   "k_level_share": lvl_share},
        "biomes": {str(int(b)): bname.get(b, "Unclassified") for b in biome_codes},
        "loyo": loyo,
        "loyo_naive_global_ratio": loyo_naive,
        "interval_coverage_loyo_1deg": calib["interval_coverage_loyo_1deg"],
        "ratio_by_year": by_year,
        "out_of_time": {"note": "Calibrated VIIRS (frozen 2012-2021 fit) vs observed MODIS. Terra and Aqua "
                                "orbits drift after ~2021 (later/earlier overpass times change the "
                                "fire-diurnal sampling), so part of any bias is MODIS drift, not calibration.",
                        "by_year": oot_by_year},
        "pettitt": pett,
        "aqua_only_sensitivity": aqua_sens,
        "beta_loglog_1deg": beta,
        "k_by_biome": k_biome,
        "noaa_scale": [{"s": int(r.s), "dn": int(r.dn), "c20": float(r.c20), "c21": float(r.c21),
                        "level20": r.level20, "level21": r.level21} for r in noaa.itertuples()],
    }
