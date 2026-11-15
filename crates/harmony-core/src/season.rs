//! Fire-season metrics from a 12-month climatological profile.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub peak_month: u32,
    pub start_month: u32,
    pub end_month: u32,
    pub length_months: u32,
    pub concentration: f64,
    pub second_peak: Option<u32>,
    /// A fire season can be described: the profile has activity and the area is not sparse
    /// (the engine clears it for sparse areas, `Analysis.activity`). When false the other fields
    /// are placeholders and must not be read as a season.
    pub defined: bool,
}

/// Share of annual activity the season window must hold.
const SEASON_SHARE: f64 = 0.8;
/// A second peak must reach this fraction of the main peak.
const SECOND_PEAK_SHARE: f64 = 0.5;

/// * Peak: month with the highest profile value (earliest on ties).
/// * Season: the shortest contiguous circular window holding ≥ 80 % of the annual total; among
///   equally short windows the one with the most activity.
/// * Second peak: the highest local maximum ≥ 50 % of the main peak that lies more than two
///   months (circularly) from it.
///
/// Months are 1-based. An all-zero profile gives a 12-month season with concentration 0.
pub fn season(profile: &[f64; 12]) -> Season {
    let p: [f64; 12] = profile.map(|v| if v.is_finite() { v.max(0.0) } else { 0.0 });
    let total: f64 = p.iter().sum();
    let peak = (0..12).fold(0, |best, k| if p[k] > p[best] { k } else { best });
    if total <= 0.0 {
        return Season {
            peak_month: 1,
            start_month: 1,
            end_month: 12,
            length_months: 12,
            concentration: 0.0,
            second_peak: None,
            defined: false,
        };
    }

    let window = |start: usize, len: usize| (0..len).map(|j| p[(start + j) % 12]).sum::<f64>();
    let (start, len, held) = (1..=12)
        .find_map(|len| {
            let (start, held) = (0..12)
                .map(|s| (s, window(s, len)))
                .fold((0, f64::NEG_INFINITY), |a, b| if b.1 > a.1 { b } else { a });
            (held >= SEASON_SHARE * total * (1.0 - 1e-12)).then_some((start, len, held))
        })
        .unwrap_or((0, 12, total));

    let circ = |a: usize, b: usize| {
        let d = a.abs_diff(b);
        d.min(12 - d)
    };
    let second = (0..12)
        .filter(|&k| circ(k, peak) > 2 && p[k] > 0.0 && p[k] >= SECOND_PEAK_SHARE * p[peak])
        .filter(|&k| {
            let (prev, next) = (p[(k + 11) % 12], p[(k + 1) % 12]);
            p[k] >= prev && p[k] >= next && (p[k] > prev || p[k] > next)
        })
        .fold(None, |best: Option<usize>, k| match best {
            Some(b) if p[b] >= p[k] => Some(b),
            _ => Some(k),
        });

    Season {
        peak_month: peak as u32 + 1,
        start_month: start as u32 + 1,
        end_month: ((start + len - 1) % 12) as u32 + 1,
        length_months: len as u32,
        concentration: held / total,
        second_peak: second.map(|k| k as u32 + 1),
        defined: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unimodal_season() {
        // Peak in August, most activity July–September.
        let p = [1.0, 1.0, 1.0, 2.0, 5.0, 10.0, 40.0, 80.0, 50.0, 10.0, 2.0, 1.0];
        let s = season(&p);
        assert_eq!(s.peak_month, 8);
        // total 203; 0.8 → 162.4; Jun–Sep = 180 (4 months); best 3 months Jul–Sep = 170 ≥ 162.4.
        assert_eq!((s.start_month, s.end_month, s.length_months), (7, 9, 3));
        assert!((s.concentration - 170.0 / 203.0).abs() < 1e-12);
        assert_eq!(s.second_peak, None);
    }

    #[test]
    fn wrap_around_season() {
        // Southern-summer regime peaking in January, active December–February.
        let p = [100.0, 70.0, 10.0, 2.0, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 10.0, 60.0];
        let s = season(&p);
        assert_eq!(s.peak_month, 1);
        assert_eq!((s.start_month, s.end_month, s.length_months), (12, 2, 3));
        assert!(s.concentration >= 0.8);
    }

    #[test]
    fn bimodal_and_flat() {
        let p = [5.0, 50.0, 20.0, 5.0, 2.0, 1.0, 2.0, 10.0, 35.0, 40.0, 8.0, 3.0];
        let s = season(&p);
        assert_eq!(s.peak_month, 2);
        assert_eq!(s.second_peak, Some(10));
        let z = season(&[0.0; 12]);
        assert_eq!((z.length_months, z.concentration, z.second_peak, z.defined), (12, 0.0, None, false));
        assert!(s.defined);
    }
}
