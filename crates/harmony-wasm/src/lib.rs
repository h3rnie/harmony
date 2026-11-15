use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn kernel_version() -> String {
    harmony_core::version().to_string()
}
