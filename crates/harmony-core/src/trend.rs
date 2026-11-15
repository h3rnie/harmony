//! Theil–Sen slope with Sen's 95 % confidence interval, and the Mann–Kendall test.

use serde::Serialize;

use crate::robust::{approx_eq, mean, median, norm_cdf, sorted};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trend {
    pub years: [i32; 2],
    pub slope_per_year: f64,
    /// Slope relative to the mean annual total.
    pub slope_pct_per_year: f64,
    pub lo: f64,
    pub hi: f64,
    pub tau: f64,
    pub p_value: f64,
    pub direction: &'static str,
}

/// Trend of `y` over `years` (at least 3 points, else a neutral result).
///
/// * Slope: median of pairwise slopes (Theil–Sen).
/// * CI: Sen (1968) / Gilbert (1987): with `C = 1.96·√Var(S)` and `N'` pairwise slopes, the
///   bounds are the `(N' − C)/2`-th and `((N' + C)/2 + 1)`-th ordered slopes.
/// * Mann–Kendall S with the tie-corrected variance
///   `[n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18`; two-sided p from the continuity-corrected normal
///   approximation (p = 1 when the variance is 0); tau-b as the effect size.
/// * `direction` is up/down only when p < 0.05.
pub fn trend(years: &[i32], y: &[f64]) -> Trend {
    let n = years.len().min(y.len());
    let span = match (years.first(), years.get(n.wrapping_sub(1))) {
        (Some(&a), Some(&b)) if n > 0 => [a, b],
        _ => [0, 0],
    };
    let neutral = Trend {
        years: span,
        slope_per_year: 0.0,
        slope_pct_per_year: 0.0,
        lo: 0.0,
        hi: 0.0,
        tau: 0.0,
        p_value: 1.0,
        direction: "none",
    };
    if n < 3 || y[..n].iter().any(|v| !v.is_finite()) {
        return neutral;
    }

    let mut slopes = Vec::with_capacity(n * (n - 1) / 2);
    let mut s = 0i64;
    for i in 0..n {
        for j in i + 1..n {
            let dy = y[j] - y[i];
            let dx = (years[j] - years[i]) as f64;
            if dx != 0.0 {
                slopes.push(dy / dx);
            }
            if !approx_eq(y[i], y[j]) {
                s += if dy > 0.0 { 1 } else { -1 };
            }
        }
    }
    let slopes = sorted(slopes);
    let Some(slope) = median(&slopes) else { return neutral };

    // Tie groups in y.
    let ys = sorted(y[..n].iter().copied());
    let mut ties = Vec::new();
    let mut run = 1usize;
    for k in 1..=ys.len() {
        if k < ys.len() && approx_eq(ys[k], ys[k - 1]) {
            run += 1;
        } else {
            if run > 1 {
                ties.push(run as f64);
            }
            run = 1;
        }
    }
    let nf = n as f64;
    let var_s = (nf * (nf - 1.0) * (2.0 * nf + 5.0) - ties.iter().map(|t| t * (t - 1.0) * (2.0 * t + 5.0)).sum::<f64>()) / 18.0;
    let sf = s as f64;
    let p_value = if var_s > 0.0 {
        let z = (sf - sf.signum()) / var_s.sqrt();
        (2.0 * (1.0 - norm_cdf(z.abs()))).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let n0 = nf * (nf - 1.0) / 2.0;
    let n2: f64 = ties.iter().map(|t| t * (t - 1.0) / 2.0).sum();
    let denom = (n0 * (n0 - n2)).sqrt();
    let tau = if denom > 0.0 { (sf / denom).clamp(-1.0, 1.0) } else { 0.0 };

    let c = 1.96 * var_s.max(0.0).sqrt();
    let big_n = slopes.len() as f64;
    let last = slopes.len() as i64 - 1;
    let lo_idx = (((big_n - c) / 2.0).round() as i64 - 1).clamp(0, last) as usize;
    let hi_idx = (((big_n + c) / 2.0).round() as i64).clamp(0, last) as usize;

    let avg = mean(&y[..n]).unwrap_or(0.0);
    let direction = match (p_value < 0.05, slope) {
        (true, s) if s > 0.0 => "up",
        (true, s) if s < 0.0 => "down",
        _ => "none",
    };
    Trend {
        years: span,
        slope_per_year: slope,
        slope_pct_per_year: if avg > 0.0 { 100.0 * slope / avg } else { 0.0 },
        lo: slopes[lo_idx].min(slope),
        hi: slopes[hi_idx].max(slope),
        tau,
        p_value,
        direction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_series_with_noise() {
        let years: Vec<i32> = (2001..=2024).collect();
        // Deterministic ±3 noise around 100 + 5·t.
        let y: Vec<f64> = years
            .iter()
            .enumerate()
            .map(|(i, _)| 100.0 + 5.0 * i as f64 + [3.0, -2.0, 0.5, -3.0, 1.5, 2.5, -1.0][i % 7])
            .collect();
        let t = trend(&years, &y);
        assert!((t.slope_per_year - 5.0).abs() < 0.5, "{t:?}");
        assert!(t.lo <= t.slope_per_year && t.slope_per_year <= t.hi);
        assert!(t.lo < 5.0 && 5.0 < t.hi, "{t:?}");
        assert!(t.p_value < 1e-6 && t.tau > 0.8 && t.direction == "up", "{t:?}");
        assert_eq!(t.years, [2001, 2024]);
        assert!(t.slope_pct_per_year > 0.0);
    }

    #[test]
    fn constant_series_is_neutral() {
        let years: Vec<i32> = (2003..=2022).collect();
        let t = trend(&years, &vec![42.0; years.len()]);
        assert_eq!(t.slope_per_year, 0.0);
        assert_eq!(t.p_value, 1.0);
        assert_eq!(t.tau, 0.0);
        assert_eq!((t.lo, t.hi), (0.0, 0.0));
        assert_eq!(t.direction, "none");
        let zeros = trend(&years, &vec![0.0; years.len()]);
        assert!(zeros.slope_pct_per_year == 0.0 && zeros.p_value == 1.0);
    }

    #[test]
    fn too_short_is_neutral() {
        let t = trend(&[2020, 2021], &[1.0, 5.0]);
        assert_eq!((t.p_value, t.direction, t.years), (1.0, "none", [2020, 2021]));
        assert_eq!(trend(&[], &[]).years, [0, 0]);
    }
}
