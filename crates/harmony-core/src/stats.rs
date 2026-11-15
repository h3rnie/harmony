//! Calendar, climatology, annual totals, year-to-date, current month, records and the
//! MODIS/VIIRS seam, all on the harmonized monthly record.
//!
//! The baseline for a calendar month is the set of harmonized values of that month in the
//! baseline years (months without coverage are left out, true zeros are kept).
//!
//! Every statistic uses complete-enough months only ([`Monthly::stat`]): a partial month (its
//! serving stream(s) delivered data on fewer than `meta.complete_min_coverage` = 0.9 of its days,
//! e.g. the month in progress) keeps its calendar value so it can be drawn, but never enters a
//! baseline, rank, ratio, total, YTD, record or the seam.
//!
//! A ratio to normal is reported only when the baseline median is at least
//! [`RATIO_MEDIAN_FLOOR`] AFCD-M: below it the ratio of two small counts is noise ("56× normal"
//! in a desert), and the level is `undefined`.

use serde::Serialize;

use crate::months::{month_index, moy, year_of};
use crate::robust::{self, mad, median, percentile_rank, quantile, robust_z, sorted};
use crate::series::Monthly;

/// Baseline samples per calendar month.
#[derive(Debug, Clone)]
pub struct Baseline {
    years: (i32, i32),
    samples: [Vec<f64>; 12],
    median: [Option<f64>; 12],
    mad: [Option<f64>; 12],
}

impl Baseline {
    pub fn new(mo: &Monthly, years: [i32; 2]) -> Self {
        let years = (years[0].min(years[1]), years[0].max(years[1]));
        let mut samples: [Vec<f64>; 12] = Default::default();
        for i in 0..mo.len() {
            let m = mo.m_first + i as i32;
            if let (Some(v), true) = (mo.stat(i), (years.0..=years.1).contains(&year_of(m))) {
                samples[moy(m)].push(v);
            }
        }
        let samples = samples.map(sorted);
        let median = std::array::from_fn(|k| median(&samples[k]));
        let mad = std::array::from_fn(|k| mad(&samples[k]));
        Baseline { years, samples, median, mad }
    }

    pub fn contains(&self, year: i32) -> bool {
        (self.years.0..=self.years.1).contains(&year)
    }

    pub fn samples(&self, k: usize) -> &[f64] {
        &self.samples[k]
    }

    pub fn median(&self, k: usize) -> Option<f64> {
        self.median[k]
    }

    /// `x / median`, or `None` when the baseline median is below [`RATIO_MEDIAN_FLOOR`].
    pub fn ratio(&self, k: usize, x: f64) -> Option<f64> {
        let med = self.median[k].filter(|m| *m >= RATIO_MEDIAN_FLOOR)?;
        robust::ratio(x, med)
    }

    pub fn percentile(&self, k: usize, x: f64) -> Option<f64> {
        percentile_rank(&self.samples[k], x)
    }

    pub fn z(&self, k: usize, x: f64) -> Option<f64> {
        Some(robust_z(x, self.median[k]?, self.mad[k]?))
    }
}

fn record_years(mo: &Monthly) -> std::ops::RangeInclusive<i32> {
    year_of(mo.m_first)..=year_of(mo.m_last())
}

/// All values of a year, partial months included (for drawing).
fn year_values(mo: &Monthly, year: i32) -> [Option<f64>; 12] {
    std::array::from_fn(|k| mo.h_at(month_index(year, k)))
}

/// Complete-enough values of a year (for statistics).
fn year_stats(mo: &Monthly, year: i32) -> [Option<f64>; 12] {
    std::array::from_fn(|k| mo.stat_at(month_index(year, k)))
}

/// Rank (1 = largest) of `x` among `others` plus itself.
fn rank_desc(x: f64, others: impl IntoIterator<Item = f64>) -> (u32, u32) {
    let (mut above, mut of) = (0u32, 1u32);
    for o in others {
        of += 1;
        if o > x && !robust::approx_eq(o, x) {
            above += 1;
        }
    }
    (above + 1, of)
}

#[derive(Debug, Clone, Serialize)]
pub struct Calendar {
    pub years: Vec<i32>,
    /// Drawn value; partial months keep theirs.
    pub value: Vec<[Option<f64>; 12]>,
    /// Ratio, percentile and z of complete-enough months only (null for partial months).
    pub ratio: Vec<[Option<f64>; 12]>,
    pub percentile: Vec<[Option<f64>; 12]>,
    pub z: Vec<[Option<f64>; 12]>,
    /// The month is partial (in progress or an outage month): drawn, not ranked.
    pub partial: Vec<[bool; 12]>,
}

/// Year × month matrices over the whole record.
pub fn calendar(mo: &Monthly, base: &Baseline) -> Calendar {
    let mut c = Calendar { years: vec![], value: vec![], ratio: vec![], percentile: vec![], z: vec![], partial: vec![] };
    for y in record_years(mo) {
        let vals = year_values(mo, y);
        let stats = year_stats(mo, y);
        let per = |f: &dyn Fn(usize, f64) -> Option<f64>| std::array::from_fn(|k| stats[k].and_then(|x| f(k, x)));
        c.years.push(y);
        c.ratio.push(per(&|k, x| base.ratio(k, x)));
        c.percentile.push(per(&|k, x| base.percentile(k, x)));
        c.z.push(per(&|k, x| base.z(k, x)));
        c.partial.push(std::array::from_fn(|k| vals[k].is_some() && stats[k].is_none()));
        c.value.push(vals);
    }
    c
}

#[derive(Debug, Clone, Serialize)]
pub struct Climatology {
    pub median: Vec<f64>,
    pub mean: Vec<f64>,
    pub q10: Vec<f64>,
    pub q25: Vec<f64>,
    pub q75: Vec<f64>,
    pub q90: Vec<f64>,
    pub min: Vec<f64>,
    pub max: Vec<f64>,
}

/// Baseline quantiles per calendar month (type-7); 0 where the baseline has no values.
pub fn climatology(base: &Baseline) -> Climatology {
    let q = |p: f64| (0..12).map(|k| quantile(base.samples(k), p).unwrap_or(0.0)).collect();
    Climatology {
        median: q(0.5),
        mean: (0..12).map(|k| robust::mean(base.samples(k)).unwrap_or(0.0)).collect(),
        q10: q(0.1),
        q25: q(0.25),
        q75: q(0.75),
        q90: q(0.9),
        min: q(0.0),
        max: q(1.0),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Annual {
    pub years: Vec<i32>,
    /// Sum of the complete-enough months.
    pub total: Vec<Option<f64>>,
    /// All 12 months have a complete-enough value.
    pub complete: Vec<bool>,
    /// 1 = most active complete year; null for incomplete years.
    pub rank: Vec<Option<u32>>,
}

impl Annual {
    /// `(year, total)` of complete years.
    pub fn complete_years(&self) -> Vec<(i32, f64)> {
        self.years
            .iter()
            .zip(&self.total)
            .zip(&self.complete)
            .filter_map(|((&y, t), &c)| if c { t.map(|t| (y, t)) } else { None })
            .collect()
    }
}

pub fn annual(mo: &Monthly) -> Annual {
    let mut a = Annual { years: vec![], total: vec![], complete: vec![], rank: vec![] };
    for y in record_years(mo) {
        let vals = year_stats(mo, y);
        let any = vals.iter().any(Option::is_some);
        a.years.push(y);
        a.total.push(any.then(|| vals.iter().flatten().sum()));
        a.complete.push(vals.iter().all(Option::is_some));
    }
    let complete = a.complete_years();
    a.rank = a
        .total
        .iter()
        .zip(&a.complete)
        .map(|(t, &c)| {
            // Ties share the better rank; the year itself is never "above" itself.
            let t = t.filter(|_| c)?;
            Some(rank_desc(t, complete.iter().map(|p| p.1)).0)
        })
        .collect();
    a
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ytd {
    pub year: i32,
    pub through_month: u32,
    pub current: Vec<f64>,
    pub median: Vec<f64>,
    pub q25: Vec<f64>,
    pub q75: Vec<f64>,
    pub min: Vec<f64>,
    pub max: Vec<f64>,
    pub rank: u32,
    pub of: u32,
    pub ratio: Option<f64>,
}

/// Cumulative sums from January; `None` from the first month without a value.
fn cumulative(vals: &[Option<f64>; 12]) -> [Option<f64>; 12] {
    let mut acc = Some(0.0);
    std::array::from_fn(|k| {
        acc = acc.zip(vals[k]).map(|(a, v)| a + v);
        acc
    })
}

/// Year-to-date through the latest complete-enough month, against baseline envelopes built
/// from years with complete data through each month. Missing months of the current year count
/// as 0 (e.g. a record starting mid-year).
pub fn ytd(mo: &Monthly, base: &Baseline) -> Ytd {
    let latest = mo.latest().map_or(mo.m_last(), |i| mo.m_first + i as i32);
    let (year, through) = (year_of(latest), moy(latest) + 1);
    let mut acc = 0.0;
    let cur_vals = year_stats(mo, year);
    let current: Vec<f64> = cur_vals[..through]
        .iter()
        .map(|v| {
            acc += v.unwrap_or(0.0);
            acc
        })
        .collect();
    let cum: Vec<(i32, [Option<f64>; 12])> =
        record_years(mo).map(|y| (y, cumulative(&year_stats(mo, y)))).collect();
    let env: Vec<Vec<f64>> = (0..12)
        .map(|k| sorted(cum.iter().filter(|(y, _)| base.contains(*y)).filter_map(|(_, c)| c[k])))
        .collect();
    let q = |p: f64| env.iter().map(|s| quantile(s, p).unwrap_or(0.0)).collect::<Vec<_>>();
    let total = current.last().copied().unwrap_or(0.0);
    let others = cum.iter().filter(|(y, _)| *y != year).filter_map(|(_, c)| c[through - 1]);
    let (rank, of) = rank_desc(total, others);
    let ratio = median(&env[through - 1]).and_then(|m| robust::ratio(total, m));
    Ytd {
        year,
        through_month: through as u32,
        current,
        median: q(0.5),
        q25: q(0.25),
        q75: q(0.75),
        min: q(0.0),
        max: q(1.0),
        rank,
        of,
        ratio,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub m: i32,
    pub year: i32,
    pub month: u32,
    pub value: f64,
    pub lo80: Option<f64>,
    pub hi80: Option<f64>,
    pub median: f64,
    pub ratio: Option<f64>,
    pub percentile: Option<f64>,
    pub z: Option<f64>,
    pub rank: u32,
    pub of: u32,
    pub provisional: bool,
    /// `extreme`, `well-above`, `above`, `normal`, `below`, `well-below` ([`LEVELS`]), or
    /// `undefined` (no baseline, or a baseline median below [`RATIO_MEDIAN_FLOOR`]).
    pub level: &'static str,
}

/// Smallest baseline median (AFCD-M, MODIS units) for which a ratio to normal and a level are
/// reported.
pub const RATIO_MEDIAN_FLOOR: f64 = 1.0;

/// Level thresholds `(label, percentile, ratio)`: a month is labelled only when both its rank
/// among the baseline years (percentile) and its size against the median (ratio) agree. Above:
/// percentile ≥ p and ratio ≥ r; below: percentile ≤ p and ratio ≤ r (reciprocal ratios).
/// Checked in this order; anything else is `normal`.
pub const LEVELS: [(&str, f64, f64); 5] = [
    ("extreme", 97.5, 2.0),
    ("well-above", 90.0, 1.5),
    ("above", 75.0, 1.2),
    ("well-below", 10.0, 1.0 / 1.5),
    ("below", 25.0, 1.0 / 1.2),
];

/// Level of a value `x` with baseline percentile `p` against a baseline median `median`
/// (both conditions of [`LEVELS`]). `undefined` when there is no baseline or its median is below
/// [`RATIO_MEDIAN_FLOOR`] (a ratio of tiny counts says nothing).
pub fn level_label(p: Option<f64>, x: f64, median: Option<f64>) -> &'static str {
    let (Some(p), Some(med)) = (p.filter(|p| p.is_finite()), median.filter(|m| m.is_finite())) else {
        return "undefined";
    };
    if med < RATIO_MEDIAN_FLOOR || !x.is_finite() {
        return "undefined";
    }
    let r = x / med;
    for (label, pc, rc) in LEVELS {
        let hit = if rc >= 1.0 { p >= pc && r >= rc } else { p <= pc && r <= rc };
        if hit {
            return label;
        }
    }
    "normal"
}

/// The latest complete-enough month versus its calendar-month baseline.
pub fn current(mo: &Monthly, base: &Baseline) -> Current {
    let i = mo.latest();
    let m = i.map_or(mo.m_last(), |i| mo.m_first + i as i32);
    let k = moy(m);
    let value = i.and_then(|i| mo.h[i]).unwrap_or(0.0);
    let band = i.and_then(|i| mo.band[i]);
    let has = i.is_some();
    let percentile = base.percentile(k, value).filter(|_| has);
    let same_month = record_years(mo)
        .filter(|&y| y != year_of(m))
        .filter_map(|y| mo.stat_at(month_index(y, k)));
    let (rank, of) = if has { rank_desc(value, same_month) } else { (1, 0) };
    Current {
        m,
        year: year_of(m),
        month: k as u32 + 1,
        value,
        lo80: band.map(|b| b[0]),
        hi80: band.map(|b| b[1]),
        median: base.median(k).unwrap_or(0.0),
        ratio: base.ratio(k, value).filter(|_| has),
        percentile,
        z: base.z(k, value).filter(|_| has),
        rank,
        of,
        provisional: i.is_some_and(|i| mo.provisional[i]),
        level: level_label(percentile, value, base.median(k).filter(|_| has)),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TopMonth {
    pub m: i32,
    pub value: f64,
    pub ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TopYear {
    pub year: i32,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Records {
    pub top_months: Vec<TopMonth>,
    pub top_years: Vec<TopYear>,
}

/// Five most active months (any) and complete years; zero activity is not a record.
pub fn records(mo: &Monthly, base: &Baseline, annual: &Annual) -> Records {
    let mut months: Vec<(i32, f64)> = (0..mo.len())
        .filter_map(|i| mo.stat(i).filter(|&v| v > 0.0).map(|v| (mo.m_first + i as i32, v)))
        .collect();
    months.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut years: Vec<(i32, f64)> = annual.complete_years().into_iter().filter(|p| p.1 > 0.0).collect();
    years.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    Records {
        top_months: months
            .into_iter()
            .take(5)
            .map(|(m, value)| TopMonth { m, value, ratio: base.ratio(moy(m), value) })
            .collect(),
        top_years: years.into_iter().take(5).map(|(year, total)| TopYear { year, total }).collect(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seam {
    pub overlap: [i32; 2],
    pub n_months: u32,
    pub ratio_naive: Option<f64>,
    pub ratio_harmonized: Option<f64>,
    pub r: Option<f64>,
    pub bias_pct: Option<f64>,
}

/// Agreement of MODIS-equivalent and calibrated VIIRS over months where both exist with
/// complete-enough coverage. `overlap` is `[0, 0]` when there are none.
pub fn seam(mo: &Monthly) -> Seam {
    let both: Vec<(usize, f64, f64)> = (0..mo.len())
        .filter(|&i| mo.modis_full[i] && mo.viirs_full[i])
        .filter_map(|i| Some((i, mo.meq[i]?, mo.kv[i]?)))
        .collect();
    let (Some(first), Some(last)) = (both.first(), both.last()) else {
        return Seam { overlap: [0, 0], n_months: 0, ratio_naive: None, ratio_harmonized: None, r: None, bias_pct: None };
    };
    let sum = |f: &dyn Fn(&(usize, f64, f64)) -> f64| both.iter().map(f).sum::<f64>();
    let (s_meq, s_kv) = (sum(&|p| p.1), sum(&|p| p.2));
    let (s_nmod, s_nvii) = (sum(&|p| mo.nmod[p.0]), sum(&|p| mo.nvii[p.0]));
    let x: Vec<f64> = both.iter().map(|p| p.1.ln_1p()).collect();
    let y: Vec<f64> = both.iter().map(|p| p.2.ln_1p()).collect();
    Seam {
        overlap: [mo.m_first + first.0 as i32, mo.m_first + last.0 as i32],
        n_months: both.len() as u32,
        ratio_naive: robust::ratio(s_nvii, s_nmod),
        ratio_harmonized: robust::ratio(s_kv, s_meq),
        r: robust::pearson(&x, &y),
        bias_pct: robust::ratio(s_kv - s_meq, s_meq).map(|b| 100.0 * b),
    }
}
