//! Monthly zonal sums over the AOI and the harmonized series with its uncertainty band.
//!
//! Values are AOI-weighted sums `Σ w_i x_i` in AFCD units (tile values are ×100). Raw hotspot
//! counts are weighted the same way, so naive and harmonized curves describe the same area.

use serde::{Deserialize, Serialize, Serializer};

use crate::meta::{Meta, StratumMeta};
use crate::store::Store;

pub const Z80: f64 = 1.2816;
pub const Z95: f64 = 1.96;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dn {
    #[default]
    Both,
    Day,
    Night,
}

impl Dn {
    pub fn accepts(self, dn: u8) -> bool {
        match self {
            Dn::Both => true,
            Dn::Day => dn == 0,
            Dn::Night => dn == 1,
        }
    }
}

/// `SourceCode` in types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    None = 0,
    Bridge = 1,
    Modis = 2,
    Viirs = 3,
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u8(*self as u8)
    }
}

/// Stream serving month `m`: MODIS (Terra-bridged before Aqua) before `switch_m`, calibrated
/// VIIRS from it. Each falls back to the other when it has no coverage that month.
pub fn source_for(meta: &Meta, m: i32, switch_m: i32) -> Source {
    let modis = meta
        .modis_ok(m)
        .then_some(if m < meta.aqua_start_m { Source::Bridge } else { Source::Modis });
    let viirs = meta.viirs_ok(m).then_some(Source::Viirs);
    let (first, second) = if m < switch_m { (modis, viirs) } else { (viirs, modis) };
    first.or(second).unwrap_or(Source::None)
}

/// Contract bounds `H·exp(∓z σ_log)` with `σ_log = √Var / max(H, 0.5)`:
/// `[lo80, hi80, lo95, hi95]`.
pub fn bounds(h: f64, var: f64) -> [f64; 4] {
    let sigma = var.max(0.0).sqrt() / h.max(0.5);
    let at = |z: f64| [h * (-z * sigma).exp(), h * (z * sigma).exp()];
    let ([lo80, hi80], [lo95, hi95]) = (at(Z80), at(Z95));
    [lo80, hi80, lo95, hi95]
}

/// VIIRS-derived variance (contract):
/// `ci² · [Σ relvar·S² + Σ (S + α·Q)]` over stratum × dn groups, with `S = Σ w kv`
/// (AFCD) and `Q = Σ w² kvsq`. Items are `(relvar, alpha, S, Q)`.
pub fn viirs_variance(groups: impl IntoIterator<Item = (f64, f64, f64, f64)>, ci_scale: f64) -> f64 {
    let sum: f64 = groups
        .into_iter()
        .map(|(relvar, alpha, s, q)| relvar * s * s + s + alpha * q)
        .sum();
    ci_scale * ci_scale * sum
}

/// Terra-bridge variance: `ci² · Σ relvar_bridge·S²` with `S = Σ w meq`; no dispersion term.
pub fn bridge_variance(groups: impl IntoIterator<Item = (f64, f64)>, ci_scale: f64) -> f64 {
    let sum: f64 = groups.into_iter().map(|(relvar, s)| relvar * s * s).sum();
    ci_scale * ci_scale * sum
}

/// Per-month values over the whole record (`index 0 = m_first`).
#[derive(Debug, Clone)]
pub struct Monthly {
    pub m_first: i32,
    pub viirs_start_m: i32,
    pub source: Vec<Source>,
    /// Harmonized value; `None` = outside the record or no coverage, `Some(0)` = covered, no fire.
    pub h: Vec<Option<f64>>,
    /// `[lo80, hi80, lo95, hi95]` where an interval applies.
    pub band: Vec<Option<[f64; 4]>>,
    pub meq: Vec<Option<f64>>,
    pub kv: Vec<Option<f64>>,
    pub v: Vec<Option<f64>>,
    pub nmod: Vec<f64>,
    pub nvii: Vec<f64>,
    pub provisional: Vec<bool>,
}

impl Monthly {
    pub fn len(&self) -> usize {
        self.h.len()
    }

    pub fn is_empty(&self) -> bool {
        self.h.is_empty()
    }

    pub fn m_last(&self) -> i32 {
        self.m_first + self.len() as i32 - 1
    }

    pub fn index(&self, m: i32) -> Option<usize> {
        let i = m.checked_sub(self.m_first)?;
        usize::try_from(i).ok().filter(|&i| i < self.len())
    }

    pub fn h_at(&self, m: i32) -> Option<f64> {
        self.index(m).and_then(|i| self.h[i])
    }

    /// Index of the latest month with a value.
    pub fn latest(&self) -> Option<usize> {
        self.h.iter().rposition(Option::is_some)
    }
}

/// Weighted sums for one month × stratum × dn.
#[derive(Debug, Clone, Copy, Default)]
struct Group {
    kv: f64,
    kvsq_w2: f64,
    meq: f64,
}

/// One pass over the stored rows: monthly totals for the `dn` filter, the harmonized series for
/// `switch_m`, and the contract interval per month.
pub fn aggregate(meta: &Meta, store: &Store, dn: Dn, switch_m: i32) -> Monthly {
    let n = meta.n_months();

    // Compact the strata present in the store so the group table stays small.
    let mut slot_of: Vec<u32> = Vec::new();
    let mut params: Vec<StratumMeta> = Vec::new();
    for &s in &store.stratum {
        let s = s as usize;
        if s >= slot_of.len() {
            slot_of.resize(s + 1, u32::MAX);
        }
        if slot_of[s] == u32::MAX {
            slot_of[s] = params.len() as u32;
            params.push(meta.strata.get(s).cloned().unwrap_or_default());
        }
    }
    let ns = params.len();

    // [meq, kv, v, nmod, nvii]
    let mut tot = vec![[0f64; 5]; n];
    let mut groups = vec![Group::default(); n * ns * 2];
    for r in 0..store.len() {
        let d = store.dn[r];
        if !dn.accepts(d) {
            continue;
        }
        let i = store.m[r] as i64 - meta.m_first as i64;
        if i < 0 || i >= n as i64 {
            continue;
        }
        let i = i as usize;
        let w = store.w[r] as f64;
        let meq = w * store.meq[r] as f64 / 100.0;
        let kv = w * store.kv[r] as f64 / 100.0;
        let t = &mut tot[i];
        t[0] += meq;
        t[1] += kv;
        t[2] += w * store.v[r] as f64 / 100.0;
        t[3] += w * store.nmod[r] as f64;
        t[4] += w * store.nvii[r] as f64;
        let g = &mut groups[(i * ns + slot_of[store.stratum[r] as usize] as usize) * 2 + d as usize];
        g.kv += kv;
        g.kvsq_w2 += w * w * store.kvsq[r] as f64;
        g.meq += meq;
    }

    let mut out = Monthly {
        m_first: meta.m_first,
        viirs_start_m: meta.viirs_start_m,
        source: Vec::with_capacity(n),
        h: Vec::with_capacity(n),
        band: Vec::with_capacity(n),
        meq: Vec::with_capacity(n),
        kv: Vec::with_capacity(n),
        v: Vec::with_capacity(n),
        nmod: Vec::with_capacity(n),
        nvii: Vec::with_capacity(n),
        provisional: Vec::with_capacity(n),
    };
    for (i, &[meq, kv, v, nmod, nvii]) in tot.iter().enumerate() {
        let m = meta.m_first + i as i32;
        let src = source_for(meta, m, switch_m);
        let gs = &groups[i * ns * 2..(i + 1) * ns * 2];
        let param = |k: usize| (&params[k / 2], k % 2);
        let (h, band) = match src {
            Source::None => (None, None),
            Source::Modis => (Some(meq), None),
            Source::Bridge => {
                let terms = gs.iter().enumerate().map(|(k, g)| {
                    let (p, d) = param(k);
                    (p.relvar_bridge[d], g.meq)
                });
                (Some(meq), Some(bounds(meq, bridge_variance(terms, meta.ci_scale))))
            }
            Source::Viirs => {
                let terms = gs.iter().enumerate().map(|(k, g)| {
                    let (p, d) = param(k);
                    (p.relvar[d], p.alpha[d], g.kv, g.kvsq_w2)
                });
                (Some(kv), Some(bounds(kv, viirs_variance(terms, meta.ci_scale))))
            }
        };
        out.source.push(src);
        out.h.push(h);
        out.band.push(band);
        out.meq.push(meta.modis_ok(m).then_some(meq));
        out.kv.push(meta.viirs_ok(m).then_some(kv));
        out.v.push(meta.viirs_ok(m).then_some(v));
        out.nmod.push(nmod);
        out.nvii.push(nvii);
        out.provisional.push(meta.provisional(m));
    }
    out
}

/// `Series` in types.ts, for the display range.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub harmonized: Vec<Option<f64>>,
    pub lo80: Vec<Option<f64>>,
    pub hi80: Vec<Option<f64>>,
    pub lo95: Vec<Option<f64>>,
    pub hi95: Vec<Option<f64>>,
    pub modis_eq: Vec<Option<f64>>,
    pub viirs_cal: Vec<Option<f64>>,
    pub viirs_raw: Vec<Option<f64>>,
    pub raw_modis_count: Vec<f64>,
    pub raw_viirs_count: Vec<f64>,
    /// MODIS counts before VIIRS starts, VIIRS counts from then on.
    pub naive: Vec<f64>,
    pub source: Vec<Source>,
    pub provisional: Vec<bool>,
}

/// Slices the record to the inclusive display `range`; months outside the record are null/0.
pub fn series(mo: &Monthly, range: (i32, i32)) -> (Vec<i32>, Series) {
    let months: Vec<i32> = (range.0..=range.1).collect();
    let mut s = Series::default();
    for &m in &months {
        let i = mo.index(m);
        let band = i.and_then(|i| mo.band[i]);
        let at = |k: usize| band.map(|b| b[k]);
        let (nmod, nvii) = i.map_or((0.0, 0.0), |i| (mo.nmod[i], mo.nvii[i]));
        s.harmonized.push(i.and_then(|i| mo.h[i]));
        s.lo80.push(at(0));
        s.hi80.push(at(1));
        s.lo95.push(at(2));
        s.hi95.push(at(3));
        s.modis_eq.push(i.and_then(|i| mo.meq[i]));
        s.viirs_cal.push(i.and_then(|i| mo.kv[i]));
        s.viirs_raw.push(i.and_then(|i| mo.v[i]));
        s.raw_modis_count.push(nmod);
        s.raw_viirs_count.push(nvii);
        s.naive.push(if m < mo.viirs_start_m { nmod } else { nvii });
        s.source.push(i.map_or(Source::None, |i| mo.source[i]));
        s.provisional.push(i.is_some_and(|i| mo.provisional[i]));
    }
    (months, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_formula_hand_computed() {
        // Two groups: S = 30, Q = 10, relvar 0.04, alpha 0.5; S = 10, Q = 4, relvar 0.09, alpha 1.
        // Var = 1.2² · [0.04·900 + 0.09·100 + (30 + 5) + (10 + 4)] = 1.44 · 94 = 135.36
        let var = viirs_variance([(0.04, 0.5, 30.0, 10.0), (0.09, 1.0, 10.0, 4.0)], 1.2);
        assert!((var - 135.36).abs() < 1e-9);
        let h = 40.0;
        let sigma = 135.36f64.sqrt() / 40.0; // 0.29086…
        let b = bounds(h, var);
        assert!((b[0] - 40.0 * (-1.2816 * sigma).exp()).abs() < 1e-9);
        assert!((b[1] - 40.0 * (1.2816 * sigma).exp()).abs() < 1e-9);
        assert!((b[2] - 22.619).abs() < 0.001, "{}", b[2]); // 40·e^(−1.96·0.290861)
        assert!((b[3] - 70.737).abs() < 0.001, "{}", b[3]); // 40·e^(+1.96·0.290861)
        assert!(b[0] < h && h < b[1] && b[2] < b[0] && b[3] > b[1]);
        // Small H uses the 0.5 floor in σ_log.
        let small = bounds(0.1, 0.01);
        assert!((small[1] - 0.1 * (1.2816 * 0.2f64).exp()).abs() < 1e-12);
        // Bridge: 1 · (0.01·50²) = 25
        assert!((bridge_variance([(0.01, 50.0)], 1.0) - 25.0).abs() < 1e-12);
    }
}
