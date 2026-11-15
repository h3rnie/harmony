//! Monthly zonal sums over the AOI and the harmonized series with its uncertainty band.
//!
//! Values are AOI-weighted sums `Σ w_i x_i` in AFCD units (tile values are ×100). Raw hotspot
//! counts are weighted the same way, so naive and harmonized curves describe the same area.
//!
//! Two ways to build the harmonized value (`schema/data-contract.md`, "Series formula"):
//! * **fused** (default): per stratum × day|night group, a precision-weighted combination of the
//!   MODIS-derived value (drift-corrected in the drift era) and calibrated VIIRS, with variances
//!   from the sensor error model in `meta.json`, summed over groups;
//! * **switch**: MODIS before `switchM`, calibrated VIIRS from it (the original record).
//!
//! Bounds cover every covered month: on a shifted log scale (`(H + 0.5)·exp(∓q σ) − 0.5`, so a
//! zero can be covered), `q` from the conformal table (leave-one-year-out scores).
//! A `meta.json` without the error model gives exactly the legacy record and intervals.

use serde::{Deserialize, Serialize, Serializer};

use crate::meta::{ErrModel, Meta, StratumMeta};
use crate::months::{moy, year_of};
use crate::store::Store;

pub const Z80: f64 = 1.2816;
pub const Z95: f64 = 1.96;
/// Fixed-point iterations of the pooled level used to evaluate the stream variances.
const FUSE_ITER: usize = 3;
/// Largest admissible error correlation between the two streams.
const MAX_CORR: f64 = 0.99;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dn {
    #[default]
    Both,
    Day,
    Night,
}

impl Dn {
    pub fn accepts(self, dn: u8) -> bool {
        match self {
            Dn::Both => true,
            Dn::Day => dn == 0,
            Dn::Night => dn == 1,
        }
    }
}

/// How the harmonized value is built.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Fused,
    Switch,
}

/// Unit of the MODIS-equivalent values (the lens).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    #[default]
    Modis,
    Viirs,
}

/// `SourceCode` in types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    None = 0,
    Bridge = 1,
    Modis = 2,
    Viirs = 3,
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(*self as u8)
    }
}

/// Stream serving month `m`: MODIS (Terra-bridged before Aqua) before `switch_m`, calibrated
/// VIIRS from it. Each falls back to the other when it has no coverage that month.
pub fn source_for(meta: &Meta, m: i32, switch_m: i32) -> Source {
    let modis = meta
        .modis_ok(m)
        .then_some(if m < meta.aqua_start_m { Source::Bridge } else { Source::Modis });
    let viirs = meta.viirs_ok(m).then_some(Source::Viirs);
    let (first, second) = if m < switch_m { (modis, viirs) } else { (viirs, modis) };
    first.or(second).unwrap_or(Source::None)
}

/// Bounds `H·exp(∓q σ_log)` with `σ_log = √Var / max(H, 0.5)`: `[lo80, hi80, lo95, hi95]`.
pub fn bounds_q(h: f64, var: f64, q80: f64, q95: f64) -> [f64; 4] {
    let sigma = var.max(0.0).sqrt() / h.max(0.5);
    let at = |q: f64| {
        let s = q * sigma;
        if s.is_finite() {
            [h * (-s).exp(), h * s.exp()]
        } else {
            [0.0, f64::MAX]
        }
    };
    let ([lo80, hi80], [lo95, hi95]) = (at(q80), at(q95));
    [lo80, hi80, lo95, hi95]
}

/// Offset of the shifted log used by the error-model bounds (AFCD).
pub const LOG_SHIFT: f64 = 0.5;

/// Error-model bounds on the shifted log scale, so a zero can be covered: with `c = 0.5`,
/// `σ = √Var / (H + c)`, bounds `max(0, (H + c)·exp(−q σ) − c)` and `(H + c)·exp(q σ) − c`:
/// `[lo80, hi80, lo95, hi95]`.
pub fn bounds_shifted(h: f64, var: f64, q80: f64, q95: f64) -> [f64; 4] {
    let c = LOG_SHIFT;
    let hc = h.max(0.0) + c;
    let sigma = var.max(0.0).sqrt() / hc;
    let at = |q: f64| {
        let s = q * sigma;
        if s.is_finite() {
            [(hc * (-s).exp() - c).max(0.0), (hc * s.exp() - c).max(0.0)]
        } else {
            [0.0, f64::MAX]
        }
    };
    let ([lo80, hi80], [lo95, hi95]) = (at(q80), at(q95));
    [lo80, hi80, lo95, hi95]
}

/// Legacy contract bounds (normal quantiles): `bounds_q(h, var, 1.2816, 1.96)`.
pub fn bounds(h: f64, var: f64) -> [f64; 4] {
    bounds_q(h, var, Z80, Z95)
}

/// Legacy VIIRS-derived variance:
/// `ci² · [Σ relvar·S² + Σ (S + α·Q)]` over stratum × dn groups, with `S = Σ w kv`
/// (AFCD) and `Q = Σ w² kvsq`. Items are `(relvar, alpha, S, Q)`.
pub fn viirs_variance(groups: impl IntoIterator<Item = (f64, f64, f64, f64)>, ci_scale: f64) -> f64 {
    let sum: f64 = groups
        .into_iter()
        .map(|(relvar, alpha, s, q)| relvar * s * s + s + alpha * q)
        .sum();
    ci_scale * ci_scale * sum
}

/// Legacy Terra-bridge variance: `ci² · Σ relvar_bridge·S²` with `S = Σ w meq`; no dispersion term.
pub fn bridge_variance(groups: impl IntoIterator<Item = (f64, f64)>, ci_scale: f64) -> f64 {
    let sum: f64 = groups.into_iter().map(|(relvar, s)| relvar * s * s).sum();
    ci_scale * ci_scale * sum
}

/// Variance law of one stream: `Var(μ) = rho μ² + phi μ`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct StreamVar {
    pub rho: f64,
    pub phi: f64,
}

impl StreamVar {
    pub fn var(&self, mu: f64) -> f64 {
        (self.rho * mu * mu + self.phi * mu).max(0.0)
    }

    /// `Var(μ) / μ`, finite at μ = 0.
    fn per_mu(&self, mu: f64) -> f64 {
        (self.rho * mu + self.phi).max(0.0)
    }
}

/// A fused value: estimate, variance and the weight of the MODIS stream.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fused {
    pub h: f64,
    pub var: f64,
    pub w: f64,
}

fn finite0(x: f64) -> f64 {
    if x.is_finite() {
        x.max(0.0)
    } else {
        0.0
    }
}

/// Weight of MODIS for the two-stream estimate at level μ (from `Var/μ`, so μ = 0 is the
/// `phi` limit); `c_rho μ²` is the error covariance, clamped to `MAX_CORR · √(Var_M Var_V)`.
fn weight(mu: f64, sm: StreamVar, sv: StreamVar, c_rho: f64) -> f64 {
    let (a, b) = (sm.per_mu(mu), sv.per_mu(mu));
    let c = (c_rho * mu).min(MAX_CORR * (a * b).sqrt()).max(0.0);
    let den = a + b - 2.0 * c;
    if !(den.is_finite() && den > 1e-300) {
        return 0.5;
    }
    let w = (b - c) / den;
    if w.is_finite() {
        w.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

/// Precision-weighted combination of a MODIS value `m` and a VIIRS value `v` (same unit) with
/// variance laws `sm`, `sv` and covariance `c_rho μ²`. The variances are evaluated at a common
/// level μ (start `(m + v)/2`, then `FUSE_ITER` fixed-point steps), so neither stream's own noise
/// decides its weight.
pub fn fuse(m: f64, v: f64, sm: StreamVar, sv: StreamVar, c_rho: f64) -> Fused {
    let (m, v, c_rho) = (finite0(m), finite0(v), finite0(c_rho));
    let mut mu = 0.5 * (m + v);
    let mut w = 0.5;
    for _ in 0..FUSE_ITER {
        w = weight(mu, sm, sv, c_rho);
        mu = w * m + (1.0 - w) * v;
    }
    let (a, b) = (sm.var(mu), sv.var(mu));
    let c = (c_rho * mu * mu).min(MAX_CORR * (a * b).sqrt()).max(0.0);
    let var = (w * w * a + (1.0 - w) * (1.0 - w) * b + 2.0 * w * (1.0 - w) * c).max(0.0);
    Fused { h: mu, var: if var.is_finite() { var } else { 0.0 }, w }
}

/// Streams and parameters serving one month.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    pub m: i32,
    pub use_m: bool,
    pub use_v: bool,
    /// MODIS months before Aqua use the bridge parameters.
    pub bridge: bool,
    /// Index into `meta.drift.years` when the drift correction applies (fused mode).
    pub drift_idx: Option<usize>,
    /// VIIRS error row (number of satellites − 1).
    pub era: usize,
    /// Fraction of the month's days covered by the stream(s) serving it (the larger of the two
    /// when both are fused); 0 when no stream serves it.
    pub coverage: f64,
    /// The month has a value but its serving stream(s) delivered data on fewer than
    /// `meta.complete_min` of its days (the month in progress, or an outage month): drawn, never
    /// used in a statistic.
    pub partial: bool,
    /// Multipliers `[MODIS, VIIRS]` that turn the stored (coverage-corrected) values of this month
    /// into what was actually detected: `1 / factor` of the pipeline's 1/coverage scaling for a
    /// partial month, `[1, 1]` otherwise (complete months keep the correction).
    pub unscale: [f64; 2],
}

impl Plan {
    pub fn covered(&self) -> bool {
        self.use_m || self.use_v
    }

    /// The stored values of this month were scaled up for missing days and are shown unscaled.
    pub fn scaled(&self) -> bool {
        self.unscale != [1.0, 1.0]
    }
}

/// `unscale` of a month (see [`Plan::unscale`]).
fn unscale(meta: &Meta, m: i32, partial: bool) -> [f64; 2] {
    if partial {
        [1.0 / meta.modis_factor(m), 1.0 / meta.viirs_factor(m)]
    } else {
        [1.0, 1.0]
    }
}

/// Which streams serve month `m`. `model` = the error model is present; without it, both modes
/// follow the switch.
pub fn plan(meta: &Meta, m: i32, mode: Mode, switch_m: i32, model: bool) -> Plan {
    let (mok, vok, mfull, vfull) = (meta.modis_ok(m), meta.viirs_ok(m), meta.modis_full(m), meta.viirs_full(m));
    let bridge = m < meta.aqua_start_m;
    let era = meta.viirs_era(m);
    let coverage_of = |use_m: bool, use_v: bool| {
        let cm = if use_m { meta.modis_days(m) } else { 0.0 };
        let cv = if use_v { meta.viirs_days(m) } else { 0.0 };
        cm.max(cv)
    };
    if mode == Mode::Switch || !model {
        let src = source_for(meta, m, switch_m);
        let (use_m, use_v) = (matches!(src, Source::Bridge | Source::Modis), src == Source::Viirs);
        let coverage = coverage_of(use_m, use_v);
        let partial = (use_m || use_v) && coverage < meta.complete_min;
        let unscale = unscale(meta, m, partial);
        return Plan { m, use_m, use_v, bridge, drift_idx: None, era, coverage, partial, unscale };
    }
    // Fused: a stream below `cov_min` (not coverage-corrected) is dropped when the other one reaches it.
    let use_m = mok && (mfull || !vfull);
    let use_v = vok && (vfull || !mfull);
    let coverage = coverage_of(use_m, use_v);
    let partial = (use_m || use_v) && coverage < meta.complete_min;
    let drift_idx = if mok { meta.drift.as_ref().and_then(|d| d.index(year_of(m))) } else { None };
    let unscale = unscale(meta, m, partial);
    Plan { m, use_m, use_v, bridge, drift_idx, era, coverage, partial, unscale }
}

/// Estimate of one stratum × dn group (or one tile row) for a month.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupEst {
    pub h: f64,
    pub var: f64,
    /// MODIS weight of this group (1 MODIS only, 0 VIIRS only).
    pub w: f64,
    /// MODIS value after the drift correction (the raw value when none applies).
    pub madj: f64,
}

/// Group estimate under the error model (`meq`, `kv` in AFCD; `d` = 0 day, 1 night).
pub fn estimate(meta: &Meta, plan: &Plan, p: &StratumMeta, d: usize, meq: f64, kv: f64) -> GroupEst {
    let d = d.min(1);
    let (meq, kv) = (finite0(meq), finite0(kv));
    let err: ErrModel = p.err.unwrap_or_default();
    let ms = if plan.bridge { err.bridge } else { err.modis };
    let rho_m0 = ms.rho[d];
    let mut sm = StreamVar { rho: rho_m0, phi: ms.phi[d] };
    let mut madj = meq;
    let mut drifted = false;
    if let (Some(idx), Some(dr)) = (plan.drift_idx, meta.drift.as_ref()) {
        if let Some(row) = dr.row(p.biome) {
            let lf = row.log_f[d].get(idx).copied().filter(|x| x.is_finite()).unwrap_or(0.0).clamp(-5.0, 5.0);
            let sd = row.log_sd[d].get(idx).copied().filter(|x| x.is_finite()).unwrap_or(0.0).max(0.0);
            madj = meq * (-lf).exp();
            sm.rho += sd * sd + (dr.attr_frac * lf).powi(2);
            drifted = true;
        }
    }
    let ve = err.viirs[plan.era.min(2)];
    let rho_v0 = ve.rho[d];
    let relvar = p.relvar[d];
    let sv = StreamVar { rho: rho_v0 + relvar, phi: ve.phi[d] };
    let c_rho = meta.kappa[d] * (rho_m0 * rho_v0).sqrt() + if drifted { relvar } else { 0.0 };
    match (plan.use_m, plan.use_v) {
        (true, true) => {
            let f = fuse(madj, kv, sm, sv, c_rho);
            GroupEst { h: f.h, var: f.var, w: f.w, madj }
        }
        (true, false) => GroupEst { h: madj, var: sm.var(madj), w: 1.0, madj },
        (false, true) => GroupEst { h: kv, var: sv.var(kv), w: 0.0, madj },
        (false, false) => GroupEst { h: 0.0, var: 0.0, w: 0.0, madj },
    }
}

/// Per-month values over the whole record (`index 0 = m_first`).
#[derive(Debug, Clone)]
pub struct Monthly {
    pub m_first: i32,
    pub viirs_start_m: i32,
    pub source: Vec<Source>,
    /// Harmonized value; `None` = outside the record or no coverage, `Some(0)` = covered, no fire.
    pub h: Vec<Option<f64>>,
    /// `[lo80, hi80, lo95, hi95]` where an interval applies.
    pub band: Vec<Option<[f64; 4]>>,
    pub meq: Vec<Option<f64>>,
    pub kv: Vec<Option<f64>>,
    pub v: Vec<Option<f64>>,
    pub nmod: Vec<f64>,
    pub nvii: Vec<f64>,
    /// MODIS share of the harmonized value (0..1); `None` without a value or when it is 0.
    pub w_modis: Vec<Option<f64>>,
    /// Drift-corrected MODIS where MODIS exists (equal to `meq` when no correction applies).
    pub madj: Vec<Option<f64>>,
    pub provisional: Vec<bool>,
    /// The month has a value but the stream(s) serving it delivered data on fewer than
    /// `meta.complete_min` of its days (see [`Plan::partial`]): drawn, never used in a statistic.
    pub partial: Vec<bool>,
    /// Day coverage of the serving stream(s) ([`Plan::coverage`]).
    pub coverage: Vec<f64>,
    /// Partial months whose stored values were scaled up for missing days: the scaled full-month
    /// projection (`h` holds what was detected so far). `None` elsewhere.
    pub projected: Vec<Option<f64>>,
    /// MODIS / calibrated VIIRS delivered data on at least `meta.complete_min` of the month's
    /// days (for the seam).
    pub modis_full: Vec<bool>,
    pub viirs_full: Vec<bool>,
    /// The error model and the conformal table produced the bounds.
    pub conformal: bool,
    /// The fused value was used (mode fused with the error model present).
    pub fused: bool,
}

impl Monthly {
    pub fn len(&self) -> usize {
        self.h.len()
    }

    pub fn is_empty(&self) -> bool {
        self.h.is_empty()
    }

    pub fn m_last(&self) -> i32 {
        self.m_first + self.len() as i32 - 1
    }

    pub fn index(&self, m: i32) -> Option<usize> {
        let i = m.checked_sub(self.m_first)?;
        usize::try_from(i).ok().filter(|&i| i < self.len())
    }

    pub fn h_at(&self, m: i32) -> Option<f64> {
        self.index(m).and_then(|i| self.h[i])
    }

    /// Harmonized value of index `i` for statistics: `None` for partial months.
    pub fn stat(&self, i: usize) -> Option<f64> {
        self.h[i].filter(|_| !self.partial[i])
    }

    pub fn stat_at(&self, m: i32) -> Option<f64> {
        self.index(m).and_then(|i| self.stat(i))
    }

    /// The harmonized record with partial months removed.
    pub fn stat_values(&self) -> Vec<Option<f64>> {
        (0..self.len()).map(|i| self.stat(i)).collect()
    }

    /// Index of the latest complete-enough month with a value (a trailing partial month is skipped).
    pub fn latest(&self) -> Option<usize> {
        (0..self.len()).rev().find(|&i| self.stat(i).is_some())
    }
}

/// Weighted sums for one month × stratum × dn.
#[derive(Debug, Clone, Copy, Default)]
struct Group {
    kv: f64,
    kvsq_w2: f64,
    meq: f64,
}

/// Inputs of one month's estimate.
struct MonthCtx<'a> {
    meta: &'a Meta,
    pl: &'a Plan,
    params: &'a [StratumMeta],
    act: &'a [f64],
    gs: &'a [Group],
    model: bool,
}

/// Harmonized value, bounds, MODIS share and drift-corrected MODIS of one month.
struct MonthEst {
    h: Option<f64>,
    band: Option<[f64; 4]>,
    w_modis: Option<f64>,
    madj: f64,
}

/// Month totals `[meq, kv, v, nmod, nvii]` with the MODIS / VIIRS values multiplied by `s`
/// (detection counts are never coverage-corrected).
fn scaled_totals(t: &[f64; 5], s: [f64; 2]) -> [f64; 5] {
    [t[0] * s[0], t[1] * s[1], t[2] * s[1], t[3], t[4]]
}

/// The month's harmonized value with the stored MODIS / VIIRS values multiplied by `s`.
fn month_estimate(c: &MonthCtx, t: &[f64; 5], s: [f64; 2], parts: &mut Vec<(i32, f64)>) -> MonthEst {
    let (meta, pl, params) = (c.meta, c.pl, c.params);
    let [meq, kv, ..] = scaled_totals(t, s);
    let scaled = |g: &Group| Group { meq: g.meq * s[0], kv: g.kv * s[1], kvsq_w2: g.kvsq_w2 * s[1] * s[1] };
    let param = |k: usize| (&params[k / 2], k % 2);
    if c.model {
        let (mut h, mut var, mut wh, mut madj) = (0.0, 0.0, 0.0, 0.0);
        parts.clear();
        for (k, g) in c.gs.iter().enumerate() {
            if g.meq <= 0.0 && g.kv <= 0.0 {
                continue;
            }
            let g = scaled(g);
            let (p, d) = param(k);
            let e = estimate(meta, pl, p, d, g.meq, g.kv);
            h += e.h;
            var += e.var;
            wh += e.w * e.h;
            madj += e.madj;
            parts.push((p.biome, e.h));
        }
        // A single uncorrected stream: its exact total (sums over groups differ in the last bits).
        if pl.drift_idx.is_none() {
            madj = meq;
            match (pl.use_m, pl.use_v) {
                (true, false) => (h, wh) = (meq, meq),
                (false, true) => (h, wh) = (kv, 0.0),
                _ => {}
            }
        }
        if pl.covered() {
            let q = month_q(meta, parts, h);
            let w = (h > 0.0).then(|| (wh / h).clamp(0.0, 1.0));
            let var = var.max(var_floor(meta, pl, params, c.act));
            MonthEst { h: Some(h), band: Some(bounds_shifted(h, var, q[0], q[1])), w_modis: w, madj }
        } else {
            MonthEst { h: None, band: None, w_modis: None, madj }
        }
    } else {
        // Legacy record and intervals (no error model in meta.json).
        let (h, band) = if pl.use_m {
            if pl.bridge {
                let terms = c.gs.iter().enumerate().map(|(k, g)| {
                    let (p, d) = param(k);
                    (p.relvar_bridge[d], g.meq * s[0])
                });
                (Some(meq), Some(bounds(meq, bridge_variance(terms, meta.ci_scale))))
            } else {
                (Some(meq), None)
            }
        } else if pl.use_v {
            let terms = c.gs.iter().enumerate().map(|(k, g)| {
                let (p, d) = param(k);
                let g = scaled(g);
                (p.relvar[d], p.alpha[d], g.kv, g.kvsq_w2)
            });
            (Some(kv), Some(bounds(kv, viirs_variance(terms, meta.ci_scale))))
        } else {
            (None, None)
        };
        let w = h.filter(|&h| h > 0.0).map(|_| if pl.use_m { 1.0 } else { 0.0 });
        MonthEst { h, band, w_modis: w, madj: meq }
    }
}

/// `[q80, q95]` multipliers on σ_log for a month: H-weighted over its groups' biome groups, the
/// global row when H = 0, `z · ci_scale` where the table has no valid entry.
fn month_q(meta: &Meta, parts: &[(i32, f64)], h: f64) -> [f64; 2] {
    let legacy = [Z80 * meta.ci_scale, Z95 * meta.ci_scale];
    let Some(c) = meta.conformal.as_ref() else { return legacy };
    let class = c.class(h);
    let one = |biome: Option<i32>| {
        let q = c.q(biome, class);
        [q[0].unwrap_or(legacy[0]), q[1].unwrap_or(legacy[1])]
    };
    if h <= 0.0 {
        return one(None);
    }
    let mut acc = [0.0; 2];
    for &(biome, hg) in parts {
        let q = one(Some(biome));
        acc[0] += hg * q[0];
        acc[1] += hg * q[1];
    }
    [acc[0] / h, acc[1] / h]
}

/// Variance floor of a month: the variance at the level `LOG_SHIFT` of the area's typical group,
/// i.e. the activity-weighted mean over the area's stratum × dn groups (record totals) of each
/// group's variance law under this month's plan. The variance law gives `Var(0) = 0`, which would
/// collapse the interval of a zero month to 0–0; with the floor a zero month keeps an upper bound
/// (an observed zero is compatible with a small latent activity). It matters only below a few
/// cell-days. An area without any activity in the record falls back to Poisson (`Var = LOG_SHIFT`).
/// `harmonize.py` applies the same floor to the conformal scores.
fn var_floor(meta: &Meta, pl: &Plan, params: &[StratumMeta], act: &[f64]) -> f64 {
    if !pl.covered() {
        return 0.0;
    }
    let total: f64 = act.iter().filter(|a| a.is_finite() && **a > 0.0).sum();
    if total <= 0.0 {
        return LOG_SHIFT;
    }
    let mut acc = 0.0;
    for (k, &a) in act.iter().enumerate() {
        if !(a.is_finite() && a > 0.0) {
            continue;
        }
        acc += a * estimate(meta, pl, &params[k / 2], k % 2, LOG_SHIFT, LOG_SHIFT).var;
    }
    let f = acc / total;
    if f.is_finite() {
        f.max(0.0)
    } else {
        0.0
    }
}

/// One pass over the stored rows: monthly totals for the `dn` filter, the harmonized series for
/// `mode` (`switch_m` in switch mode) and its bounds per month.
pub fn aggregate(meta: &Meta, store: &Store, dn: Dn, mode: Mode, switch_m: i32) -> Monthly {
    let n = meta.n_months();
    let model = meta.has_err_model();

    // Compact the strata present in the store so the group table stays small.
    let mut slot_of: Vec<u32> = Vec::new();
    let mut params: Vec<StratumMeta> = Vec::new();
    for &s in &store.stratum {
        let s = s as usize;
        if s >= slot_of.len() {
            slot_of.resize(s + 1, u32::MAX);
        }
        if slot_of[s] == u32::MAX {
            slot_of[s] = params.len() as u32;
            params.push(meta.strata.get(s).cloned().unwrap_or_default());
        }
    }
    let ns = params.len();

    // [meq, kv, v, nmod, nvii]
    let mut tot = vec![[0f64; 5]; n];
    let mut groups = vec![Group::default(); n * ns * 2];
    for r in 0..store.len() {
        let d = store.dn[r];
        if !dn.accepts(d) {
            continue;
        }
        let i = store.m[r] as i64 - meta.m_first as i64;
        if i < 0 || i >= n as i64 {
            continue;
        }
        let i = i as usize;
        let w = store.w[r] as f64;
        let meq = w * store.meq[r] as f64 / 100.0;
        let kv = w * store.kv[r] as f64 / 100.0;
        let t = &mut tot[i];
        t[0] += meq;
        t[1] += kv;
        t[2] += w * store.v[r] as f64 / 100.0;
        t[3] += w * store.nmod[r] as f64;
        t[4] += w * store.nvii[r] as f64;
        let g = &mut groups[(i * ns + slot_of[store.stratum[r] as usize] as usize) * 2 + d as usize];
        g.kv += kv;
        g.kvsq_w2 += w * w * store.kvsq[r] as f64;
        g.meq += meq;
    }

    let mut out = Monthly {
        m_first: meta.m_first,
        viirs_start_m: meta.viirs_start_m,
        source: Vec::with_capacity(n),
        h: Vec::with_capacity(n),
        band: Vec::with_capacity(n),
        meq: Vec::with_capacity(n),
        kv: Vec::with_capacity(n),
        v: Vec::with_capacity(n),
        nmod: Vec::with_capacity(n),
        nvii: Vec::with_capacity(n),
        w_modis: Vec::with_capacity(n),
        madj: Vec::with_capacity(n),
        provisional: Vec::with_capacity(n),
        partial: Vec::with_capacity(n),
        coverage: Vec::with_capacity(n),
        projected: Vec::with_capacity(n),
        modis_full: Vec::with_capacity(n),
        viirs_full: Vec::with_capacity(n),
        conformal: model && meta.conformal.is_some(),
        fused: model && mode == Mode::Fused,
    };
    // Activity of each group over the whole record: weights of the variance floor.
    let mut act = vec![0f64; ns * 2];
    for i in 0..n {
        for (k, g) in groups[i * ns * 2..(i + 1) * ns * 2].iter().enumerate() {
            act[k] += g.meq + g.kv;
        }
    }
    let mut parts: Vec<(i32, f64)> = Vec::with_capacity(ns * 2);
    for (i, t) in tot.iter().enumerate() {
        let m = meta.m_first + i as i32;
        let pl = plan(meta, m, mode, switch_m, model);
        let gs = &groups[i * ns * 2..(i + 1) * ns * 2];
        let ctx = MonthCtx { meta, pl: &pl, params: &params, act: &act, gs, model };
        // A partial month shows what was detected so far; the stored (scaled) values give the projection.
        let est = month_estimate(&ctx, t, pl.unscale, &mut parts);
        let projected = if pl.scaled() && est.h.is_some() { month_estimate(&ctx, t, [1.0, 1.0], &mut parts).h } else { None };
        let (h, band, w_modis, madj) = (est.h, est.band, est.w_modis, est.madj);
        let [meq, kv, v, nmod, nvii] = scaled_totals(t, pl.unscale);
        let source = if !pl.covered() {
            Source::None
        } else if pl.use_v && (!pl.use_m || w_modis.is_some_and(|w| w < 0.5)) {
            Source::Viirs
        } else if pl.bridge {
            Source::Bridge
        } else {
            Source::Modis
        };
        out.source.push(source);
        out.h.push(h);
        out.band.push(band);
        out.meq.push(meta.modis_ok(m).then_some(meq));
        out.kv.push(meta.viirs_ok(m).then_some(kv));
        out.v.push(meta.viirs_ok(m).then_some(v));
        out.nmod.push(nmod);
        out.nvii.push(nvii);
        out.w_modis.push(w_modis);
        out.madj.push(meta.modis_ok(m).then_some(madj));
        out.provisional.push(meta.provisional(m));
        out.partial.push(pl.partial);
        out.coverage.push(pl.coverage);
        out.projected.push(projected);
        out.modis_full.push(meta.modis_ok(m) && meta.modis_days(m) >= meta.complete_min);
        out.viirs_full.push(meta.viirs_ok(m) && meta.viirs_days(m) >= meta.complete_min);
    }
    out
}

/// The reference-sensor lens: per calendar month, the factor dividing MODIS-equivalent values.
#[derive(Debug, Clone, PartialEq)]
pub struct Lens {
    pub factor: [f64; 12],
    /// Some calendar month did not have its own factor (a fallback level was used).
    pub fallback: bool,
}

/// `f_k = Σ kv / Σ v` of calendar month k over the record's months inside `fit` (fallback: all
/// `fit` months pooled, then all months with `v > 0` pooled, else 1).
pub fn lens(mo: &Monthly, fit: Option<[i32; 2]>) -> Lens {
    let mut by = [[0.0f64; 2]; 12];
    let (mut fit_all, mut all) = ([0.0f64; 2], [0.0f64; 2]);
    for i in 0..mo.len() {
        let (Some(kv), Some(v)) = (mo.kv[i], mo.v[i]) else { continue };
        if !(kv.is_finite() && v.is_finite() && v > 0.0) {
            continue;
        }
        let m = mo.m_first + i as i32;
        all[0] += kv;
        all[1] += v;
        if fit.is_some_and(|[a, b]| (a..=b).contains(&m)) {
            fit_all[0] += kv;
            fit_all[1] += v;
            by[moy(m)][0] += kv;
            by[moy(m)][1] += v;
        }
    }
    let ok = |s: [f64; 2]| (s[0] > 0.0 && s[1] > 0.0).then(|| s[0] / s[1]).filter(|f| f.is_finite() && *f > 0.0);
    let mut fallback = false;
    let factor = std::array::from_fn(|k| {
        ok(by[k]).unwrap_or_else(|| {
            fallback = true;
            ok(fit_all).or(ok(all)).unwrap_or(1.0)
        })
    });
    Lens { factor, fallback }
}

/// Divides every MODIS-equivalent value of the record by the lens factor of its calendar month.
pub fn apply_lens(mo: &mut Monthly, l: &Lens) {
    for i in 0..mo.len() {
        let f = l.factor[moy(mo.m_first + i as i32)];
        let f = if f.is_finite() && f > 0.0 { f } else { 1.0 };
        let div = |x: &mut Option<f64>| {
            if let Some(v) = x {
                *v /= f;
            }
        };
        div(&mut mo.h[i]);
        div(&mut mo.meq[i]);
        div(&mut mo.kv[i]);
        div(&mut mo.madj[i]);
        div(&mut mo.projected[i]);
        if let Some(b) = &mut mo.band[i] {
            b.iter_mut().for_each(|x| *x /= f);
        }
    }
}

/// `Series` in types.ts, for the display range.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub harmonized: Vec<Option<f64>>,
    pub lo80: Vec<Option<f64>>,
    pub hi80: Vec<Option<f64>>,
    pub lo95: Vec<Option<f64>>,
    pub hi95: Vec<Option<f64>>,
    pub modis_eq: Vec<Option<f64>>,
    pub viirs_cal: Vec<Option<f64>>,
    pub viirs_raw: Vec<Option<f64>>,
    pub raw_modis_count: Vec<f64>,
    pub raw_viirs_count: Vec<f64>,
    /// MODIS counts before VIIRS starts, VIIRS counts from then on.
    pub naive: Vec<f64>,
    pub source: Vec<Source>,
    pub provisional: Vec<bool>,
    /// The month has a value but its serving stream(s) delivered data on fewer than
    /// `meta.complete_min_coverage` (0.9) of its days (the month in progress, or an outage month):
    /// drawn, but excluded from every statistic.
    pub partial: Vec<bool>,
    /// MODIS share of the harmonized value (0..1); null without a value or when it is 0.
    pub modis_weight: Vec<Option<f64>>,
    /// Drift-corrected MODIS where MODIS exists (equals `modis_eq` when no correction applies).
    pub modis_adj: Vec<Option<f64>>,
}

/// Slices the record to the inclusive display `range`; months outside the record are null/0.
pub fn series(mo: &Monthly, range: (i32, i32)) -> (Vec<i32>, Series) {
    let months: Vec<i32> = (range.0..=range.1).collect();
    let mut s = Series::default();
    for &m in &months {
        let i = mo.index(m);
        let band = i.and_then(|i| mo.band[i]);
        let at = |k: usize| band.map(|b| b[k]);
        let (nmod, nvii) = i.map_or((0.0, 0.0), |i| (mo.nmod[i], mo.nvii[i]));
        s.harmonized.push(i.and_then(|i| mo.h[i]));
        s.lo80.push(at(0));
        s.hi80.push(at(1));
        s.lo95.push(at(2));
        s.hi95.push(at(3));
        s.modis_eq.push(i.and_then(|i| mo.meq[i]));
        s.viirs_cal.push(i.and_then(|i| mo.kv[i]));
        s.viirs_raw.push(i.and_then(|i| mo.v[i]));
        s.raw_modis_count.push(nmod);
        s.raw_viirs_count.push(nvii);
        s.naive.push(if m < mo.viirs_start_m { nmod } else { nvii });
        s.source.push(i.map_or(Source::None, |i| mo.source[i]));
        s.provisional.push(i.is_some_and(|i| mo.provisional[i]));
        s.partial.push(i.is_some_and(|i| mo.partial[i]));
        s.modis_weight.push(i.and_then(|i| mo.w_modis[i]));
        s.modis_adj.push(i.and_then(|i| mo.madj[i]));
    }
    (months, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SM: StreamVar = StreamVar { rho: 0.01, phi: 1.0 };

    #[test]
    fn interval_formula_hand_computed() {
        // Two groups: S = 30, Q = 10, relvar 0.04, alpha 0.5; S = 10, Q = 4, relvar 0.09, alpha 1.
        // Var = 1.2² · [0.04·900 + 0.09·100 + (30 + 5) + (10 + 4)] = 1.44 · 94 = 135.36
        let var = viirs_variance([(0.04, 0.5, 30.0, 10.0), (0.09, 1.0, 10.0, 4.0)], 1.2);
        assert!((var - 135.36).abs() < 1e-9);
        let h = 40.0;
        let sigma = 135.36f64.sqrt() / 40.0; // 0.29086…
        let b = bounds(h, var);
        assert!((b[0] - 40.0 * (-1.2816 * sigma).exp()).abs() < 1e-9);
        assert!((b[1] - 40.0 * (1.2816 * sigma).exp()).abs() < 1e-9);
        assert!((b[2] - 22.619).abs() < 0.001, "{}", b[2]); // 40·e^(−1.96·0.290861)
        assert!((b[3] - 70.737).abs() < 0.001, "{}", b[3]); // 40·e^(+1.96·0.290861)
        assert!(b[0] < h && h < b[1] && b[2] < b[0] && b[3] > b[1]);
        // Small H uses the 0.5 floor in σ_log.
        let small = bounds(0.1, 0.01);
        assert!((small[1] - 0.1 * (1.2816 * 0.2f64).exp()).abs() < 1e-12);
        // Bridge: 1 · (0.01·50²) = 25
        assert!((bridge_variance([(0.01, 50.0)], 1.0) - 25.0).abs() < 1e-12);
    }

    #[test]
    fn conformal_bounds_hand_computed() {
        // Shifted log: H = 100, Var = 350 → σ = √350 / 100.5 = 0.186152;
        // 80 %: 100.5·e^(∓1.7σ) − 0.5 = 72.737 / 137.412; 95 %: 100.5·e^(∓2.9σ) − 0.5 = 58.076 / 171.931.
        let var = StreamVar { rho: 0.02, phi: 1.5 }.var(100.0);
        assert!((var - 350.0).abs() < 1e-9);
        let b = bounds_shifted(100.0, var, 1.7, 2.9);
        let s = 350f64.sqrt() / 100.5;
        assert!((b[0] - (100.5 * (-1.7 * s).exp() - 0.5)).abs() < 1e-9, "{b:?}");
        assert!((b[0] - 72.737).abs() < 1e-3 && (b[1] - 137.412).abs() < 1e-3, "{b:?}");
        assert!((b[2] - 58.076).abs() < 1e-3 && (b[3] - 171.931).abs() < 1e-3, "{b:?}");
        // A zero value with positive variance has a zero lower bound and a positive upper bound.
        let z = bounds_shifted(0.0, 1.0, 1.2816, 1.96);
        assert!(z[0] == 0.0 && z[2] == 0.0 && (z[1] - (0.5 * (1.2816f64 / 0.5).exp() - 0.5)).abs() < 1e-12);
        assert_eq!(bounds_shifted(0.0, 0.0, 1.3, 2.0), [0.0; 4]);
        assert!(bounds_shifted(5.0, f64::NAN, 1.3, 2.0).iter().all(|x| x.is_finite()));
        // Plain log scale (legacy form, kept for reference).
        let b = bounds_q(100.0, var, 1.7, 2.9);
        let s = 350f64.sqrt() / 100.0;
        assert!((b[0] - 100.0 * (-1.7 * s).exp()).abs() < 1e-9 && (b[0] - 72.757).abs() < 1e-3, "{b:?}");
        assert!((b[1] - 137.443).abs() < 1e-3 && (b[2] - 58.127).abs() < 1e-3 && (b[3] - 172.037).abs() < 1e-3, "{b:?}");
        // Zero value and zero variance: a degenerate, finite interval.
        assert_eq!(bounds_q(0.0, 0.0, 1.3, 2.0), [0.0; 4]);
        assert!(bounds_q(5.0, f64::NAN, 1.3, 2.0).iter().all(|x| x.is_finite()));
    }

    #[test]
    fn fusion_weight_limits() {
        // Equal variance laws: equal weights, the mean.
        let f = fuse(40.0, 60.0, SM, SM, 0.0);
        assert!((f.w - 0.5).abs() < 1e-12 && (f.h - 50.0).abs() < 1e-9, "{f:?}");
        // Var of the mean of two independent equal-variance streams = Var/2 at μ = 50.
        assert!((f.var - 0.5 * SM.var(50.0)).abs() < 1e-9);
        // Extreme imbalance: the precise stream dominates.
        let noisy = StreamVar { rho: 10.0, phi: 1e4 };
        let f = fuse(40.0, 60.0, SM, noisy, 0.0);
        assert!(f.w > 0.999 && (f.h - 40.0).abs() < 0.05, "{f:?}");
        let f = fuse(40.0, 60.0, noisy, SM, 0.0);
        assert!(f.w < 0.001 && (f.h - 60.0).abs() < 0.05, "{f:?}");
        // Fused variance never exceeds the better stream's.
        let other = StreamVar { rho: 0.05, phi: 2.0 };
        let f = fuse(40.0, 60.0, SM, other, 0.0);
        assert!(f.var <= SM.var(f.h).min(other.var(f.h)) + 1e-9 && f.h > 40.0 && f.h < 60.0, "{f:?}");
        // μ = 0: the phi limit phi_V / (phi_M + phi_V).
        let f = fuse(0.0, 0.0, StreamVar { rho: 0.3, phi: 1.0 }, StreamVar { rho: 0.1, phi: 3.0 }, 0.0);
        assert!((f.w - 0.75).abs() < 1e-12 && f.h == 0.0 && f.var == 0.0, "{f:?}");
        // All-zero parameters: equal weights, no NaN.
        let f = fuse(10.0, 20.0, StreamVar::default(), StreamVar::default(), 0.0);
        assert!((f.w - 0.5).abs() < 1e-12 && (f.h - 15.0).abs() < 1e-12 && f.var == 0.0);
        // Non-finite input never propagates.
        let f = fuse(f64::NAN, f64::INFINITY, SM, SM, f64::NAN);
        assert!(f.h.is_finite() && f.var.is_finite() && f.w.is_finite());
    }

    #[test]
    fn common_mode_reduces_benefit_and_is_clamped() {
        let (a, b) = (StreamVar { rho: 0.04, phi: 0.0 }, StreamVar { rho: 0.04, phi: 0.0 });
        let ind = fuse(100.0, 100.0, a, b, 0.0);
        let cor = fuse(100.0, 100.0, a, b, 0.02); // correlation 0.5
        assert!((ind.var - 0.5 * 400.0).abs() < 1e-9);
        assert!((cor.var - 0.75 * 400.0).abs() < 1e-9, "{cor:?}"); // (1 + ρ)/2 · σ²
        // Covariance above the admissible bound is clamped (correlation 0.99), weights stay in [0, 1].
        let huge = fuse(100.0, 50.0, StreamVar { rho: 0.01, phi: 0.0 }, StreamVar { rho: 0.04, phi: 0.0 }, 10.0);
        assert!((0.0..=1.0).contains(&huge.w) && huge.var.is_finite() && huge.var >= 0.0, "{huge:?}");
        // With a strongly correlated, noisier second stream, the weight leaves the noisier one entirely.
        assert_eq!(huge.w, 1.0);
    }
}
