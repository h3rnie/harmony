// Checks that the committed WASM kernel (web/src/lib/kernel/pkg/) was built from the current Rust sources, so the web
// app can be built from git alone without a Rust toolchain.
//
//   node scripts/check-wasm.mjs           # exit 1 when pkg is missing or was built from different crate sources
//   node scripts/check-wasm.mjs --write   # record the current source hash (scripts/build-wasm.sh runs this after a build)
//
// "Built from" is tracked with a SHA-256 over the kernel's Rust inputs (workspace Cargo.toml + Cargo.lock and every
// Cargo.toml / .rs file under crates/), stored in pkg/source.sha256. A content hash is used rather than file times,
// because a git checkout sets every file's mtime to the checkout time. Line endings are normalised so a Windows
// checkout with autocrlf hashes the same as Linux.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'web/src/lib/kernel/pkg')
const STAMP = path.join(PKG, 'source.sha256')
const OUTPUTS = ['harmony_wasm.js', 'harmony_wasm.d.ts', 'harmony_wasm_bg.wasm', 'harmony_wasm_bg.wasm.d.ts']

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'target' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.rs') || e.name === 'Cargo.toml') out.push(p)
  }
  return out
}

function sourceHash() {
  const files = [path.join(ROOT, 'Cargo.toml'), path.join(ROOT, 'Cargo.lock'), ...walk(path.join(ROOT, 'crates'))]
  const rel = files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort()
  const h = createHash('sha256')
  for (const r of rel) {
    const text = readFileSync(path.join(ROOT, r), 'utf8').replace(/\r\n/g, '\n')
    h.update(r).update('\0').update(text).update('\0')
  }
  return { hash: h.digest('hex'), count: rel.length }
}

const { hash, count } = sourceHash()

if (process.argv.includes('--write')) {
  writeFileSync(STAMP, `${hash}\n`)
  console.log(`check-wasm: recorded source hash over ${count} files -> ${path.relative(ROOT, STAMP)}`)
  process.exit(0)
}

const missing = OUTPUTS.filter((f) => !existsSync(path.join(PKG, f)))
if (missing.length) {
  console.error(`check-wasm: FAIL - missing ${missing.join(', ')} in web/src/lib/kernel/pkg/. Run: bash scripts/build-wasm.sh`)
  process.exit(1)
}
const recorded = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : ''
if (recorded !== hash) {
  console.error(
    `check-wasm: FAIL - the committed kernel was built from different Rust sources (${recorded ? 'hash mismatch' : 'no source.sha256'}).\n` +
      '  Rebuild and commit it: bash scripts/build-wasm.sh (needs Rust + wasm-bindgen 0.2.130)',
  )
  process.exit(1)
}
console.log(`check-wasm: OK - pkg matches the Rust sources (${count} files hashed)`)
