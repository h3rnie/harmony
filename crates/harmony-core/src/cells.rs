//! Per-cell map layer for a month window: the harmonized total (day + night), or its ratio to
//! the cell's own baseline median for the same calendar window.

use serde::Deserialize;

use crate::meta::Meta;
use crate::months::year_of;
use crate::robust::{median, ratio, sorted};
use crate::series::{source_for, Source};
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
    let src: Vec<Source> = (0..n).map(|i| source_for(meta, meta.m_first + i as i32, o.switch_m)).collect();
    let index = |m: i32| usize::try_from(m - meta.m_first).ok().filter(|&i| i < n);
    let covered = |m: i32| index(m).is_some_and(|i| src[i] != Source::None);

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
        let m = store.m[r] as i32;
        let Some(i) = index(m) else { continue };
        let val = match src[i] {
            Source::Viirs => store.kv[r] as f64 / 100.0,
            Source::Bridge | Source::Modis => store.meq[r] as f64 / 100.0,
            Source::None => continue,
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
