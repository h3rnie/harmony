//! 1–3-month outlook: seasonal climatology plus damped persistence of the log-anomaly.
//!
//! * `x = log1p(harmonized)`; climatology `μ_k` = mean of x for calendar month k over the
//!   baseline years (all years if the baseline has none); anomaly `a = x − μ_k`.
//! * `ρ_h` (h = 1..3) = lag-h correlation of anomalies over the whole record, set to 0 unless it
//!   exceeds the 95 % white-noise bound 1.96/√n, then clipped to [0, 0.95].
//! * Forecast `x̂ = μ_k + ρ_h·a_latest`; the 80 % band adds the 10th/90th percentiles of the
//!   in-sample residuals `a_{t+h} − ρ_h·a_t` at that lead.
//! * Skill = 1 − MSE_model / MSE_climatology of a leave-one-year-out lead-1 hindcast on the log
//!   scale (μ and ρ re-estimated without the target year). With skill ≤ 0 the outlook is the
//!   baseline climatology itself (median with the q10–q90 range).

use std::collections::BTreeSet;

use serde::Serialize;

use crate::months::{moy, year_of};
use crate::robust::{quantile, sorted};
use crate::stats::Climatology;

const LEADS: i32 = 3;
/// Minimum anomaly pairs for a correlation or a skill estimate.
const MIN_PAIRS: usize = 24;

#[derive(Debug, Clone, Serialize)]
pub struct Outlook {
    pub months: Vec<i32>,
    pub median: Vec<f64>,
    pub lo80: Vec<f64>,
    pub hi80: Vec<f64>,
    pub climatology: Vec<f64>,
    pub skill: f64,
    pub rho: f64,
    pub method: &'static str,
}

struct LogRecord {
    x: Vec<Option<f64>>,
    m_first: i32,
    baseline: (i32, i32),
}

impl LogRecord {
    fn year(&self, i: usize) -> i32 {
        year_of(self.m_first + i as i32)
    }

    fn moy(&self, i: usize) -> usize {
        moy(self.m_first + i as i32)
    }

    /// Calendar-month means of x, leaving out `exclude` (a year).
    fn climatology(&self, exclude: Option<i32>) -> [f64; 12] {
        let (mut sb, mut nb, mut sa, mut na) = ([0.0; 12], [0usize; 12], [0.0; 12], [0usize; 12]);
        for (i, v) in self.x.iter().enumerate() {
            let (Some(v), y) = (v, self.year(i)) else { continue };
            if Some(y) == exclude {
                continue;
            }
            let k = self.moy(i);
            sa[k] += v;
            na[k] += 1;
            if (self.baseline.0..=self.baseline.1).contains(&y) {
                sb[k] += v;
                nb[k] += 1;
            }
        }
        std::array::from_fn(|k| match (nb[k], na[k]) {
            (0, 0) => 0.0,
            (0, n) => sa[k] / n as f64,
            (n, _) => sb[k] / n as f64,
        })
    }

    fn anomalies(&self, mu: &[f64; 12]) -> Vec<Option<f64>> {
        self.x.iter().enumerate().map(|(i, v)| v.map(|v| v - mu[self.moy(i)])).collect()
    }

    /// Lag-h anomaly correlation (no re-centring), significance-thresholded and clipped.
    fn rho(&self, a: &[Option<f64>], h: usize, exclude: Option<i32>) -> f64 {
        let (mut sxy, mut sxx, mut syy, mut n) = (0.0, 0.0, 0.0, 0usize);
        for t in 0..a.len().saturating_sub(h) {
            let (Some(p), Some(q)) = (a[t], a[t + h]) else { continue };
            if exclude.is_some_and(|y| self.year(t) == y || self.year(t + h) == y) {
                continue;
            }
            sxy += p * q;
            sxx += p * p;
            syy += q * q;
            n += 1;
        }
        if n < MIN_PAIRS || sxx <= 0.0 || syy <= 0.0 {
            return 0.0;
        }
        let r = sxy / (sxx * syy).sqrt();
        if r.is_finite() && r > 1.96 / (n as f64).sqrt() {
            r.min(0.95)
        } else {
            0.0
        }
    }

    /// Leave-one-year-out lead-1 hindcast skill against climatology.
    fn skill(&self) -> f64 {
        let years: BTreeSet<i32> =
            (0..self.x.len()).filter(|&i| self.x[i].is_some()).map(|i| self.year(i)).collect();
        let (mut sse_model, mut sse_clim, mut n) = (0.0, 0.0, 0usize);
        for y in years {
            let mu = self.climatology(Some(y));
            let a = self.anomalies(&mu);
            let rho = self.rho(&a, 1, Some(y));
            for j in 1..self.x.len() {
                if self.year(j) != y {
                    continue;
                }
                let (Some(origin), Some(target)) = (a[j - 1], self.x[j]) else { continue };
                let clim = mu[self.moy(j)];
                sse_clim += (target - clim).powi(2);
                sse_model += (target - clim - rho * origin).powi(2);
                n += 1;
            }
        }
        if n >= MIN_PAIRS && sse_clim > 0.0 {
            1.0 - sse_model / sse_clim
        } else {
            0.0
        }
    }
}

/// Outlook for the three months after the latest month with data.
pub fn outlook(h: &[Option<f64>], m_first: i32, baseline: [i32; 2], clim: &Climatology) -> Outlook {
    let rec = LogRecord {
        x: h.iter().map(|v| v.filter(|v| v.is_finite()).map(|v| v.max(0.0).ln_1p())).collect(),
        m_first,
        baseline: (baseline[0].min(baseline[1]), baseline[0].max(baseline[1])),
    };
    let latest = rec.x.iter().rposition(Option::is_some);
    let origin_m = m_first + latest.map_or(h.len() as i32 - 1, |i| i as i32);
    let months: Vec<i32> = (1..=LEADS).map(|l| origin_m + l).collect();
    let clim_at = |v: &[f64], m: i32| v.get(moy(m)).copied().unwrap_or(0.0);

    let mu = rec.climatology(None);
    let a = rec.anomalies(&mu);
    let rho: Vec<f64> = (1..=LEADS as usize).map(|l| rec.rho(&a, l, None)).collect();
    let skill = if latest.is_some() { rec.skill() } else { 0.0 };
    let persist = skill > 0.0 && rho[0] > 0.0;

    let mut out = Outlook {
        months: months.clone(),
        median: vec![],
        lo80: vec![],
        hi80: vec![],
        climatology: months.iter().map(|&m| clim_at(&clim.median, m)).collect(),
        skill,
        rho: rho[0],
        method: if persist { "anomaly-persistence" } else { "climatology" },
    };
    for (l, &m) in months.iter().enumerate() {
        if let (true, Some(Some(a_last))) = (persist, latest.map(|i| a[i])) {
            let r = rho[l];
            let resid = sorted(
                (0..a.len().saturating_sub(l + 1))
                    .filter_map(|t| Some(a[t + l + 1]? - r * a[t]?)),
            );
            let centre = mu[moy(m)] + r * a_last;
            let median = centre.exp_m1().max(0.0);
            out.median.push(median);
            out.lo80.push((centre + quantile(&resid, 0.1).unwrap_or(0.0)).exp_m1().clamp(0.0, median));
            out.hi80.push((centre + quantile(&resid, 0.9).unwrap_or(0.0)).exp_m1().max(median));
        } else {
            out.median.push(clim_at(&clim.median, m));
            out.lo80.push(clim_at(&clim.q10, m));
            out.hi80.push(clim_at(&clim.q90, m));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic uniform(0, 1) generator (64-bit LCG).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
        fn normal(&mut self) -> f64 {
            // Irwin–Hall approximation.
            (0..12).map(|_| self.next()).sum::<f64>() - 6.0
        }
    }

    fn clim_from(h: &[Option<f64>], m_first: i32) -> Climatology {
        let mut by_month: [Vec<f64>; 12] = Default::default();
        for (i, v) in h.iter().enumerate() {
            if let Some(v) = v {
                by_month[moy(m_first + i as i32)].push(*v);
            }
        }
        let by_month = by_month.map(sorted);
        let q = |p| by_month.iter().map(|s| quantile(s, p).unwrap_or(0.0)).collect();
        Climatology { median: q(0.5), mean: q(0.5), q10: q(0.1), q25: q(0.25), q75: q(0.75), q90: q(0.9), min: q(0.0), max: q(1.0) }
    }

    fn seasonal(i: usize) -> f64 {
        3.0 + 1.5 * (i as f64 / 12.0 * std::f64::consts::TAU).cos()
    }

    #[test]
    fn pure_noise_gives_climatology() {
        let mut g = Lcg(7);
        let h: Vec<Option<f64>> = (0..300).map(|i| Some((seasonal(i) + 0.8 * g.normal()).exp_m1().max(0.0))).collect();
        let o = outlook(&h, 10, [2003, 2022], &clim_from(&h, 10));
        assert_eq!(o.method, "climatology", "{o:?}");
        assert!(o.skill <= 0.0);
        assert_eq!(o.months, vec![310, 311, 312]);
        assert_eq!(o.median, o.climatology);
        assert!(o.lo80.iter().zip(&o.hi80).all(|(l, h)| l <= h));
    }

    #[test]
    fn persistent_anomalies_are_forecast() {
        let mut g = Lcg(11);
        let mut a = 0.0;
        let h: Vec<Option<f64>> = (0..300)
            .map(|i| {
                a = 0.8 * a + 0.5 * g.normal();
                Some((seasonal(i) + a).exp_m1().max(0.0))
            })
            .collect();
        let o = outlook(&h, 10, [2003, 2022], &clim_from(&h, 10));
        assert_eq!(o.method, "anomaly-persistence", "{o:?}");
        assert!(o.skill > 0.2 && o.rho > 0.6, "{o:?}");
        for k in 0..3 {
            assert!(o.lo80[k] <= o.median[k] && o.median[k] <= o.hi80[k]);
        }
    }

    #[test]
    fn empty_and_tiny_records() {
        let c = clim_from(&[], 10);
        let o = outlook(&[None, None], 10, [2003, 2022], &c);
        assert_eq!((o.method, o.months.len(), o.skill), ("climatology", 3, 0.0));
        let o = outlook(&[Some(5.0)], 10, [2003, 2022], &clim_from(&[Some(5.0)], 10));
        assert_eq!(o.median.len(), 3);
        assert!(o.median.iter().all(|v| v.is_finite()));
    }
}
