//! Stateful kernel: meta + AOI + working-level store, and the `analyze` / `cell_layer` entry
//! points. JSON in and out matches `web/src/lib/kernel/types.ts`.

use serde::{Deserialize, Serialize};

use crate::cells::{self, CellLayer, CellLayerOptions};
use crate::geom::{tile_keys, Aoi, AoiInfo, CellWeights};
use crate::meta::Meta;
use crate::outlook::{self, Outlook};
use crate::season::{self, Season};
use crate::series::{self, Dn, Series};
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
        let mo = series::aggregate(meta, store, o.dn, o.switch_m);
        let (months, series) = series::series(&mo, range);
        let base = Baseline::new(&mo, o.baseline);
        let climatology = stats::climatology(&base);
        let annual = stats::annual(&mo);
        let (years, totals): (Vec<i32>, Vec<f64>) = annual.complete_years().into_iter().unzip();
        // Season from the median profile; sparse areas whose median is all zero fall back to the mean.
        let profile = |v: &[f64]| std::array::from_fn::<f64, 12, _>(|k| v.get(k).copied().unwrap_or(0.0));
        let median_profile = profile(&climatology.median);
        let season_profile =
            if median_profile.iter().sum::<f64>() > 0.0 { median_profile } else { profile(&climatology.mean) };
        Ok(Analysis {
            months,
            series,
            calendar: stats::calendar(&mo, &base),
            ytd: stats::ytd(&mo, &base),
            current: stats::current(&mo, &base),
            trend: trend::trend(&years, &totals),
            season: season::season(&season_profile),
            // Partial months are left out, so the origin is the latest complete-enough month.
            outlook: outlook::outlook(&mo.stat_values(), mo.m_first, o.baseline, &climatology),
            seam: stats::seam(&mo),
            records: stats::records(&mo, &base, &annual),
            climatology,
            annual,
            aoi: AoiSummary {
                info: aoi.info().clone(),
                level: store.level(),
                n_cells: store.weights.cells.len() as u32,
                rows: store.len() as u32,
            },
        })
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
        AnalyzeOptions { switch_m: 276, baseline: [2003, 2022], dn, range }
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
        let o = CellLayerOptions { m_from: 300, m_to: 302, mode: cells::CellMode::Harmonized, switch_m: 276, baseline: [2003, 2022], dn: Dn::Both };
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
            "records.topMonths.ratio",
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
        assert_eq!(a.current.level, "normal");
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
        assert_eq!(a.current.level, "extreme");
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
        // Coverage exactly at the threshold is complete enough.
        meta["months"]["cov_viirs"][312] = serde_json::json!(0.5);
        let mut e = Engine::new(&meta.to_string()).unwrap();
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
}
