//! wasm-bindgen wrapper around `harmony_core::Engine`. Errors become JS exceptions carrying the
//! kernel's message; nothing here panics on bad input.

use harmony_core::store::TileColumns;
use harmony_core::Engine;
use wasm_bindgen::prelude::*;

fn js(e: harmony_core::Error) -> JsError {
    JsError::new(&e.0)
}

#[wasm_bindgen]
pub struct Kernel {
    engine: Engine,
}

/// Result of `Kernel.cell_layer`; each `take_*` moves its array out (call once).
#[wasm_bindgen]
pub struct CellLayerResult {
    level: u8,
    cells: Vec<u32>,
    weights: Vec<f32>,
    values: Vec<f32>,
}

#[wasm_bindgen]
impl CellLayerResult {
    #[wasm_bindgen(getter)]
    pub fn level(&self) -> u8 {
        self.level
    }

    pub fn take_cells(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.cells)
    }

    pub fn take_weights(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.weights)
    }

    pub fn take_values(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.values)
    }
}

#[wasm_bindgen]
impl Kernel {
    /// `meta_json`: the contents of `meta.json`.
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str) -> Result<Kernel, JsError> {
        Ok(Kernel { engine: Engine::new(meta_json).map_err(js)? })
    }

    pub fn version() -> String {
        harmony_core::version().to_string()
    }

    /// `flat_coords`: lon/lat pairs of all rings; `ring_offsets`: first vertex index of each ring
    /// (a trailing total vertex count is allowed). Returns `AoiInfo` JSON.
    pub fn set_aoi(&mut self, flat_coords: &[f64], ring_offsets: &[u32]) -> Result<String, JsError> {
        let info = self.engine.set_aoi_flat(flat_coords, ring_offsets).map_err(js)?;
        serde_json::to_string(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn tiles_for(&mut self, level: u8) -> Result<Vec<String>, JsError> {
        self.engine.tiles_for(level).map_err(js)
    }

    pub fn begin(&mut self, level: u8) -> Result<(), JsError> {
        self.engine.begin(level).map_err(js)
    }

    /// Returns the number of rows kept (cells inside the AOI).
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_tile(
        &mut self,
        cell: &[u32],
        stratum: &[u16],
        m: &[u16],
        dn: &[u8],
        meq: &[u32],
        kv: &[u32],
        kvsq: &[f32],
        v: &[u32],
        nmod: &[u32],
        nvii: &[u32],
    ) -> Result<u32, JsError> {
        let cols = TileColumns { cell, stratum, m, dn, meq, kv, kvsq, v, nmod, nvii };
        self.engine.ingest(&cols).map_err(js)
    }

    /// `options_json`: `AnalyzeOptions`; returns `Analysis` JSON.
    pub fn analyze(&self, options_json: &str) -> Result<String, JsError> {
        self.engine.analyze_json(options_json).map_err(js)
    }

    /// `options_json`: `CellLayerOptions` (`{ mFrom, mTo, mode, switchM, baseline, dn?, seriesMode? }`).
    pub fn cell_layer(&self, options_json: &str) -> Result<CellLayerResult, JsError> {
        let l = self.engine.cell_layer_json(options_json).map_err(js)?;
        Ok(CellLayerResult { level: l.level, cells: l.cells, weights: l.weights, values: l.values })
    }
}
