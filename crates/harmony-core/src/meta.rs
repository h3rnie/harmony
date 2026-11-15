//! `meta.json` (data contract v1). Only the fields the kernel needs are parsed; others are ignored.
//!
//! The harmonization blocks (`strata[].err`, `fusion`, `drift`, `conformal`) are optional and read
//! leniently from raw JSON: a missing or malformed block is treated as absent and a malformed
//! number as 0, so an older or partly broken `meta.json` never fails to load
//! (see `schema/data-contract.md`, "Harmonization fields in meta.json").

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::Error;

#[derive(Debug, Clone, Deserialize)]
pub struct LevelMeta {
    pub level: u8,
    pub cell_deg: f64,
    pub tile_deg: f64,
    #[serde(default)]
    pub nx: u32,
    #[serde(default)]
    pub ny: u32,
}

impl LevelMeta {
    pub fn cells_per_tile(&self) -> u32 {
        ((self.tile_deg / self.cell_deg).round() as u32).max(1)
    }
}

/// Error parameters of one stream, `[day, night]`: `Var(μ) = rho μ² + phi μ` (MODIS-equivalent AFCD).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct StreamErr {
    pub rho: [f64; 2],
    pub phi: [f64; 2],
}

/// Sensor error model of a stratum (`strata[].err`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ErrModel {
    pub modis: StreamErr,
    pub bridge: StreamErr,
    /// Calibrated VIIRS by number of operating VIIRS satellites (1, 2, 3); rho excludes relvar.
    pub viirs: [StreamErr; 3],
}

/// Per-stratum uncertainty parameters, `[day, night]`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StratumMeta {
    #[serde(default)]
    pub relvar: [f64; 2],
    #[serde(default)]
    pub alpha: [f64; 2],
    #[serde(default)]
    pub relvar_bridge: [f64; 2],
    #[serde(default, rename = "biome")]
    biome_raw: Value,
    #[serde(default, rename = "err")]
    err_raw: Value,
    /// RESOLVE biome number (0 when absent).
    #[serde(skip)]
    pub biome: i32,
    #[serde(skip)]
    pub err: Option<ErrModel>,
}

/// Drift factors of one biome (or `all`): `[day, night]` arrays indexed like `Drift::years`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DriftRow {
    pub log_f: [Vec<f64>; 2],
    pub log_sd: [Vec<f64>; 2],
}

/// MODIS orbit-drift correction (`meta.drift`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Drift {
    pub start_year: i32,
    pub years: Vec<i32>,
    pub attr_frac: f64,
    pub biome: HashMap<i32, DriftRow>,
    pub all: Option<DriftRow>,
}

impl Drift {
    /// Row for a biome, falling back to `all`.
    pub fn row(&self, biome: i32) -> Option<&DriftRow> {
        self.biome.get(&biome).or(self.all.as_ref())
    }

    /// Index into `years` for a calendar year, `None` before `start_year`: the last listed year
    /// not after it (the first listed year if all listed years are later).
    pub fn index(&self, year: i32) -> Option<usize> {
        if year < self.start_year || self.years.is_empty() {
            return None;
        }
        Some(self.years.iter().rposition(|&y| y <= year).unwrap_or(0))
    }
}

/// Split-conformal multipliers on `σ_log` (`meta.conformal`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Conformal {
    pub size_edges: Vec<f64>,
    pub group_of_biome: HashMap<i32, usize>,
    /// `[group][size class]`; non-positive entries are invalid and fall back.
    pub q80: Vec<Vec<f64>>,
    pub q95: Vec<Vec<f64>>,
    pub global_q80: Vec<f64>,
    pub global_q95: Vec<f64>,
}

impl Conformal {
    /// Size class of a value in MODIS units: the number of edges at or below it.
    pub fn class(&self, h: f64) -> usize {
        self.size_edges.iter().filter(|&&e| h >= e).count()
    }

    /// `[q80, q95]` for a biome and size class (group row, then the global row); `None` per level
    /// where neither has a valid entry.
    pub fn q(&self, biome: Option<i32>, class: usize) -> [Option<f64>; 2] {
        let pick = |rows: &[Vec<f64>], global: &[f64]| {
            let own = biome
                .and_then(|b| self.group_of_biome.get(&b))
                .and_then(|&g| rows.get(g))
                .and_then(|r| r.get(class))
                .copied()
                .filter(|q| *q > 0.0);
            own.or_else(|| global.get(class).copied().filter(|q| *q > 0.0))
        };
        [pick(&self.q80, &self.global_q80), pick(&self.q95, &self.global_q95)]
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MonthsMeta {
    #[serde(default)]
    pub cov_modis: Vec<Option<f64>>,
    #[serde(default)]
    pub cov_viirs: Vec<Option<f64>>,
    #[serde(default)]
    pub provisional: Vec<Option<f64>>,
    /// Bitmask 1 S-NPP, 2 NOAA-20, 4 NOAA-21.
    #[serde(default)]
    pub viirs_sats: Vec<Option<f64>>,
    /// Fraction of the month's days on which at least one MODIS satellite delivered data (2026-11
    /// builds on). Absent: `cov_modis` is used instead.
    #[serde(default)]
    pub days_modis: Vec<Option<f64>>,
    /// Same for VIIRS (equal to `cov_viirs`, which is already a day fraction).
    #[serde(default)]
    pub days_viirs: Vec<Option<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meta {
    pub m_first: i32,
    pub m_last: i32,
    pub levels: Vec<LevelMeta>,
    pub aqua_start_m: i32,
    pub viirs_start_m: i32,
    #[serde(default)]
    pub default_switch_m: i32,
    #[serde(default)]
    pub months: MonthsMeta,
    #[serde(default)]
    pub strata: Vec<StratumMeta>,
    #[serde(default = "one")]
    pub ci_scale: f64,
    /// Day coverage from which a month drives statistics (`complete_min_coverage`); the pipeline
    /// writes the same constant (`config.COV_COMPLETE`). Absent: [`COMPLETE_COVERAGE`].
    #[serde(default = "complete_default", rename = "complete_min_coverage")]
    pub complete_min: f64,
    #[serde(default, rename = "fit_window_m")]
    fit_window_raw: Value,
    #[serde(default, rename = "fusion")]
    fusion_raw: Value,
    #[serde(default, rename = "drift")]
    drift_raw: Value,
    #[serde(default, rename = "conformal")]
    conformal_raw: Value,
    #[serde(skip)]
    pub fit_window_m: Option<[i32; 2]>,
    /// Correlation of the MODIS and VIIRS stratum-coherent error components, `[day, night]`.
    #[serde(skip)]
    pub kappa: [f64; 2],
    #[serde(skip)]
    pub drift: Option<Drift>,
    #[serde(skip)]
    pub conformal: Option<Conformal>,
}

/// Coverage from which a stream is coverage-corrected and used in the fusion. The pipeline
/// (`calibrate.py`, `COV_MIN`) scales a month by 1/coverage (at most ×2) only from this threshold
/// and leaves it raw below; in fused mode a stream below it is dropped when the other one reaches it.
pub const MIN_COVERAGE: f64 = 0.5;

/// Default day coverage from which a month drives statistics (`meta.complete_min_coverage`,
/// pipeline `config.COV_COMPLETE`). A month whose serving stream(s) delivered data on fewer of
/// its days is "in progress" (or degraded): drawn, flagged partial, never ranked or labelled.
pub const COMPLETE_COVERAGE: f64 = 0.9;

fn one() -> f64 {
    1.0
}

fn complete_default() -> f64 {
    COMPLETE_COVERAGE
}

/// Value of a per-month array; an absent array means "no information" and yields `default`.
fn month_value(a: &[Option<f64>], m: i32, default: f64) -> f64 {
    if a.is_empty() {
        return default;
    }
    usize::try_from(m).ok().and_then(|i| a.get(i).copied().flatten()).unwrap_or(0.0)
}

/// Finite number or 0.
fn num(v: &Value) -> f64 {
    v.as_f64().filter(|x| x.is_finite()).unwrap_or(0.0)
}

/// Finite, non-negative number or 0.
fn nonneg(v: &Value) -> f64 {
    num(v).max(0.0)
}

fn pair(v: &Value) -> [f64; 2] {
    [nonneg(&v[0]), nonneg(&v[1])]
}

fn int(v: &Value) -> Option<i32> {
    v.as_i64()
        .or_else(|| v.as_f64().filter(|x| x.is_finite() && x.fract() == 0.0 && x.abs() < 1e9).map(|x| x as i64))
        .and_then(|x| i32::try_from(x).ok())
}

fn nums(v: &Value, f: fn(&Value) -> f64) -> Vec<f64> {
    v.as_array().map(|a| a.iter().map(f).collect()).unwrap_or_default()
}

fn stream_err(v: &Value) -> StreamErr {
    StreamErr { rho: pair(&v["rho"]), phi: pair(&v["phi"]) }
}

fn parse_err(v: &Value) -> Option<ErrModel> {
    if !v.is_object() {
        return None;
    }
    // VIIRS rows by satellite count; a missing row repeats the last present one.
    let rows = |key: &str| -> Vec<[f64; 2]> {
        v["viirs"][key].as_array().map(|a| a.iter().filter(|r| r.is_array()).map(pair).collect()).unwrap_or_default()
    };
    let (rho, phi) = (rows("rho"), rows("phi"));
    let row = |a: &[[f64; 2]], j: usize| a.get(j).or(a.last()).copied().unwrap_or_default();
    Some(ErrModel {
        modis: stream_err(&v["modis"]),
        bridge: stream_err(&v["bridge"]),
        viirs: std::array::from_fn(|j| StreamErr { rho: row(&rho, j), phi: row(&phi, j) }),
    })
}

fn parse_drift_row(v: &Value) -> Option<DriftRow> {
    v.is_object().then(|| DriftRow {
        log_f: [nums(&v["log_f"][0], num), nums(&v["log_f"][1], num)],
        log_sd: [nums(&v["log_sd"][0], nonneg), nums(&v["log_sd"][1], nonneg)],
    })
}

fn parse_drift(v: &Value) -> Option<Drift> {
    let start_year = int(&v["start_year"])?;
    let years: Vec<i32> = v["years"].as_array()?.iter().filter_map(int).collect();
    let mut biome = HashMap::new();
    let mut all = None;
    for (k, row) in v["biome"].as_object()? {
        let Some(row) = parse_drift_row(row) else { continue };
        if k == "all" {
            all = Some(row);
        } else if let Ok(b) = k.trim().parse::<i32>() {
            biome.insert(b, row);
        }
    }
    Some(Drift { start_year, years, attr_frac: nonneg(&v["attr_frac"]), biome, all })
}

fn parse_conformal(v: &Value) -> Option<Conformal> {
    if !v.is_object() {
        return None;
    }
    let table = |key: &str| -> Vec<Vec<f64>> {
        v[key].as_array().map(|a| a.iter().map(|r| nums(r, nonneg)).collect()).unwrap_or_default()
    };
    let mut size_edges = nums(&v["size_edges"], num);
    size_edges.retain(|e| *e > 0.0);
    size_edges.sort_by(f64::total_cmp);
    let mut group_of_biome = HashMap::new();
    for (g, grp) in v["groups"].as_array().map(Vec::as_slice).unwrap_or_default().iter().enumerate() {
        for b in grp["biomes"].as_array().map(Vec::as_slice).unwrap_or_default() {
            if let Some(b) = int(b) {
                group_of_biome.entry(b).or_insert(g);
            }
        }
    }
    let c = Conformal {
        size_edges,
        group_of_biome,
        q80: table("q80"),
        q95: table("q95"),
        global_q80: nums(&v["global"]["q80"], nonneg),
        global_q95: nums(&v["global"]["q95"], nonneg),
    };
    let any = |rows: &[Vec<f64>], g: &[f64]| rows.iter().flatten().chain(g).any(|q| *q > 0.0);
    (any(&c.q80, &c.global_q80) || any(&c.q95, &c.global_q95)).then_some(c)
}

impl Meta {
    /// Parses and validates `meta.json`.
    pub fn parse(json: &str) -> Result<Meta, Error> {
        let mut meta: Meta =
            serde_json::from_str(json).map_err(|e| Error::new(format!("invalid meta.json: {e}")))?;
        if meta.m_first < 0 || meta.m_last < meta.m_first || meta.m_last > 60_000 {
            return Err(Error::new("meta.json: m_first/m_last out of range"));
        }
        if meta.levels.is_empty() {
            return Err(Error::new("meta.json: no levels"));
        }
        for l in &mut meta.levels {
            let sizes_ok = l.cell_deg.is_finite()
                && l.cell_deg > 0.0
                && l.tile_deg.is_finite()
                && l.tile_deg >= l.cell_deg;
            if !sizes_ok {
                return Err(Error::new(format!("meta.json: bad cell/tile size for level {}", l.level)));
            }
            if l.nx == 0 {
                l.nx = (360.0 / l.cell_deg).round() as u32;
            }
            if l.ny == 0 {
                l.ny = (180.0 / l.cell_deg).round() as u32;
            }
            if l.nx == 0 || l.ny == 0 || (l.nx as u64) * (l.ny as u64) > u32::MAX as u64 {
                return Err(Error::new(format!("meta.json: grid too large for level {}", l.level)));
            }
        }
        if !(meta.ci_scale.is_finite() && meta.ci_scale > 0.0) {
            meta.ci_scale = 1.0;
        }
        if !(meta.complete_min.is_finite() && (0.0..=1.0).contains(&meta.complete_min)) {
            meta.complete_min = COMPLETE_COVERAGE;
        }
        for s in &mut meta.strata {
            s.biome = int(&s.biome_raw).unwrap_or(0);
            s.err = parse_err(&s.err_raw);
            s.biome_raw = Value::Null;
            s.err_raw = Value::Null;
            for a in [&mut s.relvar, &mut s.alpha, &mut s.relvar_bridge] {
                *a = a.map(|x| if x.is_finite() { x.max(0.0) } else { 0.0 });
            }
        }
        meta.fit_window_m = match (int(&meta.fit_window_raw[0]), int(&meta.fit_window_raw[1])) {
            (Some(a), Some(b)) => Some([a.min(b), a.max(b)]),
            _ => None,
        };
        meta.kappa = pair(&meta.fusion_raw["kappa"]).map(|k| k.min(1.0));
        meta.drift = parse_drift(&meta.drift_raw);
        meta.conformal = parse_conformal(&meta.conformal_raw);
        for raw in [&mut meta.fit_window_raw, &mut meta.fusion_raw, &mut meta.drift_raw, &mut meta.conformal_raw] {
            *raw = Value::Null;
        }
        Ok(meta)
    }

    pub fn level(&self, level: u8) -> Result<&LevelMeta, Error> {
        self.levels
            .iter()
            .find(|l| l.level == level)
            .ok_or_else(|| Error::new(format!("unknown level {level}")))
    }

    pub fn n_months(&self) -> usize {
        (self.m_last - self.m_first + 1) as usize
    }

    pub fn in_record(&self, m: i32) -> bool {
        (self.m_first..=self.m_last).contains(&m)
    }

    /// MODIS has coverage in month `m`.
    pub fn modis_ok(&self, m: i32) -> bool {
        self.in_record(m) && month_value(&self.months.cov_modis, m, 1.0) > 0.0
    }

    /// Calibrated VIIRS has coverage in month `m`.
    pub fn viirs_ok(&self, m: i32) -> bool {
        self.in_record(m) && m >= self.viirs_start_m && month_value(&self.months.cov_viirs, m, 1.0) > 0.0
    }

    /// MODIS coverage of month `m` is at least [`MIN_COVERAGE`].
    pub fn modis_full(&self, m: i32) -> bool {
        self.modis_ok(m) && month_value(&self.months.cov_modis, m, 1.0) >= MIN_COVERAGE
    }

    /// Calibrated VIIRS coverage of month `m` is at least [`MIN_COVERAGE`].
    pub fn viirs_full(&self, m: i32) -> bool {
        self.viirs_ok(m) && month_value(&self.months.cov_viirs, m, 1.0) >= MIN_COVERAGE
    }

    /// Fraction of the days of month `m` on which MODIS delivered data (`months.days_modis`,
    /// falling back to `cov_modis`); 0 without coverage.
    pub fn modis_days(&self, m: i32) -> f64 {
        if !self.modis_ok(m) {
            return 0.0;
        }
        let a = if self.months.days_modis.is_empty() { &self.months.cov_modis } else { &self.months.days_modis };
        month_value(a, m, 1.0).clamp(0.0, 1.0)
    }

    /// Same for calibrated VIIRS (`months.days_viirs`, falling back to `cov_viirs`).
    pub fn viirs_days(&self, m: i32) -> f64 {
        if !self.viirs_ok(m) {
            return 0.0;
        }
        let a = if self.months.days_viirs.is_empty() { &self.months.cov_viirs } else { &self.months.days_viirs };
        month_value(a, m, 1.0).clamp(0.0, 1.0)
    }

    pub fn provisional(&self, m: i32) -> bool {
        month_value(&self.months.provisional, m, 0.0) >= 0.5
    }

    /// The sensor error model is present: every stratum has `err`.
    pub fn has_err_model(&self) -> bool {
        !self.strata.is_empty() && self.strata.iter().all(|s| s.err.is_some())
    }

    /// VIIRS error row for month `m`: number of operating VIIRS satellites (bits of
    /// `months.viirs_sats`) clamped to 1..3, minus one. An absent array means one satellite.
    pub fn viirs_era(&self, m: i32) -> usize {
        let mask = month_value(&self.months.viirs_sats, m, 1.0);
        let mask = if mask.is_finite() && mask > 0.0 { mask.min(255.0) as u32 } else { 0 };
        (mask.count_ones().clamp(1, 3) - 1) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harmonization_blocks_are_lenient() {
        let json = serde_json::json!({
            "m_first": 10, "m_last": 20, "aqua_start_m": 30, "viirs_start_m": 145,
            "levels": [{ "level": 0, "cell_deg": 0.05, "tile_deg": 2.5 }],
            "fit_window_m": [263, 145],
            "months": { "viirs_sats": [0, 1, 3, 7, 6, null] },
            "strata": [
                { "biome": 7, "relvar": [0.01, 0.02],
                  "err": { "modis": { "rho": [0.01, -3], "phi": [1.1, "bad"] },
                           "viirs": { "rho": [[0.02, 0.03]], "phi": [[0.5, 0.6], [0.4, 0.5]] } } },
                { "biome": null }
            ],
            "fusion": { "kappa": [0.3, 7] },
            "drift": { "start_year": 2020, "years": [2020, 2021, 2023], "attr_frac": 0.5,
                       "biome": { "7": { "log_f": [[0.1, 0.2, 0.3], [0]], "log_sd": [[0.01], [-1]] },
                                  "all": { "log_f": [[], []], "log_sd": [[], []] }, "x": 3 } },
            "conformal": { "size_edges": [100, 5, -1], "groups": [{ "name": "a", "biomes": [7, 8] }],
                           "q80": [[1.5, 0, null]], "q95": [[2.5]], "global": { "q80": [1.3, 1.4, 1.6], "q95": [2] } }
        });
        let m = Meta::parse(&json.to_string()).unwrap();
        let e = m.strata[0].err.unwrap();
        assert_eq!(m.strata[0].biome, 7);
        assert_eq!(e.modis.rho, [0.01, 0.0]);
        assert_eq!(e.modis.phi, [1.1, 0.0]);
        assert_eq!(e.viirs[2].rho, [0.02, 0.03]); // repeats the last present row
        assert_eq!(e.viirs[2].phi, [0.4, 0.5]);
        assert!(m.strata[1].err.is_none() && m.strata[1].biome == 0);
        assert!(!m.has_err_model());
        assert_eq!(m.fit_window_m, Some([145, 263]));
        assert_eq!(m.kappa, [0.3, 1.0]);
        let d = m.drift.as_ref().unwrap();
        assert_eq!(d.index(2019), None);
        assert_eq!(d.index(2020), Some(0));
        assert_eq!(d.index(2022), Some(1));
        assert_eq!(d.index(2030), Some(2));
        assert_eq!(d.row(7).unwrap().log_f[0], vec![0.1, 0.2, 0.3]);
        assert_eq!(d.row(7).unwrap().log_sd[1], vec![0.0]);
        assert!(d.row(1).unwrap().log_f[0].is_empty()); // "all"
        let c = m.conformal.as_ref().unwrap();
        assert_eq!(c.size_edges, vec![5.0, 100.0]);
        assert_eq!((c.class(0.0), c.class(5.0), c.class(99.0), c.class(1e6)), (0, 1, 1, 2));
        assert_eq!(c.q(Some(7), 0), [Some(1.5), Some(2.5)]);
        assert_eq!(c.q(Some(8), 1), [Some(1.4), None]); // invalid group entry -> global row
        assert_eq!(c.q(Some(1), 2), [Some(1.6), None]);
        assert_eq!(c.q(None, 9), [None, None]);
        assert_eq!((m.viirs_era(0), m.viirs_era(1), m.viirs_era(2), m.viirs_era(3)), (0, 0, 1, 2));
        assert_eq!((m.viirs_era(4), m.viirs_era(5), m.viirs_era(99)), (1, 0, 0));
        // No harmonization blocks at all (and a conformal block with no valid entry).
        let bare = serde_json::json!({ "m_first": 10, "m_last": 20, "aqua_start_m": 30, "viirs_start_m": 145,
            "levels": [{ "level": 0, "cell_deg": 0.05, "tile_deg": 2.5 }], "conformal": { "q80": [[0]] } });
        let m = Meta::parse(&bare.to_string()).unwrap();
        assert!(m.drift.is_none() && m.conformal.is_none() && m.fit_window_m.is_none() && !m.has_err_model());
        assert_eq!(m.viirs_era(5), 0);
    }
}
