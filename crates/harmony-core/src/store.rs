//! Compact columnar store of the tile rows that fall inside the AOI at the working level.

use crate::{geom::CellWeights, Error};

/// Borrowed tile columns, one entry per row (see `schema/data-contract.md`).
#[derive(Debug, Clone, Copy)]
pub struct TileColumns<'a> {
    pub cell: &'a [u32],
    pub stratum: &'a [u16],
    pub m: &'a [u16],
    pub dn: &'a [u8],
    pub meq: &'a [u32],
    pub kv: &'a [u32],
    pub kvsq: &'a [f32],
    pub v: &'a [u32],
    pub nmod: &'a [u32],
    pub nvii: &'a [u32],
}

impl TileColumns<'_> {
    fn len_checked(&self) -> Result<usize, Error> {
        let n = self.cell.len();
        let lens = [
            self.stratum.len(),
            self.m.len(),
            self.dn.len(),
            self.meq.len(),
            self.kv.len(),
            self.kvsq.len(),
            self.v.len(),
            self.nmod.len(),
            self.nvii.len(),
        ];
        if lens.iter().any(|&l| l != n) {
            return Err(Error::new(format!("tile columns differ in length (cell has {n} rows)")));
        }
        Ok(n)
    }
}

/// Rows kept for the AOI. `slot` indexes `weights.cells`; `w` is that cell's coverage weight.
#[derive(Debug, Default)]
pub struct Store {
    pub weights: CellWeights,
    pub slot: Vec<u32>,
    pub w: Vec<f32>,
    pub stratum: Vec<u16>,
    pub m: Vec<u16>,
    pub dn: Vec<u8>,
    pub meq: Vec<u32>,
    pub kv: Vec<u32>,
    pub kvsq: Vec<f32>,
    pub v: Vec<u32>,
    pub nmod: Vec<u32>,
    pub nvii: Vec<u32>,
}

impl Store {
    pub fn new(weights: CellWeights) -> Self {
        Store { weights, ..Default::default() }
    }

    pub fn level(&self) -> u8 {
        self.weights.level
    }

    pub fn len(&self) -> usize {
        self.m.len()
    }

    pub fn is_empty(&self) -> bool {
        self.m.is_empty()
    }

    /// Appends the rows whose cell has a positive AOI weight; returns how many were kept.
    /// Rows with an invalid `dn` (not 0/1) are skipped. Tiles must not be ingested twice.
    pub fn ingest(&mut self, t: &TileColumns) -> Result<u32, Error> {
        let n = t.len_checked()?;
        let mut kept = 0u32;
        // Rows are sorted by cell, so remember the last lookup.
        let mut cache: Option<(u32, Option<usize>)> = None;
        for i in 0..n {
            let cell = t.cell[i];
            let slot = match cache {
                Some((c, s)) if c == cell => s,
                _ => {
                    let s = self.weights.cells.binary_search(&cell).ok();
                    cache = Some((cell, s));
                    s
                }
            };
            let Some(slot) = slot else { continue };
            if t.dn[i] > 1 {
                continue;
            }
            self.slot.push(slot as u32);
            self.w.push(self.weights.weights[slot]);
            self.stratum.push(t.stratum[i]);
            self.m.push(t.m[i]);
            self.dn.push(t.dn[i]);
            self.meq.push(t.meq[i]);
            self.kv.push(t.kv[i]);
            self.kvsq.push(if t.kvsq[i].is_finite() { t.kvsq[i].max(0.0) } else { 0.0 });
            self.v.push(t.v[i]);
            self.nmod.push(t.nmod[i]);
            self.nvii.push(t.nvii[i]);
            kept += 1;
        }
        Ok(kept)
    }
}
