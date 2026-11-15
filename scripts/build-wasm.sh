#!/usr/bin/env bash
# Builds the Harmony analysis kernel to WebAssembly and generates the ES-module bindings into
# web/src/lib/kernel/pkg/ (committed, so the web app builds without Rust). Requires the wasm32-unknown-unknown target and the
# wasm-bindgen CLI matching the crate's pinned version (0.2.130).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/web/src/lib/kernel/pkg"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
# Size-optimised codegen for the browser bundle (~25 % smaller than opt-level 3, same speed class).
CARGO_PROFILE_RELEASE_OPT_LEVEL=s cargo build --release -p harmony-wasm --target wasm32-unknown-unknown
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" \
  "$ROOT/target/wasm32-unknown-unknown/release/harmony_wasm.wasm"

# Optional size pass when binaryen is installed.
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    "$OUT/harmony_wasm_bg.wasm" -o "$OUT/harmony_wasm_bg.wasm"
fi

# Record which Rust sources this build came from (scripts/check-wasm.mjs compares it).
node "$ROOT/scripts/check-wasm.mjs" --write

echo "kernel: $(wc -c < "$OUT/harmony_wasm_bg.wasm") bytes -> $OUT"
