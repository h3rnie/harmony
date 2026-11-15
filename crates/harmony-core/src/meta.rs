//! `meta.json` (data contract v1). Only the fields the kernel needs are parsed; others are ignored.

use serde::Deserialize;

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

/// Per-stratum uncertainty parameters, `[day, night]`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StratumMeta {
    #[serde(default)]
    pub relvar: [f64; 2],
    #[serde(default)]
    pub alpha: [f64; 2],
    #[serde(default)]
    pub relvar_bridge: [f64; 2],
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MonthsMeta {
    #[serde(default)]
    pub cov_modis: Vec<Option<f64>>,
    #[serde(default)]
    pub cov_viirs: Vec<Option<f64>>,
    #[serde(default)]
    pub provisional: Vec<Option<f64>>,
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
}

fn one() -> f64 {
    1.0
}

/// Value of a per-month array; an absent array means "no information" and yields `default`.
fn month_value(a: &[Option<f64>], m: i32, default: f64) -> f64 {
    if a.is_empty() {
        return default;
    }
    usize::try_from(m).ok().and_then(|i| a.get(i).copied().flatten()).unwrap_or(0.0)
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

    pub fn provisional(&self, m: i32) -> bool {
        month_value(&self.months.provisional, m, 0.0) >= 0.5
    }
}
