# `ml/` (v1) — ML challenger, written by `pipeline/harmony_pipeline/ml_challenger.py`

An independent check on the production ratio calibration: a small MLP trained in the pipeline,
exported to ONNX and run in the browser (Method lab panel, `web/src/lib/ml/`). It never feeds the
served record. Run with `uv run python -m harmony_pipeline.cli ml [--force]` (not part of `all`).
Inputs come from a one-off snapshot `data/work/ml/snap/` (delete it to re-snapshot `data/work`).

```
data/dist/ml/model.onnx   opset 17; inputs x float32 [N, 28], v float32 [N, 1]; outputs mu, logk [N, 1]
data/dist/ml/model.json   feature spec, training, evaluation table, out-of-time, parity, verdict
data/work/ml/             snapshot, train_log.txt, metrics.json (incl. by-biome detail)
```

## Model
`mu = v · exp(clip(f(x), −8, 4))`, f = MLP 28→64→64→32→1 (ReLU, 8,129 parameters), Poisson-deviance
loss on L0 cell × month × day|night rows with `v > 0`, then one global **mass-balance** scalar
(Σ MODIS / Σ mu over all eligible training rows, incl. `v = 0`, folded into the output bias): about
8–10 % of MODIS cell-days sit in cell-months without VIIRS (MODIS's coarse footprint), which the
ratio of sums absorbs and a row-level `v · exp(f)` model cannot. Standardisation is inside the graph.

## Features (order is the ONNX column order; `web/src/lib/ml/features.ts` mirrors it)
| # | name | formula (from tile columns + `meta.json`) |
|---|---|---|
| 0 | `log1p_v` | ln(1 + v), v = tile `v` / 100 |
| 1 | `log_det_per_cd` | ln(1 + nvii / n_sats) − ln(1 + v); n_sats = popcount(`meta.months.viirs_sats[m]`), ≥ 1 |
| 2 | `dn` | 0 day, 1 night |
| 3–4 | `sin_moy`, `cos_moy` | sin/cos(2π (m mod 12 + 0.5) / 12) |
| 5 | `lat` | ((⌊cell / 7200⌋ + 0.5) · 0.05 − 90) / 90 |
| 6–19 | `biome_1` … `biome_14` | one-hot of `meta.strata[stratum].biome` (0 = unclassified → all zero) |
| 20–27 | `realm_AT` … `realm_PA` | one-hot of `meta.strata[stratum].realm` (AT AN AA IM NA NT OC PA) |

## `model.json`
`evaluation.table[method][scale]` with `scale ∈ {cell1deg_month, stratum_month}` holds
`{n, r_log1p, log_rmse, bias_pct, slope}` (definitions as in `validation.md`), methods:
`naive` (one global ratio), `ratio_k` (stratum × dn × month-of-year ratio), `ratio_kr` (production:
`ratio_k` × per-cell EB multiplier, production τ), `challenger_raw` (before mass balance),
`challenger`, `challenger_r` (challenger × the same EB multiplier). Protocol: all fitted on
2012-02…2018-12, scored on 2019-01…2021-12 (fixed temporal split, not LOYO). `evaluation.detail`
adds `by_biome`. `out_of_time.by_year[method]` = `{year, pred, obs, bias_pct, r_log1p_stratum_month}`
for models fitted on 2012-02…2021-12 (production = the served k × r) applied to 2022–2025.
`parity` = ONNX Runtime vs the training forward pass on 100 k held-out rows. `verdict` is generated
from the table.
