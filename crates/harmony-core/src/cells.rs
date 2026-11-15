//! Per-cell map layer for a month window: the harmonized total (day, night or both), or its
//! ratio to the cell's own baseline median for the same calendar window.
//!
//! The harmonized value of a tile row follows the series: in fused mode (default) each row
//! (cell × stratum × month × dn) fuses its own `meq` and `kv` with its stratum's error model
//! (`series::estimate`); in switch mode, or without an error model, the stream at `switchM`.

use serde::Deserialize;

use crate::meta::Meta;
use crate::months::year_of;
use crate::robust::{median, ratio, sorted};
use crate::meta::StratumMeta;
use crate::series::{estimate, plan, Dn, Mode};
use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CellMode {
    Harmonized,
    Ratio,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellLayerOptions {
    pub m_from: i32,
    pub m_to: i32,
    pub mode: CellMode,
    pub switch_m: i32,
    pub baseline: [i32; 2],
    /// Overpass filter; absent = day and night.
    #[serde(default)]
    pub dn: Dn,
    /// `fused` (default) or `switch`, as `AnalyzeOptions.mode` (named apart from `mode` above).
    #[serde(default)]
    pub series_mode: Mode,
}

/// Values are per cell (not AOI-weighted); NaN where undefined (no covered month in the
/// window, or a zero / missing baseline median in ratio mode).
#[derive(Debug, Clone, Default)]
pub struct CellLayer {
    pub level: u8,
    pub cells: Vec<u32>,
    pub weights: Vec<f32>,
    pub values: Vec<f32>,
}

pub fn cell_layer(meta: &Meta, store: &Store, o: &CellLayerOptions) -> CellLayer {
    // Clamp so absurd windows cannot make the loops below unbounded.
    let lim = |m: i32| m.clamp(meta.m_first - 1, meta.m_last + 1);
    let (a, b) = (lim(o.m_from.min(o.m_to)), lim(o.m_from.max(o.m_to)));
    let n = meta.n_months();
    let model = meta.has_err_model();
    let plans: Vec<_> = (0..n).map(|i| plan(meta, meta.m_first + i as i32, o.series_mode, o.switch_m, model)).collect();
    let index = |m: i32| usize::try_from(m - meta.m_first).ok().filter(|&i| i < n);
    let covered = |m: i32| index(m).is_some_and(|i| plans[i].covered());
    let no_params = StratumMeta::default();

    // Baseline years whose shifted window is fully covered.
    let years: Vec<i32> = if o.mode == CellMode::Ratio {
        let (y0, y1) = (o.baseline[0].min(o.baseline[1]), o.baseline[0].max(o.baseline[1]));
        (y0..=y1).filter(|&y| {
            let d = 12 * (y - year_of(a));
            (a + d..=b + d).all(covered)
        })
        .collect()
    } else {
        Vec::new()
    };
    let nb = years.len();
    // For each record month, the baseline windows it belongs to.
    let mut member: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, y) in years.iter().enumerate() {
        let d = 12 * (y - year_of(a));
        for m in a + d..=b + d {
            if let Some(i) = index(m) {
                member[i].push(k);
            }
        }
    }

    let ncell = store.weights.cells.len();
    let mut cur = vec![0f64; ncell];
    let mut base = vec![0f64; ncell * nb];
    for r in 0..store.len() {
        if !o.dn.accepts(store.dn[r]) {
            continue;
        }
        let m = store.m[r] as i32;
        let Some(i) = index(m) else { continue };
        let pl = &plans[i];
        if !pl.covered() {
            continue;
        }
        // A partial month shows what was detected so far, as the series does.
        let (meq, kv) = (store.meq[r] as f64 / 100.0 * pl.unscale[0], store.kv[r] as f64 / 100.0 * pl.unscale[1]);
        let val = if model {
            let p = meta.strata.get(store.stratum[r] as usize).unwrap_or(&no_params);
            estimate(meta, pl, p, store.dn[r] as usize, meq, kv).h
        } else if pl.use_m {
            meq
        } else {
            kv
        };
        let s = store.slot[r] as usize;
        if (a..=b).contains(&m) {
            cur[s] += val;
        }
        for &k in &member[i] {
            base[s * nb + k] += val;
        }
    }

    let values = match o.mode {
        _ if !(a..=b).any(covered) => vec![f32::NAN; ncell],
        CellMode::Harmonized => cur.iter().map(|&v| v as f32).collect(),
        CellMode::Ratio => (0..ncell)
            .map(|s| {
                let med = median(&sorted(base[s * nb..(s + 1) * nb].iter().copied()));
                med.and_then(|m| ratio(cur[s], m)).map_or(f32::NAN, |r| r as f32)
            })
            .collect(),
    };
    CellLayer {
        level: store.level(),
        cells: store.weights.cells.clone(),
        weights: store.weights.weights.clone(),
        values,
    }
}
