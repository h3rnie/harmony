//! Order statistics and small numeric helpers. All functions are total: empty or degenerate
//! input gives `None` (or a documented neutral value), never NaN.

/// Finite values in ascending order.
pub fn sorted<I: IntoIterator<Item = f64>>(xs: I) -> Vec<f64> {
    let mut v: Vec<f64> = xs.into_iter().filter(|x| x.is_finite()).collect();
    v.sort_unstable_by(f64::total_cmp);
    v
}

/// Quantile of an ascending slice, linear interpolation between order statistics
/// (Hyndman–Fan type 7, the numpy default).
pub fn quantile(sorted: &[f64], p: f64) -> Option<f64> {
    let n = sorted.len();
    if n == 0 {
        return None;
    }
    let h = (n - 1) as f64 * p.clamp(0.0, 1.0);
    let lo = h.floor() as usize;
    let hi = (lo + 1).min(n - 1);
    Some(sorted[lo] + (h - lo as f64) * (sorted[hi] - sorted[lo]))
}

pub fn median(sorted: &[f64]) -> Option<f64> {
    quantile(sorted, 0.5)
}

/// Median absolute deviation from the median (unscaled).
pub fn mad(sorted_xs: &[f64]) -> Option<f64> {
    let med = median(sorted_xs)?;
    median(&sorted(sorted_xs.iter().map(|x| (x - med).abs())))
}

pub fn mean(xs: &[f64]) -> Option<f64> {
    (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64)
}

/// Equality with a relative tolerance, for sums of floats.
pub fn approx_eq(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

/// Mid-rank percentile of `x` within `sample`: 100 · (#below + ½ · #tied) / n.
pub fn percentile_rank(sample: &[f64], x: f64) -> Option<f64> {
    if sample.is_empty() || !x.is_finite() {
        return None;
    }
    let (mut below, mut tied) = (0usize, 0usize);
    for &s in sample {
        if approx_eq(s, x) {
            tied += 1;
        } else if s < x {
            below += 1;
        }
    }
    Some(100.0 * (below as f64 + 0.5 * tied as f64) / sample.len() as f64)
}

/// Robust z-score (x − median) / (1.4826 · MAD). The scale is floored at max(√median, 0.5),
/// the Poisson s.d. of a count of that size, so a zero MAD (e.g. an all-zero baseline) never
/// divides by zero and small wiggles in quiet months do not become huge anomalies.
pub fn robust_z(x: f64, median: f64, mad: f64) -> f64 {
    let floor = median.max(0.0).sqrt().max(0.5);
    let z = (x - median) / (1.4826 * mad).max(floor);
    if z.is_finite() {
        z
    } else {
        0.0
    }
}

/// `x / base`, or `None` when the base is not positive.
pub fn ratio(x: f64, base: f64) -> Option<f64> {
    (base > 0.0 && x.is_finite() && base.is_finite()).then(|| x / base)
}

/// Pearson correlation; `None` for fewer than 3 pairs or zero variance.
pub fn pearson(x: &[f64], y: &[f64]) -> Option<f64> {
    let n = x.len().min(y.len());
    if n < 3 {
        return None;
    }
    let (mx, my) = (mean(&x[..n])?, mean(&y[..n])?);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let (dx, dy) = (x[i] - mx, y[i] - my);
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    let r = sxy / (sxx * syy).sqrt();
    (sxx > 0.0 && syy > 0.0 && r.is_finite()).then(|| r.clamp(-1.0, 1.0))
}

/// Standard normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7).
pub fn norm_cdf(z: f64) -> f64 {
    let x = z.abs() / std::f64::consts::SQRT_2;
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let poly = t
        * (0.254_829_592
            + t * (-0.284_496_736 + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    let erf = 1.0 - poly * (-x * x).exp();
    if z >= 0.0 {
        0.5 * (1.0 + erf)
    } else {
        0.5 * (1.0 - erf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_median_mad() {
        let v = sorted([7.0, 1.0, 3.0, 5.0, f64::NAN]);
        assert_eq!(v, vec![1.0, 3.0, 5.0, 7.0]);
        assert_eq!(median(&v), Some(4.0));
        assert_eq!(quantile(&v, 0.25), Some(2.5)); // numpy: 2.5
        assert!((quantile(&v, 0.9).unwrap() - 6.4).abs() < 1e-12);
        assert_eq!(quantile(&v, 0.0), Some(1.0));
        assert_eq!(quantile(&v, 1.0), Some(7.0));
        assert_eq!(mad(&v), Some(2.0)); // |x - 4| = 3,1,1,3
        let w = sorted([1.0, 1.0, 2.0, 2.0, 4.0, 6.0, 9.0]);
        assert_eq!(median(&w), Some(2.0));
        assert_eq!(mad(&w), Some(1.0)); // |x - 2| = 1,1,0,0,2,4,7
        assert_eq!(median(&[]), None);
        assert_eq!(mad(&[]), None);
    }

    #[test]
    fn percentile_ranks() {
        let s = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(percentile_rank(&s, 0.0), Some(0.0));
        assert_eq!(percentile_rank(&s, 5.0), Some(100.0));
        assert_eq!(percentile_rank(&s, 2.0), Some(37.5));
        assert_eq!(percentile_rank(&s, 2.5), Some(50.0));
        assert_eq!(percentile_rank(&[0.0; 5], 0.0), Some(50.0));
        assert_eq!(percentile_rank(&[], 1.0), None);
    }

    #[test]
    fn robust_z_never_divides_by_zero() {
        assert_eq!(robust_z(0.0, 0.0, 0.0), 0.0);
        assert_eq!(robust_z(3.0, 0.0, 0.0), 6.0); // floor 0.5
        assert!((robust_z(20.0, 10.0, 5.0) - 10.0 / (1.4826 * 5.0)).abs() < 1e-12);
        assert_eq!(ratio(1.0, 0.0), None);
    }

    #[test]
    fn normal_cdf_and_pearson() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 1e-7);
        assert!((norm_cdf(1.96) - 0.975).abs() < 1e-4);
        assert!((norm_cdf(-1.2816) - 0.1).abs() < 1e-4);
        let r = pearson(&[1.0, 2.0, 3.0, 4.0], &[2.0, 4.0, 6.0, 8.5]).unwrap();
        assert!((r - 0.9988).abs() < 1e-3, "{r}");
        assert_eq!(pearson(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]), None);
    }
}
