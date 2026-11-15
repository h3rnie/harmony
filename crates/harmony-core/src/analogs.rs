//! Analog years: past complete years whose year-to-date trajectory is closest to the current
//! year's, and how the rest of those years went.
//!
//! * Target: the year of the latest complete-enough month, months 1..K (K = its month).
//! * Candidates: complete years (12 complete-enough months) before the target year.
//! * Distance: `sqrt(mean_k (ln(1+x_c,k) − ln(1+x_t,k))²)` over the target's months with a value.
//! * Rest of year: total of months K+1..12, as a ratio to the candidates' median rest total.
//! * Skill: leave-one-out hindcast over the candidates. For each candidate c, the mean ln ratio of
//!   its 3 nearest other candidates (ratios to the median of the others) predicts its own ln
//!   ratio; `skill = 1 − Σ(pred − act)² / Σ act²` (0 = no better than the climatological median).

use serde::Serialize;

use crate::months::{month_index, year_of};
use crate::robust::{median, sorted};
use crate::series::Monthly;

const TOP: usize = 3;
const MIN_CANDIDATES: usize = 4;
const MIN_SKILL_CANDIDATES: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalogYear {
    pub year: i32,
    pub distance: f64,
    pub rest_total: Option<f64>,
    pub rest_ratio: Option<f64>,
    /// Month (1..12) of the largest value among months K+1..12; null when none is positive.
    pub peak_month: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analogs {
    pub year: i32,
    pub through_month: u32,
    pub candidates: u32,
    pub top: Vec<AnalogYear>,
    pub rest_median: Option<f64>,
    pub spread: Option<f64>,
    pub clim_spread: Option<f64>,
    pub skill: Option<f64>,
    pub informative: bool,
    pub note: String,
}

fn ln1p_dist(a: &[f64; 12], b: &[Option<f64>; 12], k: usize) -> Option<f64> {
    let (mut s, mut n) = (0.0, 0usize);
    for j in 0..k {
        if let Some(t) = b[j] {
            s += (a[j].max(0.0).ln_1p() - t.max(0.0).ln_1p()).powi(2);
            n += 1;
        }
    }
    (n > 0).then(|| (s / n as f64).sqrt()).filter(|d| d.is_finite())
}

/// Sample standard deviation; `None` for fewer than 2 values.
fn sd(xs: &[f64]) -> Option<f64> {
    let n = xs.len();
    if n < 2 {
        return None;
    }
    let mean = xs.iter().sum::<f64>() / n as f64;
    let v = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1) as f64;
    Some(v.sqrt()).filter(|s| s.is_finite())
}

fn ln_ratio(x: f64, base: f64) -> Option<f64> {
    (x > 0.0 && base > 0.0).then(|| (x / base).ln()).filter(|r| r.is_finite())
}

/// Analog years of the latest year in `mo` (statistics months only); `None` with fewer than
/// four complete earlier years or no complete-enough month.
pub fn analogs(mo: &Monthly) -> Option<Analogs> {
    let latest = mo.m_first + mo.latest()? as i32;
    let (year, k) = (year_of(latest), (latest.rem_euclid(12) + 1) as usize);
    let target: [Option<f64>; 12] = std::array::from_fn(|j| if j < k { mo.stat_at(month_index(year, j)) } else { None });
    let cands: Vec<(i32, [f64; 12])> = (year_of(mo.m_first)..year)
        .filter_map(|y| {
            let v: [Option<f64>; 12] = std::array::from_fn(|j| mo.stat_at(month_index(y, j)));
            v.iter().all(Option::is_some).then(|| (y, v.map(|x| x.unwrap_or(0.0))))
        })
        .collect();
    if cands.len() < MIN_CANDIDATES {
        return None;
    }
    let has_rest = k < 12;
    let rest = |v: &[f64; 12]| v[k.min(12)..].iter().sum::<f64>();
    let rests: Vec<f64> = cands.iter().map(|(_, v)| rest(v)).collect();
    let rest_median = if has_rest { median(&sorted(rests.iter().copied())) } else { None };

    let mut scored: Vec<(f64, usize)> =
        cands.iter().enumerate().filter_map(|(c, (_, v))| ln1p_dist(v, &target, k).map(|d| (d, c))).collect();
    if scored.is_empty() {
        return None;
    }
    scored.sort_by(|a, b| a.0.total_cmp(&b.0).then(cands[a.1].0.cmp(&cands[b.1].0)));
    let ratio_of = |c: usize| rest_median.and_then(|m| (m > 0.0).then(|| rests[c] / m)).filter(|r| r.is_finite());
    let top: Vec<AnalogYear> = scored
        .iter()
        .take(TOP)
        .map(|&(distance, c)| {
            let v = &cands[c].1;
            let peak = (k..12).filter(|&j| v[j] > 0.0).max_by(|&a, &b| v[a].total_cmp(&v[b]).then(b.cmp(&a)));
            AnalogYear {
                year: cands[c].0,
                distance,
                rest_total: has_rest.then_some(rests[c]),
                rest_ratio: if has_rest { ratio_of(c) } else { None },
                peak_month: if has_rest { peak.map(|j| j as u32 + 1) } else { None },
            }
        })
        .collect();
    let logs = |idx: &mut dyn Iterator<Item = usize>| -> Vec<f64> {
        idx.filter_map(|c| rest_median.and_then(|m| ln_ratio(rests[c], m))).collect()
    };
    let spread = if has_rest { sd(&logs(&mut scored.iter().take(TOP).map(|p| p.1))) } else { None };
    let clim_spread = if has_rest { sd(&logs(&mut (0..cands.len()))) } else { None };

    let skill = if has_rest && cands.len() >= MIN_SKILL_CANDIDATES { hindcast_skill(&cands, &rests, k) } else { None };
    let informative = skill.is_some_and(|s| s > 0.1) && matches!((spread, clim_spread), (Some(a), Some(b)) if a < b);
    let note = note(&top, skill, informative, has_rest);
    Some(Analogs {
        year,
        through_month: k as u32,
        candidates: cands.len() as u32,
        top,
        rest_median,
        spread,
        clim_spread,
        skill,
        informative,
        note,
    })
}

fn hindcast_skill(cands: &[(i32, [f64; 12])], rests: &[f64], k: usize) -> Option<f64> {
    let (mut sse, mut sst, mut n) = (0.0, 0.0, 0usize);
    for (c, (_, vc)) in cands.iter().enumerate() {
        let others: Vec<usize> = (0..cands.len()).filter(|&o| o != c).collect();
        let Some(med) = median(&sorted(others.iter().map(|&o| rests[o]))) else { continue };
        let Some(act) = ln_ratio(rests[c], med) else { continue };
        let tc: [Option<f64>; 12] = std::array::from_fn(|j| (j < k).then_some(vc[j]));
        let mut near: Vec<(f64, usize)> =
            others.iter().filter_map(|&o| ln1p_dist(&cands[o].1, &tc, k).map(|d| (d, o))).collect();
        near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let preds: Vec<f64> = near.iter().take(TOP).filter_map(|&(_, o)| ln_ratio(rests[o], med)).collect();
        if preds.is_empty() {
            continue;
        }
        let pred = preds.iter().sum::<f64>() / preds.len() as f64;
        sse += (pred - act).powi(2);
        sst += act * act;
        n += 1;
    }
    (n >= MIN_SKILL_CANDIDATES && sst > 0.0).then(|| 1.0 - sse / sst).filter(|s| s.is_finite())
}

fn note(top: &[AnalogYear], skill: Option<f64>, informative: bool, has_rest: bool) -> String {
    let years = top.iter().map(|a| a.year.to_string()).collect::<Vec<_>>().join(", ");
    if !has_rest {
        return format!("Closest complete years: {years}. The year is complete, so there is no rest of year to compare.");
    }
    let ratios: Vec<f64> = top.iter().filter_map(|a| a.rest_ratio).collect();
    let range = match (ratios.iter().copied().reduce(f64::min), ratios.iter().copied().reduce(f64::max)) {
        (Some(a), Some(b)) => format!("their rest of year ran {a:.2}-{b:.2} times the median"),
        _ => "their rest-of-year ratio is undefined (median rest of year is zero)".to_string(),
    };
    let verdict = match (informative, skill) {
        (true, Some(s)) => format!("Analogs have had some skill in this area (hindcast skill {s:.2})."),
        (false, Some(s)) => format!("Analogs have not been informative in this area (hindcast skill {s:.2}); read them as anecdotes."),
        _ => "Too few complete years to test whether analogs are informative here.".to_string(),
    };
    format!("Closest years so far: {years}; {range}. {verdict}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::{Monthly, Source};

    fn monthly(m_first: i32, h: Vec<Option<f64>>) -> Monthly {
        let n = h.len();
        Monthly {
            m_first,
            viirs_start_m: 145,
            source: vec![Source::Modis; n],
            band: vec![None; n],
            meq: h.clone(),
            kv: vec![None; n],
            v: vec![None; n],
            nmod: vec![0.0; n],
            nvii: vec![0.0; n],
            w_modis: vec![None; n],
            madj: h.clone(),
            provisional: vec![false; n],
            partial: vec![false; n],
            modis_full: vec![true; n],
            viirs_full: vec![false; n],
            conformal: false,
            fused: false,
            h,
        }
    }

    #[test]
    fn exact_copy_is_the_top_analog() {
        // 2001..2020 complete years with a varying season, 2021 through July copies 2009.
        let base = |y: i32, k: usize| (1.0 + (k as f64 - 6.0).abs()).recip() * 100.0 * (1.0 + 0.37 * ((y * 7) % 11) as f64);
        let m_first = 12; // 2001-01
        let mut h = Vec::new();
        for y in 2001..=2020 {
            for k in 0..12 {
                h.push(Some(base(y, k)));
            }
        }
        for k in 0..7 {
            h.push(Some(base(2009, k)));
        }
        let a = analogs(&monthly(m_first, h)).unwrap();
        assert_eq!((a.year, a.through_month, a.candidates), (2021, 7, 20));
        assert_eq!(a.top.len(), 3);
        assert_eq!(a.top[0].year, 2009);
        assert!(a.top[0].distance.abs() < 1e-12);
        assert!(a.top.windows(2).all(|w| w[0].distance <= w[1].distance));
        let rest: f64 = (7..12).map(|k| base(2009, k)).sum();
        assert!((a.top[0].rest_total.unwrap() - rest).abs() < 1e-9);
        assert!(a.top[0].rest_ratio.unwrap() > 0.0 && a.rest_median.unwrap() > 0.0);
        assert_eq!(a.top[0].peak_month, Some(8)); // first month after K closest to month index 6
        assert!(a.skill.is_some() && a.spread.is_some() && a.clim_spread.is_some());
        assert!(!a.note.is_empty());
        serde_json::to_string(&a).unwrap();
    }

    #[test]
    fn constant_record_is_not_informative() {
        let h: Vec<Option<f64>> = (0..(12 * 10 + 4)).map(|_| Some(5.0)).collect();
        let a = analogs(&monthly(12, h)).unwrap();
        assert_eq!((a.year, a.through_month), (2011, 4));
        assert_eq!(a.spread, Some(0.0));
        assert_eq!(a.clim_spread, Some(0.0));
        assert!(!a.informative);
        assert_eq!(a.skill, None); // all rest ratios are 1: nothing to explain
        assert!(a.top.iter().all(|t| t.distance == 0.0 && t.rest_ratio == Some(1.0)));
        // Earliest years first on ties.
        assert_eq!(a.top.iter().map(|t| t.year).collect::<Vec<_>>(), vec![2001, 2002, 2003]);
    }

    #[test]
    fn short_records_zero_records_and_december() {
        // Three complete years: too few candidates.
        let h: Vec<Option<f64>> = (0..(12 * 3 + 2)).map(|i| Some(i as f64)).collect();
        assert!(analogs(&monthly(12, h)).is_none());
        // No values at all.
        assert!(analogs(&monthly(12, vec![None; 40])).is_none());
        // All-zero record: defined, finite, rest ratios null (median rest 0).
        let a = analogs(&monthly(12, vec![Some(0.0); 12 * 6 + 3])).unwrap();
        assert!(a.top.iter().all(|t| t.rest_ratio.is_none() && t.peak_month.is_none()));
        assert_eq!((a.spread, a.skill, a.informative), (None, None, false));
        // Latest month is December: no rest of year.
        let h: Vec<Option<f64>> = (0..(12 * 6)).map(|i| Some((i % 12) as f64)).collect();
        let a = analogs(&monthly(12, h)).unwrap();
        assert_eq!((a.year, a.through_month, a.candidates), (2006, 12, 5));
        assert!(a.top.iter().all(|t| t.rest_total.is_none() && t.rest_ratio.is_none()));
        assert_eq!((a.rest_median, a.skill), (None, None));
    }
}
