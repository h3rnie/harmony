//! Stateful kernel: meta + AOI + working-level store, and the `analyze` / `cell_layer` entry
//! points. JSON in and out matches `web/src/lib/kernel/types.ts`.

use serde::{Deserialize, Serialize};

use crate::analogs::{self, Analogs};
use crate::cells::{self, CellLayer, CellLayerOptions};
use crate::geom::{tile_keys, Aoi, AoiInfo, CellWeights};
use crate::meta::Meta;
use crate::months::{moy, year_of};
use crate::outlook::{self, Outlook};
use crate::season::{self, Season};
use crate::series::{self, Dn, Lens, Mode, Monthly, Series, Unit};
use crate::stats::{self, Annual, Baseline, Calendar, Climatology, Current, Records, Seam, Ytd};
use crate::store::{Store, TileColumns};
use crate::trend::{self, Trend};
use crate::Error;

/// Longest display range accepted, in months.
const MAX_RANGE_MONTHS: i32 = 1200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeOptions {
    pub switch_m: i32,
    pub baseline: [i32; 2],
    #[serde(default)]
    pub dn: Dn,
    pub range: [i32; 2],
    /// `fused` (default) or `switch`; `switch_m` only matters in switch mode.
    #[serde(default)]
    pub mode: Mode,
    /// Unit of the MODIS-equivalent values: `modis` (default) or `viirs` (the lens).
    #[serde(default)]
    pub unit: Unit,
}

/// How the record in this analysis was built.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Harmonization {
    /// Effective mode: `fused` degrades to `switch` when meta.json has no error model.
    pub mode: Mode,
    pub unit: Unit,
    /// `conformal` when the error model and the conformal table gave the bounds, else `legacy`.
    pub intervals: &'static str,
    /// The 12 calendar-month lens factors (VIIRS lens only).
    pub lens_factor: Option<Vec<f64>>,
    /// Some calendar month had no factor of its own and used a fallback level.
    pub lens_fallback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AoiSummary {
    #[serde(flatten)]
    pub info: AoiInfo,
    pub level: u8,
    pub n_cells: u32,
    pub rows: u32,
}

/// Below this mean annual activity (AFCD-M, baseline years) an area is sparse ...
pub const SPARSE_MIN_ANNUAL: f64 = 10.0;
/// ... or with fewer baseline months that have any activity ...
pub const SPARSE_MIN_NONZERO_MONTHS: u32 = 24;
/// ... or when the MODIS-only years average below this (AFCD-M a year) ...
pub const SPARSE_ERA_FLOOR: f64 = 1.0;
/// ... while the VIIRS years average below this: MODIS saw (almost) nothing and VIIRS sees little,
/// so the ratio of the eras is undefined and a trend would measure VIIRS's small-fire detection.
pub const SPARSE_ERA_VIIRS_MAX: f64 = 20.0;

/// How much fire the area has, and whether its record supports statements about trend, season,
/// analogs and outlook. Always in MODIS-equivalent units (independent of the lens).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Mean annual harmonized activity over the baseline years (sum of the 12 calendar-month means).
    pub mean_annual: f64,
    pub sparse: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Baseline months with any activity, and baseline months in all.
    pub nonzero_months: u32,
    pub baseline_months: u32,
    /// Mean annual total of the complete MODIS-only years (before the VIIRS start year) and of the
    /// complete years after the VIIRS start year; null without such years.
    pub modis_era_mean: Option<f64>,
    pub viirs_era_mean: Option<f64>,
}

/// The newest month of the record when it is partial (data run only part-way through it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    pub m: i32,
    /// Day coverage of the stream(s) drawing it, 0..1.
    pub coverage: f64,
    /// `round(coverage x daysInMonth)`: "first 15 days so far".
    pub days_covered: u32,
    pub days_in_month: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Analysis {
    pub months: Vec<i32>,
    pub series: Series,
    pub calendar: Calendar,
    pub climatology: Climatology,
    pub annual: Annual,
    pub ytd: Ytd,
    pub current: Current,
    pub trend: Trend,
    pub season: Season,
    pub outlook: Outlook,
    pub seam: Seam,
    pub records: Records,
    pub aoi: AoiSummary,
    pub harmonization: Harmonization,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analogs: Option<Analogs>,
    pub activity: Activity,
    #[serde(rename = "inProgress", skip_serializing_if = "Option::is_none")]
    pub in_progress: Option<InProgress>,
}

fn days_in_month(m: i32) -> u32 {
    let (y, k) = (year_of(m), moy(m));
    match k {
        1 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        1 => 28,
        3 | 5 | 8 | 10 => 30,
        _ => 31,
    }
}

/// Activity block and the sparse rule (docs/METHOD.md section 19).
pub fn activity(mo: &Monthly, base: &Baseline, clim: &Climatology, annual: &Annual) -> Activity {
    let mean_annual: f64 = clim.mean.iter().sum();
    let (mut nonzero, mut months) = (0u32, 0u32);
    for k in 0..12 {
        let s = base.samples(k);
        months += s.len() as u32;
        nonzero += s.iter().filter(|v| **v > 0.0).count() as u32;
    }
    let vy = year_of(mo.viirs_start_m);
    let era = |f: &dyn Fn(i32) -> bool| {
        let t: Vec<f64> = annual.complete_years().into_iter().filter(|(y, _)| f(*y)).map(|p| p.1).collect();
        (!t.is_empty()).then(|| t.iter().sum::<f64>() / t.len() as f64)
    };
    let (me, ve) = (era(&|y| y < vy), era(&|y| y > vy));
    let reason = if months == 0 {
        Some("no baseline months".to_string())
    } else if mean_annual < SPARSE_MIN_ANNUAL {
        Some(format!("mean annual activity {mean_annual:.1} AFCD-M is below {SPARSE_MIN_ANNUAL:.0}"))
    } else if nonzero < SPARSE_MIN_NONZERO_MONTHS {
        Some(format!(
            "only {nonzero} of {months} baseline months have any activity (fewer than {SPARSE_MIN_NONZERO_MONTHS})"
        ))
    } else {
        match (me, ve) {
            (Some(a), Some(b)) if a < SPARSE_ERA_FLOOR && b < SPARSE_ERA_VIIRS_MAX => Some(format!(
                "MODIS-only years average {a:.1} AFCD-M a year and VIIRS years {b:.1}: the ratio of the eras is undefined"
            )),
            _ => None,
        }
    };
    Activity {
        mean_annual,
        sparse: reason.is_some(),
        reason,
        nonzero_months: nonzero,
        baseline_months: months,
        modis_era_mean: me,
        viirs_era_mean: ve,
    }
}

/// Every statistic, on the MODIS-equivalent record `mo`: season, percentiles, ranks, levels,
/// analogs, trend direction and significance never depend on the lens.
fn statistics(mo: &Monthly, o: &AnalyzeOptions, range: (i32, i32)) -> Analysis {
    let (months, series) = series::series(mo, range);
    let base = Baseline::new(mo, o.baseline);
    let climatology = stats::climatology(&base);
    let annual = stats::annual(mo);
    let activity = activity(mo, &base, &climatology, &annual);
    let (years, totals): (Vec<i32>, Vec<f64>) = annual.complete_years().into_iter().unzip();
    // Season from the median profile; areas whose median is all zero fall back to the mean.
    let profile = |v: &[f64]| std::array::from_fn::<f64, 12, _>(|k| v.get(k).copied().unwrap_or(0.0));
    let median_profile = profile(&climatology.median);
    let season_profile =
        if median_profile.iter().sum::<f64>() > 0.0 { median_profile } else { profile(&climatology.mean) };
    let mut trend = trend::trend(&years, &totals);
    let mut season = season::season(&season_profile);
    if activity.sparse {
        trend.direction = "none";
        trend.suppressed = true;
        season.defined = false;
    }
    let in_progress = mo.len().checked_sub(1).filter(|&i| mo.partial[i] && mo.h[i].is_some()).map(|i| {
        let m = mo.m_first + i as i32;
        let dim = days_in_month(m);
        let coverage = mo.coverage[i].clamp(0.0, 1.0);
        InProgress { m, coverage, days_covered: (coverage * dim as f64).round() as u32, days_in_month: dim }
    });
    Analysis {
        months,
        series,
        calendar: stats::calendar(mo, &base),
        ytd: stats::ytd(mo, &base),
        current: stats::current(mo, &base),
        trend,
        season,
        // Partial months are left out, so the origin is the latest complete-enough month.
        outlook: outlook::outlook(&mo.stat_values(), mo.m_first, o.baseline, &climatology, !activity.sparse),
        seam: stats::seam(mo),
        records: stats::records(mo, &base, &annual),
        analogs: if activity.sparse { None } else { analogs::analogs(mo) },
        activity,
        in_progress,
        climatology,
        annual,
        // Set by `Engine::analyze`.
        aoi: AoiSummary { info: AoiInfo::default(), level: 0, n_cells: 0, rows: 0 },
        harmonization: Harmonization {
            mode: Mode::Fused,
            unit: Unit::Modis,
            intervals: "legacy",
            lens_factor: None,
            lens_fallback: false,
        },
    }
}

/// Under the lens: the unit-bearing fields (values, bounds, totals, YTD curves, climatology,
/// slopes in AFCD a year, outlook levels, record values, analog rest totals) come from the lensed
/// record `mol`; every rank, percentile, ratio, level, season, trend direction and significance,
/// analog choice and skill stays as computed on the MODIS-equivalent record.
fn relens(a: &mut Analysis, mol: &Monthly, l: &Lens, o: &AnalyzeOptions, range: (i32, i32)) {
    let base_l = Baseline::new(mol, o.baseline);
    a.series = series::series(mol, range).1;
    a.calendar.value = stats::calendar(mol, &base_l).value;
    a.climatology = stats::climatology(&base_l);
    let annual_l = stats::annual(mol);
    let mean = |x: &Annual| {
        let t: Vec<f64> = x.complete_years().into_iter().map(|p| p.1).collect();
        (!t.is_empty()).then(|| t.iter().sum::<f64>() / t.len() as f64)
    };
    // Trend magnitude in lensed units with the same relative slope.
    if let (Some(mm), Some(ml)) = (mean(&a.annual), mean(&annual_l)) {
        let s = if mm > 0.0 { ml / mm } else { 1.0 };
        a.trend.slope_per_year *= s;
        a.trend.lo *= s;
        a.trend.hi *= s;
    }
    a.annual.total = annual_l.total.clone();
    let y = stats::ytd(mol, &base_l);
    (a.ytd.current, a.ytd.median, a.ytd.q25, a.ytd.q75, a.ytd.min, a.ytd.max) = (y.current, y.median, y.q25, y.q75, y.min, y.max);
    let c = stats::current(mol, &base_l);
    (a.current.value, a.current.lo80, a.current.hi80, a.current.median) = (c.value, c.lo80, c.hi80, c.median);
    let fac = |m: i32| {
        let f = l.factor[moy(m)];
        if f.is_finite() && f > 0.0 { f } else { 1.0 }
    };
    let ol = &mut a.outlook;
    for (j, &m) in ol.months.iter().enumerate() {
        let f = fac(m);
        ol.median[j] /= f;
        ol.lo80[j] /= f;
        ol.hi80[j] /= f;
        ol.climatology[j] /= f;
    }
    for t in &mut a.records.top_months {
        t.value = mol.stat_at(t.m).unwrap_or(t.value / fac(t.m));
    }
    for t in &mut a.records.top_years {
        if let Some(i) = annual_l.years.iter().position(|y| *y == t.year) {
            t.total = annual_l.total[i].unwrap_or(t.total);
        }
    }
    if let Some(an) = &mut a.analogs {
        an.rescale_units(mol);
    }
}

#[derive(Debug)]
pub struct Engine {
    meta: Meta,
    aoi: Option<Aoi>,
    /// Weights per level for the current AOI, computed on demand.
    weights: Vec<CellWeights>,
    store: Option<Store>,
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str, what: &str) -> Result<T, Error> {
    serde_json::from_str(json).map_err(|e| Error::new(format!("invalid {what}: {e}")))
}

impl Engine {
    pub fn new(meta_json: &str) -> Result<Self, Error> {
        Ok(Engine { meta: Meta::parse(meta_json)?, aoi: None, weights: Vec::new(), store: None })
    }

    pub fn meta(&self) -> &Meta {
        &self.meta
    }

    /// Replaces the AOI; drops cached weights and ingested rows.
    pub fn set_aoi(&mut self, aoi: Aoi) -> AoiInfo {
        let info = aoi.info().clone();
        self.aoi = Some(aoi);
        self.weights.clear();
        self.store = None;
        info
    }

    pub fn set_aoi_flat(&mut self, coords: &[f64], ring_offsets: &[u32]) -> Result<AoiInfo, Error> {
        Ok(self.set_aoi(Aoi::from_flat(coords, ring_offsets)?))
    }

    fn weights(&mut self, level: u8) -> Result<&CellWeights, Error> {
        let pos = match self.weights.iter().position(|w| w.level == level) {
            Some(pos) => pos,
            None => {
                let aoi = self.aoi.as_ref().ok_or_else(|| Error::new("set an area of interest first"))?;
                self.weights.push(aoi.weights(self.meta.level(level)?)?);
                self.weights.len() - 1
            }
        };
        Ok(&self.weights[pos])
    }

    /// Tile keys `"tx_ty"` holding AOI cells at `level`.
    pub fn tiles_for(&mut self, level: u8) -> Result<Vec<String>, Error> {
        let lm = self.meta.level(level)?.clone();
        Ok(tile_keys(self.weights(level)?, &lm))
    }

    /// Clears ingested rows and fixes the working level.
    pub fn begin(&mut self, level: u8) -> Result<(), Error> {
        let w = self.weights(level)?.clone();
        self.store = Some(Store::new(w));
        Ok(())
    }

    pub fn ingest(&mut self, cols: &TileColumns) -> Result<u32, Error> {
        self.store.as_mut().ok_or_else(|| Error::new("call begin(level) before ingesting tiles"))?.ingest(cols)
    }

    fn store(&self) -> Result<&Store, Error> {
        self.store.as_ref().ok_or_else(|| Error::new("call begin(level) before analysing"))
    }

    pub fn analyze(&self, o: &AnalyzeOptions) -> Result<Analysis, Error> {
        let store = self.store()?;
        let aoi = self.aoi.as_ref().ok_or_else(|| Error::new("set an area of interest first"))?;
        let range = (o.range[0].min(o.range[1]), o.range[0].max(o.range[1]));
        if range.1 - range.0 >= MAX_RANGE_MONTHS {
            return Err(Error::new(format!("display range longer than {MAX_RANGE_MONTHS} months")));
        }
        let meta = &self.meta;
        let mo = series::aggregate(meta, store, o.dn, o.mode, o.switch_m);
        let mut a = statistics(&mo, o, range);
        let lens = (o.unit == Unit::Viirs).then(|| series::lens(&mo, meta.fit_window_m));
        if let Some(l) = &lens {
            let mut mol = mo.clone();
            series::apply_lens(&mut mol, l);
            relens(&mut a, &mol, l, o, range);
        }
        a.harmonization = Harmonization {
            mode: if mo.fused { Mode::Fused } else { Mode::Switch },
            unit: o.unit,
            intervals: if mo.conformal { "conformal" } else { "legacy" },
            lens_factor: lens.as_ref().map(|l| l.factor.to_vec()),
            lens_fallback: lens.as_ref().is_some_and(|l| l.fallback),
        };
        a.aoi = AoiSummary {
            info: aoi.info().clone(),
            level: store.level(),
            n_cells: store.weights.cells.len() as u32,
            rows: store.len() as u32,
        };
        Ok(a)
    }

    pub fn analyze_json(&self, options_json: &str) -> Result<String, Error> {
        let analysis = self.analyze(&parse(options_json, "analyze options")?)?;
        serde_json::to_string(&analysis).map_err(|e| Error::new(format!("could not serialise analysis: {e}")))
    }

    pub fn cell_layer(&self, o: &CellLayerOptions) -> Result<CellLayer, Error> {
        Ok(cells::cell_layer(&self.meta, self.store()?, o))
    }

    pub fn cell_layer_json(&self, options_json: &str) -> Result<CellLayer, Error> {
        self.cell_layer(&parse(options_json, "cell layer options")?)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::months::month_index;

    pub fn meta_json(m_first: i32, m_last: i32) -> String {
        let n = (m_last + 1) as usize;
        let cov: Vec<f64> = (0..n).map(|m| if (m as i32) < m_first { 0.0 } else { 1.0 }).collect();
        let prov: Vec<f64> = (0..n).map(|m| if m + 1 == n { 1.0 } else { 0.0 }).collect();
        serde_json::json!({
            "version": 1, "generated": "x", "data_through": "x",
            "m_first": m_first, "m_last": m_last,
            "levels": [
                { "level": 0, "cell_deg": 0.05, "tile_deg": 2.5, "nx": 7200, "ny": 3600 },
                { "level": 1, "cell_deg": 0.25, "tile_deg": 10, "nx": 1440, "ny": 720 },
                { "level": 2, "cell_deg": 1, "tile_deg": 360, "nx": 360, "ny": 180 }
            ],
            "aqua_start_m": 30, "viirs_start_m": 145, "default_switch_m": 276,
            "fit_window_m": [145, 263],
            "months": { "cov_modis": cov, "cov_viirs": cov, "provisional": prov, "viirs_sats": [] },
            "strata": [
                { "id": 0, "biome": 7, "realm": "NT", "name": "a", "relvar": [0.04, 0.09], "alpha": [0.5, 1.0], "relvar_bridge": [0.01, 0.02], "k": [[], []] },
                { "id": 1, "biome": 1, "realm": "NT", "name": "b", "relvar": [0.02, 0.03], "alpha": [0.2, 0.4], "relvar_bridge": [0.01, 0.01], "k": [[], []] }
            ],
            "ci_scale": 1.1, "method": {}, "sources": []
        })
        .to_string()
    }

    /// Owned columns for building synthetic tiles.
    #[derive(Default)]
    pub struct Cols {
        pub cell: Vec<u32>, pub stratum: Vec<u16>, pub m: Vec<u16>, pub dn: Vec<u8>,
        pub meq: Vec<u32>, pub kv: Vec<u32>, pub kvsq: Vec<f32>, pub v: Vec<u32>,
        pub nmod: Vec<u32>, pub nvii: Vec<u32>,
    }

    impl Cols {
        pub fn view(&self) -> TileColumns<'_> {
            TileColumns {
                cell: &self.cell, stratum: &self.stratum, m: &self.m, dn: &self.dn, meq: &self.meq,
                kv: &self.kv, kvsq: &self.kvsq, v: &self.v, nmod: &self.nmod, nvii: &self.nvii,
            }
        }
    }

    /// Synthetic tile over lon 0..1, lat 0..1 at L0: seasonal cycle, VIIRS raw 4× MODIS.
    fn synthetic(m_first: i32, m_last: i32) -> Cols {
        let mut c = Cols::default();
        for iy in 1800..1820u32 {
            for ix in 3600..3620u32 {
                let cell = iy * 7200 + ix;
                for m in m_first..=m_last {
                    for dn in 0..2u8 {
                        let seasonal = 1.0 + (m as f64 / 12.0 * std::f64::consts::TAU).cos();
                        let base = ((cell % 7) as f64 + 1.0) * seasonal * (1.0 + 0.3 * dn as f64);
                        if base < 0.3 {
                            continue;
                        }
                        let meq = (base * 100.0).round() as u32;
                        c.cell.push(cell);
                        c.stratum.push((ix % 2) as u16);
                        c.m.push(m as u16);
                        c.dn.push(dn);
                        c.meq.push(meq);
                        c.kv.push(if m >= 145 { meq + 7 } else { 0 });
                        c.kvsq.push(if m >= 145 { ((meq + 7) as f32 / 100.0).powi(2) } else { 0.0 });
                        c.v.push(if m >= 145 { 4 * meq } else { 0 });
                        c.nmod.push((base * 2.0).round() as u32);
                        c.nvii.push(if m >= 145 { (base * 8.0).round() as u32 } else { 0 });
                    }
                }
            }
        }
        c
    }

    fn engine_with(aoi: Vec<Vec<[f64; 2]>>, cols: &Cols, m_last: i32) -> Engine {
        let mut e = Engine::new(&meta_json(10, m_last)).unwrap();
        e.set_aoi(Aoi::from_rings(aoi).unwrap());
        e.begin(0).unwrap();
        e.ingest(&cols.view()).unwrap();
        e
    }

    fn opts(range: [i32; 2], dn: Dn) -> AnalyzeOptions {
        AnalyzeOptions { switch_m: 276, baseline: [2003, 2022], dn, range, mode: Mode::Fused, unit: Unit::Modis }
    }

    #[test]
    fn zonal_sums_equal_brute_force() {
        let cols = synthetic(10, 311);
        let ring = vec![[0.012, 0.031], [0.83, 0.07], [0.41, 0.42], [0.77, 0.96], [0.05, 0.71]];
        let e = engine_with(vec![ring.clone()], &cols, 311);
        let aoi = Aoi::from_rings(vec![ring]).unwrap();
        let w = aoi.weights(e.meta().level(0).unwrap()).unwrap();
        for dn in [Dn::Both, Dn::Night] {
            let a = e.analyze(&opts([10, 311], dn)).unwrap();
            for (k, &m) in a.months.iter().enumerate() {
                let (mut meq, mut kv, mut nmod) = (0.0, 0.0, 0.0);
                for r in 0..cols.cell.len() {
                    if cols.m[r] as i32 != m || !dn.accepts(cols.dn[r]) {
                        continue;
                    }
                    if let Ok(i) = w.cells.binary_search(&cols.cell[r]) {
                        let wi = w.weights[i] as f64;
                        meq += wi * cols.meq[r] as f64 / 100.0;
                        kv += wi * cols.kv[r] as f64 / 100.0;
                        nmod += wi * cols.nmod[r] as f64;
                    }
                }
                let expect = if m < 276 { meq } else { kv };
                let got = a.series.harmonized[k].unwrap();
                assert!((got - expect).abs() < 1e-6 * expect.max(1.0), "m {m}: {got} vs {expect}");
                assert!((a.series.raw_modis_count[k] - nmod).abs() < 1e-6 * nmod.max(1.0));
            }
        }
    }

    #[test]
    fn analysis_shapes_and_seam() {
        let cols = synthetic(10, 311);
        let e = engine_with(vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]], &cols, 311);
        let a = e.analyze(&opts([0, 320], Dn::Both)).unwrap();
        assert_eq!(a.months.len(), 321);
        assert_eq!(a.series.harmonized[0], None); // before m_first
        assert_eq!(a.series.harmonized[320], None); // after m_last
        assert_eq!(a.series.source[20], series::Source::Bridge);
        assert!(a.series.lo80[20].is_some() && a.series.lo80[100].is_none() && a.series.lo80[300].is_some());
        assert_eq!(a.calendar.years.len(), 26);
        assert!(a.calendar.value.iter().all(|r| r.len() == 12));
        assert_eq!(a.calendar.value[0][9], None); // 2000-10 not in record
        assert!(a.calendar.value[0][10].is_some());
        assert_eq!(a.aoi.n_cells, 400);
        assert_eq!(a.current.m, 311);
        assert!(a.current.provisional);
        assert_eq!((a.ytd.year, a.ytd.through_month), (2025, 12));
        let seam = &a.seam;
        assert_eq!(seam.overlap, [145, 311]);
        assert!((seam.ratio_naive.unwrap() - 4.0).abs() < 0.05, "{seam:?}");
        assert!((seam.ratio_harmonized.unwrap() - 1.0).abs() < 0.1, "{seam:?}");
        assert!(seam.r.unwrap() > 0.99);
        assert_eq!(a.season.peak_month, 1);
        let json = serde_json::to_string(&a).unwrap();
        assert_no_bad_nulls(&json);
    }

    #[test]
    fn cell_layer_values() {
        let cols = synthetic(10, 311);
        let e = engine_with(vec![vec![[0.0, 0.0], [0.1, 0.0], [0.1, 0.1], [0.0, 0.1]]], &cols, 311);
        let o = CellLayerOptions { m_from: 300, m_to: 302, mode: cells::CellMode::Harmonized, switch_m: 276, baseline: [2003, 2022], dn: Dn::Both, series_mode: Mode::Fused };
        let l = e.cell_layer(&o).unwrap();
        assert_eq!((l.cells.len(), l.weights.len(), l.values.len()), (4, 4, 4));
        let expect: f64 = (0..cols.cell.len())
            .filter(|&r| cols.cell[r] == l.cells[0] && (300..=302).contains(&(cols.m[r] as i32)))
            .map(|r| cols.kv[r] as f64 / 100.0)
            .sum();
        assert!((l.values[0] as f64 - expect).abs() < 1e-3);
        let r = e.cell_layer(&CellLayerOptions { mode: cells::CellMode::Ratio, ..o.clone() }).unwrap();
        assert!(r.values.iter().all(|v| v.is_finite() && *v > 0.5 && *v < 2.0), "{:?}", r.values);
        // Day / night filter: each keeps only its overpass, and they add up to both.
        let only = |dn: Dn| {
            let want = if dn == Dn::Day { 0 } else { 1 };
            (0..cols.cell.len())
                .filter(|&r| cols.cell[r] == l.cells[0] && cols.dn[r] == want && (300..=302).contains(&(cols.m[r] as i32)))
                .map(|r| cols.kv[r] as f64 / 100.0)
                .sum::<f64>()
        };
        let day = e.cell_layer(&CellLayerOptions { dn: Dn::Day, ..o.clone() }).unwrap();
        let night = e.cell_layer(&CellLayerOptions { dn: Dn::Night, ..o.clone() }).unwrap();
        assert!((day.values[0] as f64 - only(Dn::Day)).abs() < 1e-3);
        assert!((night.values[0] as f64 - only(Dn::Night)).abs() < 1e-3);
        assert!(day.values[0] < l.values[0] && night.values[0] < l.values[0]);
        assert!((day.values[0] + night.values[0] - l.values[0]).abs() < 1e-3);
        // The option is optional in JSON (defaults to both) and accepts the AnalyzeOptions spelling.
        let json = r#"{"mFrom":300,"mTo":302,"mode":"harmonized","switchM":276,"baseline":[2003,2022]}"#;
        assert_eq!(e.cell_layer_json(json).unwrap().values, l.values);
        let json = r#"{"mFrom":300,"mTo":302,"mode":"harmonized","switchM":276,"baseline":[2003,2022],"dn":"night"}"#;
        assert_eq!(e.cell_layer_json(json).unwrap().values, night.values);
        let out = e.cell_layer(&CellLayerOptions { m_from: 400, m_to: 410, ..o }).unwrap();
        assert!(out.values.iter().all(|v| v.is_nan()));
    }

    /// Walks the JSON and fails on a null outside the fields types.ts declares nullable.
    pub fn assert_no_bad_nulls(json: &str) {
        const NULLABLE: &[&str] = &[
            "series.harmonized", "series.lo80", "series.hi80", "series.lo95", "series.hi95",
            "series.modisEq", "series.viirsCal", "series.viirsRaw", "calendar.value", "calendar.ratio",
            "calendar.percentile", "calendar.z", "annual.total", "annual.rank", "ytd.ratio",
            "current.lo80", "current.hi80", "current.ratio", "current.percentile", "current.z",
            "season.secondPeak", "seam.ratioNaive", "seam.ratioHarmonized", "seam.r", "seam.biasPct",
            "records.topMonths.ratio", "series.modisWeight", "series.modisAdj",
            "harmonization.lensFactor", "analogs.restMedian", "analogs.spread", "analogs.climSpread",
            "analogs.skill", "analogs.top.restTotal", "analogs.top.restRatio", "analogs.top.peakMonth",
            "activity.modisEraMean", "activity.viirsEraMean",
        ];
        fn walk(v: &serde_json::Value, path: &str) {
            match v {
                serde_json::Value::Null => assert!(NULLABLE.contains(&path), "unexpected null at {path}"),
                serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, path)),
                serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| {
                    walk(x, &if path.is_empty() { k.clone() } else { format!("{path}.{k}") })
                }),
                _ => {}
            }
        }
        walk(&serde_json::from_str(json).unwrap(), "");
    }

    #[test]
    fn zero_fire_rows_one_month_and_zero_baselines_are_valid() {
        let square = vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]];
        // No rows at all: covered months are true zeros.
        let e = engine_with(square.clone(), &Cols::default(), 311);
        let a = e.analyze(&opts([10, 311], Dn::Day)).unwrap();
        assert_eq!(a.series.harmonized[5], Some(0.0));
        assert_eq!(a.current.ratio, None);
        assert_eq!(a.current.level, "undefined", "a zero median has no level");
        assert!(a.activity.sparse && a.trend.suppressed && !a.season.defined && a.analogs.is_none());
        assert_eq!(a.trend.p_value, 1.0);
        assert_eq!(a.outlook.method, "climatology");
        assert!(a.records.top_months.is_empty());
        assert_eq!(a.seam.ratio_naive, None);
        assert_no_bad_nulls(&e.analyze_json(r#"{"switchM":276,"baseline":[2003,2022],"dn":"both","range":[10,311]}"#).unwrap());

        // One-month record.
        let mut one = Engine::new(&meta_json(200, 200)).unwrap();
        one.set_aoi(Aoi::from_rings(square.clone()).unwrap());
        one.begin(0).unwrap();
        let cols = synthetic(200, 200);
        one.ingest(&cols.view()).unwrap();
        let json = one.analyze_json(r#"{"switchM":276,"baseline":[2003,2022],"dn":"both","range":[190,210]}"#).unwrap();
        assert_no_bad_nulls(&json);
        let a = one.analyze(&opts([200, 200], Dn::Both)).unwrap();
        assert_eq!(a.annual.complete, vec![false]);
        assert_eq!(a.ytd.through_month, 9);

        // Fire only after the baseline: all-zero baselines.
        let mut late = synthetic(300, 311);
        late.m.iter_mut().for_each(|m| *m = (*m).max(300));
        let e = engine_with(square, &late, 311);
        let a = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        assert_eq!(a.current.ratio, None);
        assert!(a.current.z.unwrap().is_finite());
        assert_eq!(a.current.level, "undefined", "a zero baseline median gives no ratio and no level");
        assert!(a.current.percentile.unwrap() > 97.5);
        assert_no_bad_nulls(&serde_json::to_string(&a).unwrap());
    }

    #[test]
    fn partial_latest_month_is_drawn_but_never_drives_a_statistic() {
        let square = vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]];
        let cols = synthetic(10, 312);
        // Reference: the record ends at 311 (Dec 2025).
        let full = engine_with(square.clone(), &cols, 311);
        // Same rows, record through 312 (Jan 2026) whose VIIRS coverage is 0.3 (MODIS full).
        let mut meta: serde_json::Value = serde_json::from_str(&meta_json(10, 312)).unwrap();
        meta["months"]["cov_viirs"][312] = serde_json::json!(0.3);
        let mut e = Engine::new(&meta.to_string()).unwrap();
        e.set_aoi(Aoi::from_rings(square).unwrap());
        e.begin(0).unwrap();
        e.ingest(&cols.view()).unwrap();

        let (r, a) = (full.analyze(&opts([10, 312], Dn::Both)).unwrap(), e.analyze(&opts([10, 312], Dn::Both)).unwrap());
        let last = a.months.len() - 1;
        assert!(a.series.harmonized[last].is_some(), "partial month is still drawn");
        assert_eq!(a.series.source[last], series::Source::Viirs);
        assert!(a.series.partial[last] && !a.series.partial[last - 1]);
        assert!(a.calendar.value[26][0].is_some(), "calendar keeps the partial value");
        assert_eq!(a.current.m, 311);
        assert_eq!((a.current.value, a.current.percentile, a.current.rank, a.current.of), (r.current.value, r.current.percentile, r.current.rank, r.current.of));
        assert_eq!(a.current.level, r.current.level);
        assert_eq!((a.ytd.year, a.ytd.through_month, a.ytd.rank, a.ytd.of), (2025, 12, r.ytd.rank, r.ytd.of));
        assert_eq!(a.outlook.months, vec![312, 313, 314]);
        assert_eq!(a.outlook.median, r.outlook.median);
        assert_eq!(a.annual.total[26], None);
        assert!(!a.annual.complete[26] && a.annual.rank[26].is_none());
        assert_eq!((a.trend.slope_per_year, a.trend.years), (r.trend.slope_per_year, r.trend.years));
        let tops = |x: &Analysis| x.records.top_months.iter().map(|t| (t.m, t.value)).collect::<Vec<_>>();
        assert_eq!(tops(&a), tops(&r));
        assert_eq!((a.seam.overlap, a.seam.n_months), (r.seam.overlap, r.seam.n_months));
        assert_eq!(a.climatology.median, r.climatology.median);
        assert_no_bad_nulls(&serde_json::to_string(&a).unwrap());

        // Served by MODIS (switch after the month), whose coverage is full: a normal month.
        let late = e.analyze(&AnalyzeOptions { switch_m: 400, ..opts([10, 312], Dn::Both) }).unwrap();
        assert!(!late.series.partial[last]);
        assert_eq!(late.current.m, 312);
        // Half a month (coverage 0.5, the November 2026 case) is in progress: drawn, never ranked.
        let at = |cov: f64| {
            let mut meta = meta.clone();
            meta["months"]["cov_viirs"][312] = serde_json::json!(cov);
            let mut e = Engine::new(&meta.to_string()).unwrap();
            e.set_aoi(Aoi::from_rings(vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]).unwrap());
            e.begin(0).unwrap();
            e.ingest(&cols.view()).unwrap();
            e.analyze(&opts([10, 312], Dn::Both)).unwrap()
        };
        let half = at(0.5);
        assert_eq!(half.current.m, 311);
        assert!(half.series.partial[last]);
        let ip = half.in_progress.as_ref().expect("in progress");
        assert_eq!((ip.m, ip.days_covered, ip.days_in_month), (312, 16, 31));
        assert!((ip.coverage - 0.5).abs() < 1e-12);
        assert!(half.calendar.partial[26][0] && half.calendar.value[26][0].is_some());
        assert_eq!((half.calendar.ratio[26][0], half.calendar.percentile[26][0], half.calendar.z[26][0]), (None, None, None));
        assert!(!half.calendar.partial[25][11] && half.calendar.percentile[25][11].is_some());
        // From the shared threshold (meta.complete_min_coverage, default 0.9) the month counts.
        assert_eq!(at(0.9).current.m, 312);
        assert!(at(0.9).in_progress.is_none());
        assert_eq!(at(0.89).current.m, 311);
        // The threshold is read from meta.json.
        let mut lower = meta.clone();
        lower["complete_min_coverage"] = serde_json::json!(0.4);
        lower["months"]["cov_viirs"][312] = serde_json::json!(0.5);
        let mut e = Engine::new(&lower.to_string()).unwrap();
        e.set_aoi(Aoi::from_rings(vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]).unwrap());
        e.begin(0).unwrap();
        e.ingest(&cols.view()).unwrap();
        assert_eq!(e.analyze(&opts([10, 312], Dn::Both)).unwrap().current.m, 312);
    }

    #[test]
    fn errors_are_readable() {
        assert!(Engine::new("{").unwrap_err().0.starts_with("invalid meta.json"));
        let mut e = Engine::new(&meta_json(10, 311)).unwrap();
        assert!(e.begin(0).unwrap_err().0.contains("area of interest"));
        assert!(e.analyze_json("{}").is_err());
        e.set_aoi_flat(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0], &[0]).unwrap();
        assert!(e.tiles_for(9).unwrap_err().0.contains("unknown level"));
        assert_eq!(e.tiles_for(1).unwrap(), vec!["18_9"]);
        e.begin(0).unwrap();
        let mut bad = Cols::default();
        bad.cell.push(1);
        assert!(e.ingest(&bad.view()).unwrap_err().0.contains("differ in length"));
        assert!(e.analyze_json(r#"{"switchM":1,"baseline":[2003,2022],"dn":"sideways","range":[0,1]}"#).is_err());
        assert_eq!(month_index(2023, 0), 276);
    }

    #[test]
    fn analyze_two_million_rows_is_fast() {
        // ~2.1 M rows: 3500 cells × 302 months × 2 dn.
        let mut c = Cols::default();
        for k in 0..3500u32 {
            let cell = (1800 + k / 70) * 7200 + 3600 + k % 70;
            for m in 10..=311u16 {
                for dn in 0..2u8 {
                    c.cell.push(cell);
                    c.stratum.push((k % 3) as u16);
                    c.m.push(m);
                    c.dn.push(dn);
                    c.meq.push(100 + (m as u32 % 12) * 10);
                    c.kv.push(if m >= 145 { 110 } else { 0 });
                    c.kvsq.push(1.21);
                    c.v.push(400);
                    c.nmod.push(2);
                    c.nvii.push(8);
                }
            }
        }
        let e = engine_with(vec![vec![[0.0, 0.0], [3.5, 0.0], [3.5, 3.5], [0.0, 3.5]]], &c, 311);
        let t0 = std::time::Instant::now();
        let json = e.analyze_json(r#"{"switchM":276,"baseline":[2003,2022],"dn":"both","range":[10,311]}"#).unwrap();
        let dt = t0.elapsed();
        eprintln!("analyze over {} rows: {:?} ({} bytes)", e.store().unwrap().len(), dt, json.len());
        assert_eq!(e.store().unwrap().len(), c.cell.len());
    }

    /// `meta_json` plus the harmonization blocks: error model, common mode, drift from 2020
    /// (biome 7 with its own factors, others via `all`), conformal table.
    pub fn model_meta_json(m_first: i32, m_last: i32) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&meta_json(m_first, m_last)).unwrap();
        let n = (m_last + 1) as usize;
        let sats: Vec<u32> = (0..n).map(|m| if m < 145 { 0 } else if m < 220 { 1 } else if m < 280 { 3 } else { 7 }).collect();
        v["months"]["viirs_sats"] = serde_json::json!(sats);
        let err = |s: f64| serde_json::json!({
            "modis": { "rho": [0.01 * s, 0.02 * s], "phi": [1.2, 1.5] },
            "bridge": { "rho": [0.03 * s, 0.04 * s], "phi": [2.0, 2.5] },
            "viirs": { "rho": [[0.02, 0.03], [0.015, 0.02], [0.012, 0.018]], "phi": [[0.8, 0.9], [0.6, 0.7], [0.5, 0.6]] }
        });
        v["strata"][0]["err"] = err(1.0);
        v["strata"][1]["err"] = err(2.0);
        v["fusion"] = serde_json::json!({ "kappa": [0.3, 0.2] });
        v["drift"] = serde_json::json!({
            "ref_years": [2012, 2019], "start_year": 2020, "years": [2020, 2021, 2022, 2023, 2024, 2025],
            "attr_frac": 0.5,
            "biome": {
                "7": { "log_f": [[0.0, 0.02, 0.05, 0.08, 0.1, 0.12], [0.0, -0.01, -0.03, -0.05, -0.06, -0.08]],
                       "log_sd": [[0.01, 0.01, 0.02, 0.02, 0.03, 0.03], [0.02, 0.02, 0.02, 0.03, 0.03, 0.04]] },
                "all": { "log_f": [[0.0, 0.0, 0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]],
                         "log_sd": [[0.01, 0.01, 0.01, 0.01, 0.01, 0.01], [0.01, 0.01, 0.01, 0.01, 0.01, 0.01]] }
            }
        });
        v["conformal"] = serde_json::json!({
            "size_edges": [5, 20, 100, 1000],
            "groups": [{ "name": "savanna", "biomes": [7] }, { "name": "forest", "biomes": [1, 2] }],
            "q80": [[1.4, 1.5, 1.6, 1.7, 1.8], [1.3, 1.35, 1.4, 1.45, 1.5]],
            "q95": [[2.2, 2.4, 2.6, 2.8, 3.0], [2.0, 2.1, 2.2, 2.3, 2.4]],
            "n": [[500, 500, 500, 500, 500], [500, 500, 500, 500, 500]],
            "global": { "q80": [1.35, 1.45, 1.55, 1.65, 1.75], "q95": [2.1, 2.3, 2.5, 2.7, 2.9], "n": [1, 1, 1, 1, 1] }
        });
        v.to_string()
    }

    fn engine_meta(meta: &str, aoi: Vec<Vec<[f64; 2]>>, cols: &Cols) -> Engine {
        let mut e = Engine::new(meta).unwrap();
        e.set_aoi(Aoi::from_rings(aoi).unwrap());
        e.begin(0).unwrap();
        e.ingest(&cols.view()).unwrap();
        e
    }

    fn square() -> Vec<Vec<[f64; 2]>> {
        vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
    }

    #[test]
    fn legacy_meta_fused_equals_switch_and_old_record() {
        let cols = synthetic(10, 311);
        let e = engine_with(square(), &cols, 311);
        let f = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        let s = e.analyze(&AnalyzeOptions { mode: Mode::Switch, ..opts([10, 311], Dn::Both) }).unwrap();
        assert_eq!(serde_json::to_string(&f.series).unwrap(), serde_json::to_string(&s.series).unwrap());
        assert_eq!(f.harmonization.mode, Mode::Switch);
        assert_eq!(f.harmonization.intervals, "legacy");
        // Legacy: native MODIS months have no interval; MODIS weight is 1, then 0 after the switch.
        let i = |m: i32| (m - 10) as usize;
        assert!(f.series.lo80[i(100)].is_none() && f.series.lo80[i(20)].is_some() && f.series.lo80[i(300)].is_some());
        assert_eq!((f.series.modis_weight[i(100)], f.series.modis_weight[i(300)]), (Some(1.0), Some(0.0)));
        assert_eq!(f.series.modis_adj[i(300)], f.series.modis_eq[i(300)]);
    }

    #[test]
    fn fused_series_has_bounds_everywhere_and_sits_between_streams() {
        let cols = synthetic(10, 311);
        let e = engine_meta(&model_meta_json(10, 311), square(), &cols);
        let a = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        assert_eq!((a.harmonization.mode, a.harmonization.intervals), (Mode::Fused, "conformal"));
        let s = &a.series;
        for (k, &m) in a.months.iter().enumerate() {
            let h = s.harmonized[k].unwrap();
            assert!(s.lo95[k].unwrap() <= s.lo80[k].unwrap() && s.lo80[k].unwrap() <= h);
            assert!(h <= s.hi80[k].unwrap() && s.hi80[k].unwrap() <= s.hi95[k].unwrap());
            let Some(w) = s.modis_weight[k] else {
                assert_eq!(h, 0.0, "m {m}: the weight is null only for an empty month");
                continue;
            };
            assert!((0.0..=1.0).contains(&w));
            if m < 145 {
                assert_eq!(w, 1.0);
                assert_eq!(s.harmonized[k], s.modis_eq[k]);
                assert_eq!(s.source[k], if m < 30 { series::Source::Bridge } else { series::Source::Modis });
            } else {
                let (mo, vi) = (s.modis_adj[k].unwrap(), s.viirs_cal[k].unwrap());
                assert!(h >= mo.min(vi) - 1e-9 && h <= mo.max(vi) + 1e-9, "m {m}: {h} not in [{mo}, {vi}]");
                assert!(w > 0.0 && w < 1.0, "m {m}: w {w}");
            }
            if m < 240 {
                assert_eq!(s.modis_adj[k], s.modis_eq[k], "no drift correction before 2020");
            }
        }
        assert_no_bad_nulls(&serde_json::to_string(&a).unwrap());
        // Switch mode with the error model: the old record, now with bounds on MODIS months too.
        let sw = e.analyze(&AnalyzeOptions { mode: Mode::Switch, ..opts([10, 311], Dn::Both) }).unwrap();
        let old = engine_with(square(), &cols, 311).analyze(&opts([10, 311], Dn::Both)).unwrap();
        assert_eq!(sw.series.harmonized, old.series.harmonized);
        assert_eq!(sw.series.source, old.series.source);
        assert!(sw.series.lo80.iter().all(Option::is_some));
        assert_eq!(sw.series.modis_adj, sw.series.modis_eq, "switch mode never drift-corrects");
        assert_eq!(sw.harmonization.mode, Mode::Switch);
    }

    #[test]
    fn group_fusion_and_conformal_q_hand_checked() {
        // One L0 cell (stratum 0, biome 7), day only; months 200 (2016-09) and 250 (2020-11).
        let mut c = Cols::default();
        let cell = 1800 * 7200 + 3600;
        for (m, meq, kv) in [(200u16, 4000u32, 6000u32), (250, 4000, 6000)] {
            c.cell.push(cell);
            c.stratum.push(0);
            c.m.push(m);
            c.dn.push(0);
            c.meq.push(meq);
            c.kv.push(kv);
            c.kvsq.push(3600.0);
            c.v.push(4 * kv);
            c.nmod.push(80);
            c.nvii.push(300);
        }
        let meta = model_meta_json(10, 311);
        let e = engine_meta(&meta, vec![vec![[0.0, 0.0], [0.05, 0.0], [0.05, 0.05], [0.0, 0.05]]], &c);
        let a = e.analyze(&opts([200, 250], Dn::Both)).unwrap();
        let mt = Meta::parse(&meta).unwrap();
        let p = &mt.strata[0];
        // Month 250: drift index 0 (log_f 0, sd 0.01) -> rho_M = 0.01 + 0.0001; two VIIRS satellites.
        let pl = series::plan(&mt, 250, Mode::Fused, 276, true);
        assert_eq!((pl.drift_idx, pl.era, pl.use_m, pl.use_v), (Some(0), 1, true, true));
        let sm = series::StreamVar { rho: 0.01 + 0.0001, phi: 1.2 };
        let sv = series::StreamVar { rho: 0.015 + 0.04, phi: 0.6 };
        let c_rho = 0.3 * (0.01f64 * 0.015).sqrt() + 0.04; // common mode + shared calibration floor
        let f = series::fuse(40.0, 60.0, sm, sv, c_rho);
        let g = series::estimate(&mt, &pl, p, 0, 40.0, 60.0);
        assert!((g.h - f.h).abs() < 1e-12 && (g.var - f.var).abs() < 1e-12 && (g.w - f.w).abs() < 1e-12);
        let k = 50;
        assert!((a.series.harmonized[k].unwrap() - f.h).abs() < 1e-9);
        assert!((a.series.modis_weight[k].unwrap() - f.w).abs() < 1e-9);
        // H in [20, 100) -> class 2, biome 7 -> group 0: q80 1.6, q95 2.6.
        assert!(f.h >= 20.0 && f.h < 100.0);
        let b = series::bounds_shifted(f.h, f.var, 1.6, 2.6);
        assert!((a.series.lo80[k].unwrap() - b[0]).abs() < 1e-9 && (a.series.hi95[k].unwrap() - b[3]).abs() < 1e-9);
        // Month 200: no drift, one VIIRS satellite, no shared calibration floor.
        let pl = series::plan(&mt, 200, Mode::Fused, 276, true);
        assert_eq!((pl.drift_idx, pl.era), (None, 0));
        let f = series::fuse(40.0, 60.0, series::StreamVar { rho: 0.01, phi: 1.2 },
            series::StreamVar { rho: 0.02 + 0.04, phi: 0.8 }, 0.3 * (0.01f64 * 0.02).sqrt());
        assert!((a.series.harmonized[0].unwrap() - f.h).abs() < 1e-9);
        // An empty covered month: zero, a degenerate interval from the global row, no weight.
        assert_eq!(a.series.harmonized[1], Some(0.0));
        assert_eq!((a.series.lo80[1], a.series.modis_weight[1]), (Some(0.0), None));
    }

    #[test]
    fn drift_correction_from_start_year_and_only_when_fused() {
        let cols = synthetic(10, 311);
        let e = engine_meta(&model_meta_json(10, 311), square(), &cols);
        let a = e.analyze(&opts([10, 311], Dn::Day)).unwrap();
        let i = |m: i32| (m - 10) as usize;
        for m in [239, 240, 260, 300, 311] {
            let (adj, raw) = (a.series.modis_adj[i(m)].unwrap(), a.series.modis_eq[i(m)].unwrap());
            if m < 240 {
                assert_eq!(adj, raw);
            } else if m >= 252 {
                assert!(adj < raw, "m {m}: a positive day log_f lowers MODIS ({adj} vs {raw})");
            }
        }
        // 2025 (index 5, log_f 0.12) for stratum-0 rows only: the exact factor.
        let mut c0 = Cols::default();
        for r in 0..cols.cell.len() {
            if cols.stratum[r] == 0 && cols.m[r] == 300 && cols.dn[r] == 0 {
                c0.cell.push(cols.cell[r]);
                c0.stratum.push(0);
                c0.m.push(300);
                c0.dn.push(0);
                c0.meq.push(cols.meq[r]);
                c0.kv.push(cols.kv[r]);
                c0.kvsq.push(cols.kvsq[r]);
                c0.v.push(cols.v[r]);
                c0.nmod.push(cols.nmod[r]);
                c0.nvii.push(cols.nvii[r]);
            }
        }
        let e0 = engine_meta(&model_meta_json(10, 311), square(), &c0);
        let a0 = e0.analyze(&opts([300, 300], Dn::Day)).unwrap();
        let (adj, raw) = (a0.series.modis_adj[0].unwrap(), a0.series.modis_eq[0].unwrap());
        assert!((adj - raw * (-0.12f64).exp()).abs() < 1e-9 * raw, "{adj} vs {raw}");
        let s0 = e0.analyze(&AnalyzeOptions { mode: Mode::Switch, ..opts([300, 300], Dn::Day) }).unwrap();
        assert_eq!(s0.series.modis_adj[0], s0.series.modis_eq[0]);
    }

    #[test]
    fn lens_keeps_calendar_ratios_percentiles_and_ranks() {
        let cols = synthetic(10, 311);
        let e = engine_meta(&model_meta_json(10, 311), square(), &cols);
        let m = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        let v = e.analyze(&AnalyzeOptions { unit: Unit::Viirs, ..opts([10, 311], Dn::Both) }).unwrap();
        let f = v.harmonization.lens_factor.clone().unwrap();
        // July has no fire in the synthetic record: it takes the pooled fit-window factor.
        assert!(v.harmonization.lens_fallback && f.iter().all(|x| *x > 0.0 && x.is_finite()));
        assert!(f.iter().any(|x| (x - f[0]).abs() > 1e-6), "synthetic factors vary by calendar month");
        let close = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * a.abs().max(1.0),
            (None, None) => true,
            _ => false,
        };
        for (y, (rm, rv)) in m.calendar.ratio.iter().zip(&v.calendar.ratio).enumerate() {
            for k in 0..12 {
                assert!(close(rm[k], rv[k]), "ratio {y} {k}");
                assert!(close(m.calendar.percentile[y][k], v.calendar.percentile[y][k]), "percentile {y} {k}");
                if let (Some(a), Some(b)) = (m.calendar.value[y][k], v.calendar.value[y][k]) {
                    assert!((a / f[k] - b).abs() < 1e-9 * a.max(1.0));
                }
            }
        }
        let (cm, cv) = (&m.current, &v.current);
        assert!(close(cm.ratio, cv.ratio) && close(cm.percentile, cv.percentile));
        assert_eq!((cm.rank, cm.of, cm.level), (cv.rank, cv.of, cv.level));
        let k = (cm.month - 1) as usize;
        assert!((cm.value / f[k] - cv.value).abs() < 1e-9 * cm.value.max(1.0));
        assert!((cm.hi80.unwrap() / f[k] - cv.hi80.unwrap()).abs() < 1e-9 * cm.hi80.unwrap().max(1.0));
        assert_eq!(m.harmonization.lens_factor, None);

        // A constant factor (v = 4 kv everywhere) also keeps annual ranks, the YTD ratio, records,
        // the trend in % per year and the season.
        let mut c4 = synthetic(10, 311);
        c4.v.iter_mut().zip(&c4.kv).for_each(|(v, kv)| *v = 4 * *kv);
        let e = engine_meta(&model_meta_json(10, 311), square(), &c4);
        let m = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        let v = e.analyze(&AnalyzeOptions { unit: Unit::Viirs, ..opts([10, 311], Dn::Both) }).unwrap();
        assert!(v.harmonization.lens_factor.clone().unwrap().iter().all(|x| (x - 0.25).abs() < 1e-12));
        assert_eq!(m.annual.rank, v.annual.rank);
        assert!(close(m.ytd.ratio, v.ytd.ratio));
        assert_eq!((m.ytd.rank, m.ytd.of), (v.ytd.rank, v.ytd.of));
        let order = |a: &Analysis| a.records.top_months.iter().map(|t| t.m).collect::<Vec<_>>();
        assert_eq!(order(&m), order(&v));
        assert!((m.trend.slope_pct_per_year - v.trend.slope_pct_per_year).abs() < 1e-9);
        assert_eq!(m.season, v.season);
    }

    #[test]
    fn lens_fallbacks() {
        // No VIIRS rows at all: factor 1, flagged.
        let mut c = synthetic(10, 311);
        c.kv.iter_mut().for_each(|x| *x = 0);
        c.v.iter_mut().for_each(|x| *x = 0);
        let e = engine_meta(&model_meta_json(10, 311), square(), &c);
        let v = e.analyze(&AnalyzeOptions { unit: Unit::Viirs, ..opts([10, 311], Dn::Both) }).unwrap();
        assert!(v.harmonization.lens_fallback);
        assert_eq!(v.harmonization.lens_factor.clone().unwrap(), vec![1.0; 12]);
        assert_no_bad_nulls(&serde_json::to_string(&v).unwrap());
    }

    #[test]
    fn model_meta_degenerate_inputs_never_produce_nan() {
        let sq = square();
        let mut meta: serde_json::Value = serde_json::from_str(&model_meta_json(10, 311)).unwrap();
        meta["strata"][0]["err"] = serde_json::json!({ "modis": {}, "viirs": { "rho": [[null, "x"]] } });
        meta["strata"][1]["relvar"] = serde_json::json!([0, 0]);
        meta["fusion"]["kappa"] = serde_json::json!([-1, 1e308]);
        meta["conformal"]["q80"] = serde_json::json!([[0, -1]]);
        let meta = meta.to_string();
        for cols in [Cols::default(), synthetic(10, 311)] {
            let e = engine_meta(&meta, sq.clone(), &cols);
            for mode in [Mode::Fused, Mode::Switch] {
                for unit in [Unit::Modis, Unit::Viirs] {
                    let o = AnalyzeOptions { mode, unit, ..opts([0, 330], Dn::Both) };
                    let json = serde_json::to_string(&e.analyze(&o).unwrap()).unwrap();
                    // serde_json writes non-finite floats as null, which assert_no_bad_nulls rejects.
                    assert_no_bad_nulls(&json);
                }
            }
            let l = e.cell_layer(&CellLayerOptions { m_from: 250, m_to: 260, mode: cells::CellMode::Harmonized,
                switch_m: 276, baseline: [2003, 2022], dn: Dn::Both, series_mode: Mode::Fused }).unwrap();
            assert!(l.values.iter().all(|v| v.is_finite()));
        }
        let mut one = Engine::new(&model_meta_json(200, 200)).unwrap();
        one.set_aoi(Aoi::from_rings(sq).unwrap());
        one.begin(0).unwrap();
        one.ingest(&synthetic(200, 200).view()).unwrap();
        let json = one.analyze_json(r#"{"switchM":276,"baseline":[2003,2022],"dn":"both","range":[190,210],"mode":"fused","unit":"viirs"}"#).unwrap();
        assert_no_bad_nulls(&json);
        assert!(one.analyze_json(r#"{"switchM":276,"baseline":[2003,2022],"range":[0,1],"mode":"blend"}"#).is_err());
    }

    #[test]
    fn cell_layer_fused_rows() {
        let cols = synthetic(10, 311);
        let meta = model_meta_json(10, 311);
        let e = engine_meta(&meta, vec![vec![[0.0, 0.0], [0.1, 0.0], [0.1, 0.1], [0.0, 0.1]]], &cols);
        let o = CellLayerOptions { m_from: 260, m_to: 262, mode: cells::CellMode::Harmonized, switch_m: 276,
            baseline: [2003, 2022], dn: Dn::Both, series_mode: Mode::Fused };
        let l = e.cell_layer(&o).unwrap();
        let mt = Meta::parse(&meta).unwrap();
        let rows = || (0..cols.cell.len()).filter(|&r| cols.cell[r] == l.cells[0] && (260..=262).contains(&(cols.m[r] as i32)));
        let expect: f64 = rows()
            .map(|r| {
                let pl = series::plan(&mt, cols.m[r] as i32, Mode::Fused, 276, true);
                let p = &mt.strata[cols.stratum[r] as usize];
                series::estimate(&mt, &pl, p, cols.dn[r] as usize, cols.meq[r] as f64 / 100.0, cols.kv[r] as f64 / 100.0).h
            })
            .sum();
        assert!((l.values[0] as f64 - expect).abs() < 1e-3, "{} vs {expect}", l.values[0]);
        // Switch mode: the stream at the switch (MODIS before 276).
        let s = e.cell_layer(&CellLayerOptions { series_mode: Mode::Switch, ..o.clone() }).unwrap();
        let meq: f64 = rows().map(|r| cols.meq[r] as f64 / 100.0).sum();
        assert!((s.values[0] as f64 - meq).abs() < 1e-3);
        let json = r#"{"mFrom":260,"mTo":262,"mode":"harmonized","switchM":276,"baseline":[2003,2022],"seriesMode":"switch"}"#;
        assert_eq!(e.cell_layer_json(json).unwrap().values, s.values);
    }

    /// A record whose MODIS stream delivered data on every day of a month (`days_modis` = 1) is
    /// complete even when its overpass coverage `cov_modis` is reduced (a Terra outage with Aqua
    /// flying); a Terra-only half month is not.
    #[test]
    fn day_coverage_not_overpass_coverage_decides_completeness() {
        let cols = synthetic(10, 311);
        let mut meta: serde_json::Value = serde_json::from_str(&meta_json(10, 311)).unwrap();
        let n = 312usize;
        let mut days: Vec<f64> = vec![1.0; n];
        meta["months"]["cov_modis"][193] = serde_json::json!(0.845); // 2016-02: Terra out 9 days
        meta["months"]["cov_modis"][17] = serde_json::json!(0.5); // 2001-06: Terra-only, half the month
        days[17] = 0.5;
        meta["months"]["days_modis"] = serde_json::json!(days);
        let e = engine_meta(&meta.to_string(), square(), &cols);
        let a = e.analyze(&AnalyzeOptions { switch_m: 400, ..opts([10, 311], Dn::Both) }).unwrap();
        assert!(!a.series.partial[193 - 10] && a.series.partial[17 - 10]);
        assert!(a.in_progress.is_none(), "a partial month inside the record is not in progress");
        assert!(!a.annual.complete[1], "2001 has a partial month");
        assert!(a.annual.complete[16], "2016 is complete");
    }

    #[test]
    fn level_needs_rank_and_magnitude() {
        use crate::stats::level_label;
        let l = |p: f64, r: f64| level_label(Some(p), r * 10.0, Some(10.0));
        assert_eq!(l(99.0, 1.1), "normal", "high rank, small ratio");
        assert_eq!(l(99.0, 1.3), "above");
        assert_eq!(l(95.0, 1.6), "well-above");
        assert_eq!(l(99.0, 1.7), "well-above", "extreme needs ratio 2");
        assert_eq!(l(98.0, 2.1), "extreme");
        assert_eq!(l(80.0, 3.0), "above", "large ratio, modest rank");
        assert_eq!(l(60.0, 1.3), "normal");
        assert_eq!(l(5.0, 0.6), "well-below");
        assert_eq!(l(5.0, 0.8), "below");
        assert_eq!(l(20.0, 0.9), "normal");
        assert_eq!(l(20.0, 0.8), "below");
        assert_eq!(level_label(Some(99.0), 5.0, Some(0.5)), "undefined", "median below the floor");
        assert_eq!(level_label(None, 5.0, Some(10.0)), "undefined");
        assert_eq!(level_label(Some(50.0), 5.0, None), "undefined");
    }

    /// Lon 10, lat 24 in the review: nothing before VIIRS, a little from 2012.
    #[test]
    fn sparse_area_makes_no_trend_season_analog_or_outlook_claims() {
        let mut c = Cols::default();
        let cell = 1800 * 7200 + 3600;
        for m in 145..=311u16 {
            let k = m % 12;
            if !(k == 2 || k == 3) {
                continue;
            }
            let x = 10 + (m as u32 - 145) / 2; // 0.10 .. 0.93 AFCD a month, rising
            c.cell.push(cell);
            c.stratum.push(0);
            c.m.push(m);
            c.dn.push(0);
            c.meq.push(0);
            c.kv.push(x);
            c.kvsq.push((x as f32 / 100.0).powi(2));
            c.v.push(4 * x);
            c.nmod.push(0);
            c.nvii.push(1);
        }
        let e = engine_meta(&model_meta_json(10, 311), vec![vec![[0.0, 0.0], [0.05, 0.0], [0.05, 0.05], [0.0, 0.05]]], &c);
        let a = e.analyze(&opts([10, 311], Dn::Both)).unwrap();
        assert!(a.activity.sparse && a.activity.mean_annual < 10.0, "{:?}", a.activity);
        assert!(a.activity.reason.as_deref().unwrap().contains("below 10"));
        assert_eq!((a.trend.direction, a.trend.suppressed), ("none", true));
        assert!(a.trend.p_value < 0.05, "the raw test would call it a rise: {:?}", a.trend);
        assert!(!a.season.defined);
        assert!(a.analogs.is_none());
        assert_eq!((a.outlook.method, a.outlook.skill), ("climatology", 0.0));
        assert_eq!(a.current.level, "undefined");
        assert_eq!(a.current.ratio, None);
        assert!(a.calendar.ratio.iter().flatten().all(Option::is_none), "no ratio to a median below 1 AFCD-M");
        assert_no_bad_nulls(&serde_json::to_string(&a).unwrap());
        // The era rule: MODIS saw nothing, VIIRS sees a little, yet the mean clears 10 a year.
        let mut c2 = Cols::default();
        for m in 10..=311u16 {
            let viirs = m >= 145;
            let x = if viirs { 150 } else { 1 }; // 1.5 AFCD a month from 2012, 0.01 before
            c2.cell.push(cell);
            c2.stratum.push(0);
            c2.m.push(m);
            c2.dn.push(0);
            c2.meq.push(if viirs { 0 } else { x });
            c2.kv.push(if viirs { x } else { 0 });
            c2.kvsq.push(0.0);
            c2.v.push(if viirs { 4 * x } else { 0 });
            c2.nmod.push(0);
            c2.nvii.push(1);
        }
        let mut meta: serde_json::Value = serde_json::from_str(&model_meta_json(10, 311)).unwrap();
        meta["default_switch_m"] = serde_json::json!(145);
        let e = engine_meta(&meta.to_string(), vec![vec![[0.0, 0.0], [0.05, 0.0], [0.05, 0.05], [0.0, 0.05]]], &c2);
        // A VIIRS-era baseline (2013-2022), so the mean clears 10 a year and only the era rule applies.
        let a = e.analyze(&AnalyzeOptions { mode: Mode::Switch, switch_m: 145, baseline: [2013, 2022], ..opts([10, 311], Dn::Both) }).unwrap();
        assert!(a.activity.mean_annual >= 10.0 && a.activity.nonzero_months >= 24, "{:?}", a.activity);
        assert!(a.activity.sparse && a.activity.reason.as_deref().unwrap().contains("eras"), "{:?}", a.activity);
        // A well-sampled area is not sparse.
        let full = engine_meta(&model_meta_json(10, 311), square(), &synthetic(10, 311));
        let a = full.analyze(&opts([10, 311], Dn::Both)).unwrap();
        assert!(!a.activity.sparse && a.season.defined && !a.trend.suppressed && a.activity.reason.is_none());
    }

    /// Night-only series under the VIIRS lens with a factor that varies by calendar month: every
    /// rank-type statistic equals the MODIS-unit one; only values, totals and intervals scale.
    #[test]
    fn lens_invariance_night_only() {
        let mut cols = synthetic(10, 311);
        // A strongly seasonal VIIRS-to-MODIS factor (v = kv x 2..8 by calendar month).
        for r in 0..cols.cell.len() {
            let k = (cols.m[r] % 12) as u32;
            cols.v[r] = cols.kv[r] * (2 + (k * 7) % 7 + k / 2);
        }
        let e = engine_meta(&model_meta_json(10, 311), square(), &cols);
        let night = |unit| e.analyze(&AnalyzeOptions { unit, ..opts([10, 311], Dn::Night) }).unwrap();
        let (m, v) = (night(Unit::Modis), night(Unit::Viirs));
        let f = v.harmonization.lens_factor.clone().unwrap();
        assert!(f.iter().any(|x| (x - f[0]).abs() > 0.05), "factors vary by month: {f:?}");
        assert_eq!(m.season, v.season, "season, peak month and window");
        assert_eq!((m.trend.direction, m.trend.p_value, m.trend.tau), (v.trend.direction, v.trend.p_value, v.trend.tau));
        assert!((m.trend.slope_pct_per_year - v.trend.slope_pct_per_year).abs() < 1e-12);
        assert_eq!(m.calendar.ratio, v.calendar.ratio);
        assert_eq!(m.calendar.percentile, v.calendar.percentile);
        assert_eq!(m.calendar.z, v.calendar.z);
        assert_eq!(m.annual.rank, v.annual.rank);
        assert_eq!((m.ytd.rank, m.ytd.of, m.ytd.ratio), (v.ytd.rank, v.ytd.of, v.ytd.ratio));
        let (cm, cv) = (&m.current, &v.current);
        assert_eq!((cm.percentile, cm.ratio, cm.z, cm.rank, cm.of, cm.level), (cv.percentile, cv.ratio, cv.z, cv.rank, cv.of, cv.level));
        let order = |a: &Analysis| a.records.top_months.iter().map(|t| (t.m, t.ratio)).collect::<Vec<_>>();
        assert_eq!(order(&m), order(&v));
        let years = |a: &Analysis| a.records.top_years.iter().map(|t| t.year).collect::<Vec<_>>();
        assert_eq!(years(&m), years(&v));
        let an = |a: &Analysis| {
            let x = a.analogs.as_ref().unwrap();
            (x.year, x.through_month, x.top.iter().map(|t| (t.year, t.distance, t.rest_ratio, t.peak_month)).collect::<Vec<_>>(), x.skill, x.informative)
        };
        assert_eq!(an(&m), an(&v));
        assert_eq!((m.outlook.method, m.outlook.skill), (v.outlook.method, v.outlook.skill));
        assert_eq!((m.activity.mean_annual, m.activity.sparse), (v.activity.mean_annual, v.activity.sparse));
        // Values, totals and intervals do scale.
        let k = (cm.month - 1) as usize;
        assert!((cm.value / f[k] - cv.value).abs() < 1e-9 * cm.value.max(1.0));
        assert!((cm.median / f[k] - cv.median).abs() < 1e-9 * cm.median.max(1.0));
        assert!((cm.hi80.unwrap() / f[k] - cv.hi80.unwrap()).abs() < 1e-9 * cm.hi80.unwrap().max(1.0));
        let i = |mm: i32| (mm - 10) as usize;
        assert!((m.series.harmonized[i(200)].unwrap() / f[(200 % 12) as usize] - v.series.harmonized[i(200)].unwrap()).abs() < 1e-9);
        let o = &v.outlook;
        for (j, &mm) in o.months.iter().enumerate() {
            assert!((m.outlook.median[j] / f[(mm % 12) as usize] - o.median[j]).abs() < 1e-9 * o.median[j].max(1.0));
        }
        assert_ne!(m.annual.total, v.annual.total);
        assert_no_bad_nulls(&serde_json::to_string(&v).unwrap());
    }

    /// A zero month keeps an upper bound from the error model (variance floor at the shifted-log
    /// offset), instead of the degenerate 0-0 interval.
    #[test]
    fn zero_month_has_an_upper_bound() {
        let mut c = Cols::default();
        let cell = 1800 * 7200 + 3600;
        for (m, meq, kv) in [(200u16, 4000u32, 6000u32), (202, 0, 50)] {
            c.cell.push(cell);
            c.stratum.push(0);
            c.m.push(m);
            c.dn.push(0);
            c.meq.push(meq);
            c.kv.push(kv);
            c.kvsq.push(0.0);
            c.v.push(4 * kv);
            c.nmod.push(1);
            c.nvii.push(1);
        }
        let meta = model_meta_json(10, 311);
        let e = engine_meta(&meta, vec![vec![[0.0, 0.0], [0.05, 0.0], [0.05, 0.05], [0.0, 0.05]]], &c);
        let a = e.analyze(&opts([200, 202], Dn::Day)).unwrap();
        assert_eq!(a.series.harmonized[1], Some(0.0));
        let (lo, hi, hi95) = (a.series.lo80[1].unwrap(), a.series.hi80[1].unwrap(), a.series.hi95[1].unwrap());
        assert_eq!(lo, 0.0);
        // Floor = variance at 0.5 of the only group (stratum 0, day) under month 201's plan; class 0, group 0 q.
        let mt = Meta::parse(&meta).unwrap();
        let pl = series::plan(&mt, 201, Mode::Fused, 276, true);
        let fl = series::estimate(&mt, &pl, &mt.strata[0], 0, 0.5, 0.5).var;
        let b = series::bounds_shifted(0.0, fl, 1.35, 2.1);
        assert!((hi - b[1]).abs() < 1e-9 && (hi95 - b[3]).abs() < 1e-9, "{hi} vs {b:?}");
        assert!(hi > 0.5 && hi < 10.0 && hi95 > hi, "a plausible upper bound: {hi}, {hi95}");
        // A large month is unaffected by the floor.
        let big = a.series.harmonized[0].unwrap();
        assert!(big > 40.0 && a.series.hi80[0].unwrap() < 2.0 * big);
        // No activity anywhere: Poisson floor, still finite and open.
        let none = engine_meta(&meta, square(), &Cols::default()).analyze(&opts([200, 200], Dn::Both)).unwrap();
        assert!(none.series.hi80[0].unwrap() > 0.0 && none.series.hi80[0].unwrap().is_finite());
    }
}
