"""ML challenger: a small neural calibration model, an independent check on the ratio method.

Question answered: "would machine learning do better than the transparent ratio calibration?"

Model (one per training window): mu = v * exp(f(x)), a learned, smooth VIIRS -> MODIS factor.
- Unit: L0 cell x month x day|night. Target: MODIS Terra+Aqua AFCD, coverage-corrected (the
  tiles' `meq`). Offset: uncalibrated VIIRS AFCD `v` exactly as served in the tiles (x100 rounded).
- Why this form: multiplicative like the production k, zero VIIRS -> zero prediction, sums over
  cells and months sensibly; with a Poisson loss the production ratio-of-sums is the special case
  f = log k[stratum, dn, month-of-year], so any gain comes from the extra smooth inputs alone.
- Features (all rebuildable in the browser from tile columns + meta.json, see FEATURES):
  log1p(v); log1p(nvii / n_viirs_sats) - log1p(v) (detections per cell-day, a fire-size proxy);
  dn; sin/cos month-of-year; latitude/90; biome one-hot (14); realm one-hot (8).
- Network: 28 -> 64 -> 64 -> 32 -> 1, ReLU, output clipped to [CLIP_LO, CLIP_HI]; standardisation is
  baked into the ONNX graph. Hand-written numpy (forward + backprop + Adam, gradient-checked) so the
  pipeline needs no deep-learning framework; onnx/onnxruntime only for export and parity.
- Loss: Poisson deviance (the quasi-Poisson likelihood the ratio method maximises), on rows with
  v > 0 (others have mu = 0). Then one global mass-balance scalar (see mass_balance) so the model
  also accounts for MODIS cell-days in cell-months without VIIRS, as the ratio of sums does.

Evaluation (same metrics as validation.json, fixed temporal split instead of LOYO):
  train 2012-02..2018-12, test 2019..2021, for the challenger, the production ratio method re-fitted
  on the train window (k only, and k x per-cell EB multiplier with the production tau), the
  challenger x the same EB multiplier, and the naive single global ratio. Metrics at 1 deg
  cell-month and stratum-month (r of log1p, log-RMSE, % bias; overall and by biome). Out of time
  (2022..2025): models fitted on the full production window 2012-02..2021-12 (production = the
  actual k x r coefficients) vs observed MODIS, bias by year. The shipped model is the full-window
  challenger.

Inputs: a snapshot taken once into data/work/ml/snap (data/work is rewritten by later runs; delete
the snapshot to refresh it). Outputs: data/dist/ml/model.onnx, data/dist/ml/model.json,
data/work/ml/{train_log.txt, metrics.json}.
"""
from __future__ import annotations

import json
import math
import shutil
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .calibrate import cf, cf_union, fit_k, unit_metrics, r3
from .common import posix, write_json
from .config import COV_MIN, DIST, FIT_END, FIT_START, L0_NX, WORK, month_index, ym_index

ML_WORK = WORK / "ml"
SNAP = ML_WORK / "snap"
ROWS = SNAP / "rows.parquet"
OUT = DIST / "ml"
SNAP_M = (ym_index(FIT_START), month_index(2025, 12))
TRAIN_M = (ym_index(FIT_START), month_index(2018, 12))
TEST_M = (month_index(2019, 1), ym_index(FIT_END))
FULL_M = (ym_index(FIT_START), ym_index(FIT_END))
OOT_M = (month_index(2022, 1), month_index(2025, 12))

BIOMES = list(range(1, 15))                        # RESOLVE biome numbers; 0 (unclassified) -> all zero
REALMS = ["AT", "AN", "AA", "IM", "NA", "NT", "OC", "PA"]  # meta.strata[].realm; "" -> all zero
CONT = ["log1p_v", "log_det_per_cd", "dn", "sin_moy", "cos_moy", "lat"]
FEATURES = CONT + [f"biome_{b}" for b in BIOMES] + [f"realm_{r}" for r in REALMS]
F = len(FEATURES)
HIDDEN = (64, 64, 32)
CLIP_LO, CLIP_HI = -8.0, 4.0
SEED = 20261115
N_SAMPLE = 4_000_000
BATCH = 4096
EPOCHS = 8
LR = 2e-3
L2 = 1e-6
OPSET = 17


# ------------------------------------------------------------------------------------------
# data

def snapshot() -> None:
    """One query: the fit window + out-of-time months with stratum, coverage, NOAA factors and the
    production k, r. Coefficient files are copied alongside for provenance."""
    import duckdb
    SNAP.mkdir(parents=True, exist_ok=True)
    for f in ["strata.parquet", "availability_monthly.parquet", "coefficients/k.parquet",
              "coefficients/noaa.parquet", "coefficients/calib.json", "coefficients/strata_params.parquet"]:
        shutil.copy2(WORK / f, SNAP / f.split("/")[-1])
    W = posix(WORK)
    share = json.loads((SNAP / "calib.json").read_text())["modis_union_share"]
    con = duckdb.connect()
    (ML_WORK / "tmp").mkdir(parents=True, exist_ok=True)
    con.execute(f"SET memory_limit='10GB'; SET threads=8; SET preserve_insertion_order=false; "
                f"SET temp_directory='{posix(ML_WORK / 'tmp')}'")
    con.execute(f"""COPY (
      SELECT c.l0, sc.stratum::USMALLINT AS s, c.m, c.dn, c.m_ta, c.m_a, c.ws, c.w20, c.w21, c.nmod, c.nvii,
             am.cov_modis, am.cov_viirs, am.f_aqua, nf.c20, nf.c21,
             (c.ws + nf.c20 * c.w20 + nf.c21 * c.w21) * {cf('am.cov_viirs')} AS v,
             c.m_ta * {cf_union('c.dn', 'am.f_terra', 'am.f_aqua', 'am.cov_modis', share)} AS meq, kc.k, coalesce(rc.r, 1.0) AS r
      FROM read_parquet('{W}/cube.parquet') c JOIN read_parquet('{W}/strata_cells.parquet') sc USING (l0)
      JOIN read_parquet('{W}/availability_monthly.parquet') am USING (m)
      JOIN read_parquet('{W}/coefficients/noaa.parquet') nf ON nf.s = sc.stratum AND nf.dn = c.dn
      JOIN read_parquet('{W}/coefficients/k.parquet') kc ON kc.s = sc.stratum AND kc.dn = c.dn AND kc.moy = c.m % 12
      LEFT JOIN read_parquet('{W}/coefficients/r.parquet') rc ON rc.l0 = c.l0 AND rc.dn = c.dn
      WHERE c.m BETWEEN {SNAP_M[0]} AND {SNAP_M[1]} ORDER BY c.m, c.l0, c.dn
    ) TO '{posix(ROWS)}' (FORMAT parquet, COMPRESSION zstd)""")


def load_rows() -> dict:
    """Eligible rows (same month filter as calibrate.py: MODIS, VIIRS and Aqua coverage >= COV_MIN).
    v and meq are rounded exactly as the tiles store them (x100 integers)."""
    import duckdb
    con = duckdb.connect()
    con.execute("SET memory_limit='10GB'; SET threads=8")
    d = con.execute(f"""SELECT l0::UINTEGER l0, s::USMALLINT s, m::USMALLINT m, dn::UTINYINT dn,
            (round(meq * 100)::UINTEGER / 100.0)::DOUBLE AS obs, (round(v * 100)::UINTEGER / 100.0)::DOUBLE AS vv,
            nvii::UINTEGER nvii, k::FLOAT k, r::FLOAT r
        FROM read_parquet('{posix(ROWS)}')
        WHERE cov_modis >= {COV_MIN} AND cov_viirs >= {COV_MIN} AND f_aqua >= {COV_MIN}""").fetchnumpy()
    d = {k: np.asarray(v) for k, v in d.items()}
    d["M"], d["V"] = d.pop("obs"), d.pop("vv")
    am = con.execute(f"SELECT m, viirs_sats FROM '{posix(SNAP / 'availability_monthly.parquet')}' ORDER BY m").df()
    nsat = np.ones(400, np.float64)
    nsat[am.m.to_numpy()] = [max(1, bin(int(x)).count("1")) for x in am.viirs_sats]
    d["nsat_by_m"] = nsat
    st = con.execute(f"SELECT id, biome, realm FROM '{posix(SNAP / 'strata.parquet')}' ORDER BY id").df()
    d["strata"] = st
    return d


def features(l0, s, m, dn, V, nvii, nsat_by_m, st_biome, st_realm) -> np.ndarray:
    """Raw (unstandardised) feature matrix, float32 [N, F]. Mirrors web/src/lib/ml/features.ts."""
    n = len(l0)
    x = np.zeros((n, F), np.float32)
    lv = np.log1p(V)
    x[:, 0] = lv
    x[:, 1] = np.log1p(nvii / nsat_by_m[m]) - lv
    x[:, 2] = dn
    ang = 2 * np.pi * ((m % 12) + 0.5) / 12
    x[:, 3] = np.sin(ang)
    x[:, 4] = np.cos(ang)
    x[:, 5] = (((l0 // L0_NX) + 0.5) * 0.05 - 90) / 90
    b = st_biome[s]
    for j, code in enumerate(BIOMES):
        x[:, len(CONT) + j] = b == code
    rl = st_realm[s]
    for j in range(len(REALMS)):
        x[:, len(CONT) + len(BIOMES) + j] = rl == j
    return x


# ------------------------------------------------------------------------------------------
# network

def init_params(rng, mean_logk: float) -> list[np.ndarray]:
    sizes = [F, *HIDDEN, 1]
    p = []
    for a, b in zip(sizes[:-1], sizes[1:]):
        p.append((rng.standard_normal((a, b)) * math.sqrt(2.0 / a)).astype(np.float64))
        p.append(np.zeros(b))
    p[-2] *= 0.1
    p[-1][:] = mean_logk
    return p


def forward(p, xs, keep=False):
    h, acts = xs, []
    nl = len(p) // 2
    for i in range(nl):
        z = h @ p[2 * i] + p[2 * i + 1]
        if i < nl - 1:
            acts.append((h, z))
            h = np.maximum(z, 0)
        else:
            acts.append((h, z))
            f = z[:, 0]
    fc = np.clip(f, CLIP_LO, CLIP_HI)
    return (fc, f, acts) if keep else fc


def loss_grad(p, xs, logv, y):
    """Mean Poisson deviance (up to constants) and gradients for mu = exp(logv + f)."""
    fc, f, acts = forward(p, xs, keep=True)
    eta = logv + fc
    mu = np.exp(eta)
    n = len(y)
    loss = float(np.mean(mu - y * eta))
    g = ((mu - y) / n) * ((f > CLIP_LO) & (f < CLIP_HI))
    grads = [None] * len(p)
    delta = g[:, None]
    for i in range(len(p) // 2 - 1, -1, -1):
        h, z = acts[i]
        if i < len(p) // 2 - 1:
            delta = delta * (z > 0)
        grads[2 * i] = h.T @ delta
        grads[2 * i + 1] = delta.sum(0)
        if i > 0:
            delta = delta @ p[2 * i].T
    return loss, grads


def gradcheck(rng) -> float:
    """Finite-difference check of the hand-written backprop on a tiny random problem."""
    p = init_params(rng, -1.0)
    p = [q + 0.05 * rng.standard_normal(q.shape) for q in p]
    xs = rng.standard_normal((64, F))
    logv = rng.standard_normal(64)
    y = rng.poisson(2.0, 64).astype(float)
    _, g = loss_grad(p, xs, logv, y)
    worst = 0.0
    for pi in (0, 3, 6, 7):
        for _ in range(5):
            idx = tuple(rng.integers(0, s) for s in p[pi].shape)
            old = p[pi][idx]
            p[pi][idx] = old + 1e-6
            lp, _ = loss_grad(p, xs, logv, y)
            p[pi][idx] = old - 1e-6
            lm, _ = loss_grad(p, xs, logv, y)
            p[pi][idx] = old
            num = (lp - lm) / 2e-6
            worst = max(worst, abs(num - g[pi][idx]) / max(1e-8, abs(num) + abs(g[pi][idx])))
    return worst


def standardiser(x: np.ndarray):
    mean = np.zeros(F)
    scale = np.ones(F)
    for j in (0, 1, 5):       # continuous; dn, sin/cos and one-hots are already O(1)
        mean[j] = float(x[:, j].mean())
        scale[j] = 1.0 / max(float(x[:, j].std()), 1e-6)
    return mean, scale


def train(D: dict, window, log, tag: str):
    """Train on a uniform sample of rows with v > 0 in `window`; 5 % in-time holdout picks the epoch."""
    rng = np.random.default_rng(SEED)
    sel = np.flatnonzero((D["m"] >= window[0]) & (D["m"] <= window[1]) & (D["V"] > 0))
    idx = np.sort(rng.choice(sel, size=min(N_SAMPLE, len(sel)), replace=False))
    x = feats_rows(D, idx)
    y, V = D["M"][idx], D["V"][idx]
    mean, scale = standardiser(x)
    xs = ((x - mean) * scale).astype(np.float32)
    logv = np.log(V)
    perm = rng.permutation(len(idx))
    nh = len(idx) // 20
    ho, tr = perm[:nh], perm[nh:]
    p = init_params(rng, math.log(y[tr].sum() / V[tr].sum()))
    m_ = [np.zeros_like(q) for q in p]
    v_ = [np.zeros_like(q) for q in p]
    steps_per_epoch = len(tr) // BATCH
    total = steps_per_epoch * EPOCHS
    best = (np.inf, None, -1)
    t, t0 = 0, time.time()
    hist = []
    for ep in range(EPOCHS):
        order = rng.permutation(tr)
        run = 0.0
        for b in range(steps_per_epoch):
            bi = order[b * BATCH:(b + 1) * BATCH]
            loss, g = loss_grad(p, xs[bi], logv[bi], y[bi])
            run += loss
            t += 1
            lr = LR * 0.5 * (1 + math.cos(math.pi * t / total))
            for i in range(len(p)):
                gi = g[i] + (L2 * p[i] if i % 2 == 0 else 0)
                m_[i] = 0.9 * m_[i] + 0.1 * gi
                v_[i] = 0.999 * v_[i] + 0.001 * gi * gi
                p[i] -= lr * (m_[i] / (1 - 0.9 ** t)) / (np.sqrt(v_[i] / (1 - 0.999 ** t)) + 1e-8)
        fh = forward(p, xs[ho])
        eta = logv[ho] + fh
        yh = y[ho]
        dev = 2 * np.sum(np.where(yh > 0, yh * np.log(np.maximum(yh, 1e-12) / np.exp(eta)), 0) - (yh - np.exp(eta)))
        null_eta = logv[ho] + math.log(y[tr].sum() / V[tr].sum())
        dev0 = 2 * np.sum(np.where(yh > 0, yh * np.log(np.maximum(yh, 1e-12) / np.exp(null_eta)), 0) - (yh - np.exp(null_eta)))
        hist.append({"epoch": ep + 1, "train_loss": run / steps_per_epoch, "holdout_deviance": float(dev),
                     "holdout_dev_explained_vs_global_ratio": float(1 - dev / dev0)})
        log(f"  [{tag}] epoch {ep + 1}/{EPOCHS} train {run / steps_per_epoch:.4f} holdout deviance {dev:,.0f} "
            f"(D2 vs global ratio {1 - dev / dev0:.4f}) {time.time() - t0:.0f}s")
        if dev < best[0]:
            best = (dev, [q.copy() for q in p], ep + 1)
    return {"params": best[1], "mean": mean, "scale": scale, "best_epoch": best[2], "history": hist,
            "n_rows": int(len(idx)), "n_eligible_v_pos": int(len(sel)), "window_m": list(window)}


def feats_rows(D, idx):
    return features(D["l0"][idx], D["s"][idx], D["m"][idx], D["dn"][idx], D["V"][idx], D["nvii"][idx],
                    D["nsat_by_m"], D["st_biome"], D["st_realm"])


def mass_balance(model, D, idx) -> float:
    """Training rows with v = 0 cannot enter a model of the form v * exp(f) (their prediction is 0),
    yet ~8 % of MODIS cell-days fall in L0 cell-months where VIIRS saw nothing (mostly MODIS's coarse
    footprint spilling into a neighbouring cell). The ratio method absorbs them because sum M / sum V
    runs over all rows. One global scalar restores the same constraint on the training window:
    sum mu = sum M over all eligible rows. Folded into the output bias, so it ships inside the ONNX."""
    f = float(D["M"][idx].sum() / predict(model, D, idx).sum())
    model["params"][-1] = model["params"][-1] + math.log(f)
    model["mass_balance"] = f
    return f


def predict(model, D, idx, chunk=1_000_000) -> np.ndarray:
    out = np.zeros(len(idx))
    for a in range(0, len(idx), chunk):
        ii = idx[a:a + chunk]
        xs = (feats_rows(D, ii) - model["mean"]) * model["scale"]
        out[a:a + chunk] = D["V"][ii] * np.exp(forward(model["params"], xs))
    return out


# ------------------------------------------------------------------------------------------
# comparators and metrics

def ratio_fit(D, idx, nS, biome_idx, nB):
    """Production stratum x dn x moy ratio (calibrate.fit_k, same fallback chain) on rows idx."""
    key = (D["s"][idx].astype(np.int64) * 2 + D["dn"][idx]) * 12 + D["m"][idx] % 12
    num = np.bincount(key, D["M"][idx], minlength=nS * 24).reshape(nS, 2, 12)
    den = np.bincount(key, D["V"][idx], minlength=nS * 24).reshape(nS, 2, 12)
    k, _ = fit_k(num, den, biome_idx, nB)
    return k


def kkey(D, idx):
    return (D["s"][idx].astype(np.int64) * 2 + D["dn"][idx]) * 12 + D["m"][idx] % 12


def cell_multiplier(D, idx, base_pred, tau):
    """EB gamma-Poisson multiplier per (l0, dn), as calibrate.fit_stream: (sum M + tau) / (sum pred + tau)."""
    keys = D["l0"][idx].astype(np.int64) * 2 + D["dn"][idx]
    u, inv = np.unique(keys, return_inverse=True)
    r = (np.bincount(inv, D["M"][idx], minlength=len(u)) + tau) / (np.bincount(inv, base_pred, minlength=len(u)) + tau)
    return u, r


def apply_multiplier(D, idx, u, r):
    keys = D["l0"][idx].astype(np.int64) * 2 + D["dn"][idx]
    pos = np.searchsorted(u, keys)
    pos = np.minimum(pos, len(u) - 1)
    hit = u[pos] == keys
    return np.where(hit, r[pos], 1.0)


def scales(D, idx, pred, biome_code_of_s) -> dict:
    """validation.json-style metrics at stratum-month and 1 deg cell-month (day+night summed)."""
    l0 = D["l0"][idx].astype(np.int64)
    c1 = (l0 // L0_NX // 20) * 360 + (l0 % L0_NX) // 20
    s, m, obs = D["s"][idx], D["m"][idx].astype(np.int64), D["M"][idx]
    b = biome_code_of_s[s]
    base = pd.DataFrame({"s": s, "c1": c1, "b": b, "m": m, "pred": pred, "obs": obs})
    st = base.groupby(["s", "b", "m"], as_index=False)[["pred", "obs"]].sum().rename(columns={"s": "unit"})
    c1b = base.groupby(["c1", "b", "m"], as_index=False)[["pred", "obs"]].sum()
    c1b["unit"] = c1b.c1 * 100 + c1b.b
    c1all = c1b.groupby(["c1", "m"], as_index=False)[["pred", "obs"]].sum().rename(columns={"c1": "unit"})
    stall = st.groupby(["unit", "m"], as_index=False)[["pred", "obs"]].sum()
    out = {}
    for name, df_all, df_b in (("stratum_month", stall, st), ("cell1deg_month", c1all, c1b)):
        for df in (df_all, df_b):
            df["yr"], df["moy"] = 2000 + df.m // 12, df.m % 12
        keep = ("n", "r_log1p", "log_rmse", "bias_pct", "slope")
        ov = unit_metrics(df_all)
        out[name] = {"overall": {k: v for k, v in ov.items() if k in keep},
                     "by_biome": {str(int(bb)): {k: v for k, v in unit_metrics(g).items() if k in keep}
                                  for bb, g in df_b.groupby("b")}}
    return out


def oot_by_year(D, idx, pred) -> list:
    y = 2000 + D["m"][idx] // 12
    out = []
    for yr in np.unique(y):
        sel = y == yr
        st = pd.DataFrame({"s": D["s"][idx][sel], "m": D["m"][idx][sel], "p": pred[sel], "o": D["M"][idx][sel]}) \
            .groupby(["s", "m"])[["p", "o"]].sum()
        out.append({"year": int(yr), "pred": float(pred[sel].sum()), "obs": float(D["M"][idx][sel].sum()),
                    "bias_pct": float(100 * (pred[sel].sum() / max(D["M"][idx][sel].sum(), 1e-9) - 1)),
                    "r_log1p_stratum_month": float(np.corrcoef(np.log1p(st.p), np.log1p(st.o))[0, 1])})
    return out


# ------------------------------------------------------------------------------------------
# ONNX

def export_onnx(model, path) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    p = model["params"]
    inits = [numpy_helper.from_array(model["mean"].astype(np.float32)[None, :], "x_mean"),
             numpy_helper.from_array(model["scale"].astype(np.float32)[None, :], "x_scale"),
             numpy_helper.from_array(np.array(CLIP_LO, np.float32), "clip_lo"),
             numpy_helper.from_array(np.array(CLIP_HI, np.float32), "clip_hi")]
    nodes = [helper.make_node("Sub", ["x", "x_mean"], ["xc"]), helper.make_node("Mul", ["xc", "x_scale"], ["h0"])]
    nl = len(p) // 2
    for i in range(nl):
        inits += [numpy_helper.from_array(p[2 * i].astype(np.float32), f"W{i + 1}"),
                  numpy_helper.from_array(p[2 * i + 1].astype(np.float32), f"b{i + 1}")]
        nodes += [helper.make_node("MatMul", [f"h{i}", f"W{i + 1}"], [f"z{i + 1}m"]),
                  helper.make_node("Add", [f"z{i + 1}m", f"b{i + 1}"], [f"z{i + 1}"])]
        if i < nl - 1:
            nodes.append(helper.make_node("Relu", [f"z{i + 1}"], [f"h{i + 1}"]))
    nodes += [helper.make_node("Clip", [f"z{nl}", "clip_lo", "clip_hi"], ["logk"]),
              helper.make_node("Exp", ["logk"], ["k"]),
              helper.make_node("Mul", ["v", "k"], ["mu"])]
    graph = helper.make_graph(
        nodes, "harmony_ml_challenger",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, ["N", F]),
         helper.make_tensor_value_info("v", TensorProto.FLOAT, ["N", 1])],
        [helper.make_tensor_value_info("mu", TensorProto.FLOAT, ["N", 1]),
         helper.make_tensor_value_info("logk", TensorProto.FLOAT, ["N", 1])],
        inits)
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid("", OPSET)], producer_name="harmony")
    m.ir_version = 8
    onnx.checker.check_model(m)
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(m, str(path))


def parity(model, path, D, idx) -> dict:
    """onnxruntime vs the numpy forward pass (float32) on a held-out batch."""
    import onnxruntime as ort
    x = feats_rows(D, idx)
    V = D["V"][idx].astype(np.float32)
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    mu_onnx = sess.run(["mu"], {"x": x, "v": V[:, None]})[0][:, 0].astype(np.float64)
    p32 = [q.astype(np.float32) for q in model["params"]]
    xs = (x - model["mean"].astype(np.float32)) * model["scale"].astype(np.float32)
    mu_np = V * np.exp(forward(p32, xs)).astype(np.float32)
    mu_np64 = D["V"][idx] * np.exp(forward(model["params"], (x.astype(np.float64) - model["mean"]) * model["scale"]))
    rel = np.abs(mu_onnx - mu_np) / np.maximum(np.abs(mu_np), 1e-6)
    rel64 = np.abs(mu_onnx - mu_np64) / np.maximum(np.abs(mu_np64), 1e-6)
    return {"n": int(len(idx)), "max_rel_diff_vs_float32": float(rel.max()),
            "max_rel_diff_vs_float64_training": float(rel64.max()),
            "sum_onnx": float(mu_onnx.sum()), "sum_numpy": float(mu_np64.sum())}


# ------------------------------------------------------------------------------------------

def verdict(tab: dict, detail: dict) -> str:
    """One sentence from the numbers: held-out log-RMSE gain at both scales, global bias, and the
    worst per-biome bias at 1 deg (biome 0 = unclassified excluded) for challenger vs production."""
    ml, pr = tab["challenger"], tab["ratio_kr"]
    g1 = 100 * (pr["cell1deg_month"]["log_rmse"] - ml["cell1deg_month"]["log_rmse"]) / pr["cell1deg_month"]["log_rmse"]
    gs = 100 * (pr["stratum_month"]["log_rmse"] - ml["stratum_month"]["log_rmse"]) / pr["stratum_month"]["log_rmse"]

    def worst(k):
        bb = detail[k]["cell1deg_month"]["by_biome"]
        return max((v.get("bias_pct", 0.0) for b, v in bb.items() if b != "0"), key=abs)

    def phrase(g, scale):
        if g >= 1:
            return f"lowers {scale} log-RMSE by {g:.0f} %"
        if g <= -1:
            return f"raises {scale} log-RMSE by {-g:.0f} %"
        return f"matches {scale} log-RMSE (within 1 %)"
    s = (f"On held-out 2019–2021 the ML challenger {phrase(g1, '1° cell-month')} and {phrase(gs, 'stratum-month')} "
         f"versus the production ratio method, at a global bias of {ml['cell1deg_month']['bias_pct']:+.1f} % vs "
         f"{pr['cell1deg_month']['bias_pct']:+.1f} %")
    wm, wp = worst("challenger"), worst("ratio_kr")
    if max(g1, gs) >= 1:
        s += (f", but its worst biome bias is {wm:+.1f} % vs {wp:+.1f} %" if abs(wm) > abs(wp) + 1 else "")
        s += ("; the simple ratio method stays in production for transparency and per-stratum mass balance, "
              "with the challenger as an independent cross-check.")
    else:
        s += "; machine learning does not beat the ratio method here, so the simple method is kept."
    return s


def main(force: bool = False) -> None:
    ML_WORK.mkdir(parents=True, exist_ok=True)
    out_onnx, out_json = OUT / "model.onnx", OUT / "model.json"
    if not force and out_json.exists() and out_onnx.exists():
        print("[ml] up to date (use --force to retrain)")
        return
    # A snapshot older than the cube or the coefficients would train on a superseded record: take a new one.
    srcs = [WORK / "cube.parquet", WORK / "coefficients" / "k.parquet", WORK / "coefficients" / "r.parquet",
            WORK / "coefficients" / "calib.json"]
    stale = ROWS.exists() and any(q.exists() and q.stat().st_mtime > ROWS.stat().st_mtime for q in srcs)
    if not ROWS.exists() or stale:
        print(f"[ml] snapshot data/work -> data/work/ml/snap{' (previous snapshot predates the cube)' if stale else ''}")
        snapshot()
    lines: list[str] = []

    def log(msg):
        print(msg, flush=True)
        lines.append(msg)
    t_all = time.time()
    rng = np.random.default_rng(SEED)
    gc = gradcheck(rng)
    log(f"[ml] gradient check: max relative error {gc:.2e}")
    assert gc < 1e-4, "backprop does not match finite differences"

    D = load_rows()
    st = D.pop("strata")
    nS = len(st)
    D["st_biome"] = st.biome.to_numpy().astype(np.int64)
    D["st_realm"] = np.array([REALMS.index(r) if r in REALMS else -1 for r in st.realm])
    biome_codes, biome_idx = np.unique(D["st_biome"], return_inverse=True)
    nB = len(biome_codes)
    log(f"[ml] {len(D['M']):,} eligible rows, {nS} strata")
    cal = json.loads((SNAP / "calib.json").read_text())
    tau = cal["tau"] if cal["tau"] is not None else math.inf

    m = D["m"]
    i_tr = np.flatnonzero((m >= TRAIN_M[0]) & (m <= TRAIN_M[1]))
    i_te = np.flatnonzero((m >= TEST_M[0]) & (m <= TEST_M[1]))
    i_full = np.flatnonzero((m >= FULL_M[0]) & (m <= FULL_M[1]))
    i_oot = np.flatnonzero((m >= OOT_M[0]) & (m <= OOT_M[1]))
    log(f"[ml] rows: train {len(i_tr):,} test {len(i_te):,} full {len(i_full):,} oot {len(i_oot):,}")

    # --- temporal split ------------------------------------------------------------------
    log("[ml] train split model (2012-02..2018-12)")
    ms = train(D, TRAIN_M, log, "split")
    preds = {}
    g = D["M"][i_tr].sum() / D["V"][i_tr].sum()
    preds["naive"] = D["V"][i_te] * g
    k_tr = ratio_fit(D, i_tr, nS, biome_idx, nB)
    base_tr = k_tr.reshape(-1)[kkey(D, i_tr)] * D["V"][i_tr]
    preds["ratio_k"] = k_tr.reshape(-1)[kkey(D, i_te)] * D["V"][i_te]
    u, r = cell_multiplier(D, i_tr, base_tr, tau)
    preds["ratio_kr"] = preds["ratio_k"] * apply_multiplier(D, i_te, u, r)
    preds["challenger_raw"] = predict(ms, D, i_te)
    fb = mass_balance(ms, D, i_tr)
    log(f"  split mass-balance factor {fb:.4f}")
    ml_tr = predict(ms, D, i_tr)
    preds["challenger"] = predict(ms, D, i_te)
    u2, r2 = cell_multiplier(D, i_tr, ml_tr, tau)
    preds["challenger_r"] = preds["challenger"] * apply_multiplier(D, i_te, u2, r2)
    metrics = {}
    for name, pr in preds.items():
        metrics[name] = scales(D, i_te, pr, D["st_biome"])
        o1, os_ = metrics[name]["cell1deg_month"]["overall"], metrics[name]["stratum_month"]["overall"]
        log(f"  {name:13s} 1deg r {o1['r_log1p']:.4f} logRMSE {o1['log_rmse']:.4f} bias {o1['bias_pct']:+.2f}% | "
            f"stratum r {os_['r_log1p']:.4f} logRMSE {os_['log_rmse']:.4f} bias {os_['bias_pct']:+.2f}%")

    # --- full window (shipped) + out of time ----------------------------------------------
    log("[ml] train shipped model (2012-02..2021-12)")
    mf = train(D, FULL_M, log, "full")
    oot_raw = oot_by_year(D, i_oot, predict(mf, D, i_oot))
    ff = mass_balance(mf, D, i_full)
    log(f"  full mass-balance factor {ff:.4f}")
    oot = {"production": oot_by_year(D, i_oot, (D["k"][i_oot] * D["r"][i_oot]).astype(float) * D["V"][i_oot]),
           "challenger": oot_by_year(D, i_oot, predict(mf, D, i_oot)),
           "challenger_raw": oot_raw,
           "naive": oot_by_year(D, i_oot, D["V"][i_oot] * D["M"][i_full].sum() / D["V"][i_full].sum())}
    for name, rows in oot.items():
        log(f"  OOT {name:11s} " + " ".join(f"{r_['year']}:{r_['bias_pct']:+.1f}%" for r_ in rows))

    OUT.mkdir(parents=True, exist_ok=True)
    export_onnx(mf, out_onnx)
    hrng = np.random.default_rng(SEED + 1)
    par = parity(mf, out_onnx, D, np.sort(hrng.choice(i_oot[D["V"][i_oot] > 0], 100_000, replace=False)))
    log(f"[ml] ONNX parity on 100k held-out rows: max rel diff {par['max_rel_diff_vs_float32']:.2e} (float32), "
        f"{par['max_rel_diff_vs_float64_training']:.2e} (vs float64 training forward)")
    n_params = int(sum(q.size for q in mf["params"]))

    table = {k: {sc: v[sc]["overall"] for sc in ("cell1deg_month", "stratum_month")} for k, v in metrics.items()}
    text = verdict(table, metrics)
    log(f"[ml] verdict: {text}")
    labels = {"naive": "Naive single global ratio", "ratio_k": "Ratio method, stratum × day|night × month (no cell multiplier)",
              "ratio_kr": "Production ratio method (k × per-cell EB multiplier)",
              "challenger_raw": "ML challenger before mass balance", "challenger": "ML challenger (MLP, mass-balanced)",
              "challenger_r": "ML challenger × per-cell EB multiplier"}
    dist_meta = json.loads((DIST / "meta.json").read_text()) if (DIST / "meta.json").exists() else {}
    model_json = {
        "version": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # which build the challenger was trained on (compare with meta.json `generated` / `data_through`)
        "trained_on_build": {
            "meta_generated": dist_meta.get("generated"), "data_through": dist_meta.get("data_through"),
            "snapshot_taken": datetime.fromtimestamp(ROWS.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "calib_m_last": cal.get("m_last"),
            "trained": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "onnx": {"file": "model.onnx", "bytes": out_onnx.stat().st_size, "opset": OPSET,
                 "inputs": {"x": f"float32 [N, {F}] raw features (standardisation is inside the graph)",
                            "v": "float32 [N, 1] uncalibrated VIIRS AFCD (tile v / 100)"},
                 "outputs": {"mu": "float32 [N, 1] MODIS-equivalent AFCD = v * exp(logk)", "logk": "float32 [N, 1]"}},
        "architecture": f"MLP {F}-{'-'.join(map(str, HIDDEN))}-1, ReLU, output clipped to [{CLIP_LO}, {CLIP_HI}]",
        "form": "mu = v · exp(f(x)): a learned, smooth VIIRS→MODIS factor (multiplicative, zero in → zero out)",
        "loss": "Poisson deviance (the likelihood the ratio method maximises)",
        "n_params": n_params,
        "features": FEATURES,
        "feature_spec": {
            "log1p_v": "ln(1 + v), v = tile v / 100 (coverage-corrected, S-NPP-equivalent per-day VIIRS AFCD)",
            "log_det_per_cd": "ln(1 + nvii / n_sats) − ln(1 + v); n_sats = popcount(meta.months.viirs_sats[m]), min 1",
            "dn": "0 day, 1 night",
            "sin_moy": "sin(2π (m mod 12 + 0.5) / 12)", "cos_moy": "cos(2π (m mod 12 + 0.5) / 12)",
            "lat": "cell-centre latitude / 90, latitude = (floor(cell / 7200) + 0.5) · 0.05 − 90",
            "biome_b": "1 if meta.strata[stratum].biome == b (b = 1..14); unclassified → all 0",
            "realm_r": "1 if meta.strata[stratum].realm == r; unclassified → all 0"},
        "biomes": BIOMES, "realms": REALMS,
        "norm": {"mean": [float(x) for x in mf["mean"]], "scale": [float(x) for x in mf["scale"]],
                 "note": "baked into the ONNX graph as (x − mean) · scale; informational"},
        "training": {"framework": "numpy (hand-written MLP + backprop + Adam, finite-difference checked), onnx export",
                     "seed": SEED, "rows_sampled": mf["n_rows"], "rows_eligible": mf["n_eligible_v_pos"],
                     "window_m": mf["window_m"], "epochs": EPOCHS, "best_epoch": mf["best_epoch"], "batch": BATCH,
                     "lr": LR, "l2": L2, "history": mf["history"], "gradcheck_max_rel_err": gc,
                     "mass_balance": mf["mass_balance"],
                     "mass_balance_note": "one global scalar, sum M / sum mu over all eligible training rows incl. v = 0 "
                                          "(the ratio method satisfies the same constraint per stratum); baked into the output bias",
                     "sampling": "uniform over eligible L0 cell × month × dn rows with v > 0 (months with MODIS, "
                                 "VIIRS and Aqua coverage ≥ 0.5, as in calibrate.py); 5 % in-time holdout picks the epoch"},
        "evaluation": {
            "protocol": "Fixed temporal split: every method fitted on 2012-02..2018-12 and scored on 2019-01..2021-12 "
                        "against observed MODIS Terra+Aqua AFCD (coverage-corrected). Same metrics as validation.json; "
                        "units summed over day and night. The production comparator is re-fitted on the train window "
                        f"with the production tau = {cal['tau']} (tau not re-selected).",
            "train_m": list(TRAIN_M), "test_m": list(TEST_M),
            "split_model": {"best_epoch": ms["best_epoch"], "rows_sampled": ms["n_rows"], "history": ms["history"],
                            "mass_balance": ms["mass_balance"]},
            "labels": labels,
            "table": table,
            "detail": metrics,
        },
        "out_of_time": {"note": "Models fitted on 2012-02..2021-12 (production = the served k × r) applied to 2022–2025 "
                                "vs still-observed MODIS. Terra/Aqua orbit drift after ~2021 means part of any bias is "
                                "MODIS drift, not calibration.", "by_year": oot},
        "parity": par,
        "verdict": text,
    }
    write_json(out_json, r3(model_json))
    write_json(ML_WORK / "metrics.json", r3({"table": table, "detail": metrics, "oot": oot, "parity": par}))
    log(f"[ml] wrote {out_onnx} ({out_onnx.stat().st_size:,} B), {out_json}; {n_params:,} parameters; "
        f"total {time.time() - t_all:.0f}s")
    (ML_WORK / "train_log.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
