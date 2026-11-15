// Smoke test for the built WASM kernel (run `bash scripts/build-wasm.sh` first):
//   node scripts/kernel-smoke.mjs
// Loads web/src/lib/kernel/pkg directly in Node, feeds a synthetic meta + tile, and checks the
// JSON against the shapes in web/src/lib/kernel/types.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const pkg = new URL('../web/src/lib/kernel/pkg/', import.meta.url)
const { default: init, Kernel } = await import(new URL('harmony_wasm.js', pkg).href)
await init({ module_or_path: readFileSync(new URL('harmony_wasm_bg.wasm', pkg)) })

// ---------- synthetic meta ----------
const M_FIRST = 10, M_LAST = 311, VIIRS_START = 145, AQUA_START = 30, SWITCH = 276
const n = M_LAST + 1
const meta = {
  version: 1, generated: '2026-11-15T12:00:00Z', data_through: '2025-12-31',
  m_first: M_FIRST, m_last: M_LAST,
  levels: [
    { level: 0, cell_deg: 0.05, tile_deg: 2.5, nx: 7200, ny: 3600 },
    { level: 1, cell_deg: 0.25, tile_deg: 10, nx: 1440, ny: 720 },
    { level: 2, cell_deg: 1, tile_deg: 360, nx: 360, ny: 180 },
  ],
  aqua_start_m: AQUA_START, viirs_start_m: VIIRS_START, default_switch_m: SWITCH, fit_window_m: [145, 263],
  months: {
    cov_modis: Array.from({ length: n }, (_, m) => (m < M_FIRST ? 0 : 1)),
    cov_viirs: Array.from({ length: n }, (_, m) => (m < VIIRS_START ? 0 : 1)),
    provisional: Array.from({ length: n }, (_, m) => (m >= M_LAST - 1 ? 1 : 0)),
    viirs_sats: Array.from({ length: n }, (_, m) => (m < VIIRS_START ? 0 : 1)),
  },
  strata: [0, 1, 2].map((id) => ({
    id, biome: 7, realm: 'NT', name: `stratum ${id}`,
    relvar: [0.02 + 0.01 * id, 0.04], alpha: [0.3, 0.6], relvar_bridge: [0.01, 0.02],
    k: [Array(12).fill(0.25), Array(12).fill(0.3)],
  })),
  ci_scale: 1.0, method: {}, sources: [],
}

// ---------- synthetic tile: 20×20 L0 cells at lon -60..-59, lat -20..-19 (tile 48_28) ----------
let seed = 12345
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const rows = { cell: [], stratum: [], m: [], dn: [], meq: [], kv: [], kvsq: [], v: [], nmod: [], nvii: [] }
for (let iy = 1400; iy < 1420; iy++) {
  for (let ix = 2400; ix < 2420; ix++) {
    const cell = iy * 7200 + ix
    const stratum = (ix + iy) % 3
    for (let m = M_FIRST; m <= M_LAST; m++) {
      for (let dn = 0; dn < 2; dn++) {
        // Southern dry-season cycle peaking in September, mild upward drift, noise.
        const season = Math.exp(2.2 * Math.cos(((m % 12) - 8) / 12 * 2 * Math.PI))
        const afcd = season * (0.6 + 0.4 * rand()) * (1 + (m - M_FIRST) / 600) * (dn ? 0.4 : 1)
        const meq = Math.round(afcd * 100)
        if (meq === 0) continue
        const viirs = m >= VIIRS_START
        const kv = viirs ? Math.round(meq * (0.95 + 0.1 * rand())) : 0
        const nmod = Math.max(1, Math.round(afcd * 1.5))
        rows.cell.push(cell); rows.stratum.push(stratum); rows.m.push(m); rows.dn.push(dn)
        rows.meq.push(meq); rows.kv.push(kv); rows.kvsq.push((kv / 100) ** 2)
        rows.v.push(viirs ? 4 * kv : 0); rows.nmod.push(nmod); rows.nvii.push(viirs ? 4 * nmod : 0)
      }
    }
  }
}
const tile = {
  cell: Uint32Array.from(rows.cell), stratum: Uint16Array.from(rows.stratum), m: Uint16Array.from(rows.m),
  dn: Uint8Array.from(rows.dn), meq: Uint32Array.from(rows.meq), kv: Uint32Array.from(rows.kv),
  kvsq: Float32Array.from(rows.kvsq), v: Uint32Array.from(rows.v), nmod: Uint32Array.from(rows.nmod),
  nvii: Uint32Array.from(rows.nvii),
}
const ingest = (k, t) => k.ingest_tile(t.cell, t.stratum, t.m, t.dn, t.meq, t.kv, t.kvsq, t.v, t.nmod, t.nvii)

// ---------- run ----------
const kernel = new Kernel(JSON.stringify(meta))
console.log(`kernel ${Kernel.version()}`)
// Concave pentagon inside the tile, given clockwise and closed, plus a small hole.
const outer = [[-59.97, -19.97], [-59.97, -19.1], [-59.5, -19.5], [-59.03, -19.05], [-59.05, -19.95], [-59.97, -19.97]]
const hole = [[-59.6, -19.8], [-59.4, -19.8], [-59.5, -19.7]]
const flat = Float64Array.from([...outer, ...hole].flat())
const aoi = JSON.parse(kernel.set_aoi(flat, Uint32Array.from([0, outer.length, outer.length + hole.length])))
assert.equal(typeof aoi.areaKm2, 'number'); assert.ok(aoi.areaKm2 > 5000 && aoi.areaKm2 < 12000, `area ${aoi.areaKm2}`)
assert.equal(aoi.bbox.length, 4); assert.equal(aoi.centroid.length, 2)
assert.deepEqual(kernel.tiles_for(0), ['48_28'])
assert.deepEqual(kernel.tiles_for(1), ['12_7'])
kernel.begin(0)
const kept = ingest(kernel, tile)
assert.ok(kept > 0 && kept < tile.cell.length, `kept ${kept} of ${tile.cell.length}`)

const opts = { switchM: SWITCH, baseline: [2003, 2022], dn: 'both', range: [0, 320] }
let t0 = performance.now()
const a = JSON.parse(kernel.analyze(JSON.stringify(opts)))
const tAnalyze = performance.now() - t0

// ---------- shape checks (types.ts) ----------
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isNumOrNull = (x) => x === null || isNum(x)
const allOf = (arr, pred, what) => { assert.ok(Array.isArray(arr), `${what} is an array`); arr.forEach((x, i) => assert.ok(pred(x), `${what}[${i}] = ${x}`)) }

const L = 321
assert.equal(a.months.length, L); assert.equal(a.months[0], 0); assert.equal(a.months[L - 1], 320)
for (const k of ['harmonized', 'lo80', 'hi80', 'lo95', 'hi95', 'modisEq', 'viirsCal', 'viirsRaw']) allOf(a.series[k], isNumOrNull, `series.${k}`)
for (const k of ['rawModisCount', 'rawViirsCount', 'naive']) allOf(a.series[k], isNum, `series.${k}`)
allOf(a.series.source, (x) => [0, 1, 2, 3].includes(x), 'series.source')
allOf(a.series.provisional, (x) => typeof x === 'boolean', 'series.provisional')
for (const k of Object.keys(a.series)) assert.equal(a.series[k].length, L, `series.${k} length`)
assert.equal(a.series.harmonized[0], null); assert.equal(a.series.source[20], 1); assert.equal(a.series.source[100], 2)
assert.equal(a.series.source[300], 3); assert.equal(a.series.lo80[100], null); assert.ok(a.series.lo80[300] < a.series.harmonized[300])
assert.equal(a.series.naive[100], a.series.rawModisCount[100]); assert.equal(a.series.naive[200], a.series.rawViirsCount[200])

const years = a.calendar.years
assert.equal(years[0], 2000); assert.equal(years.at(-1), 2025)
for (const k of ['value', 'ratio', 'percentile', 'z']) {
  assert.equal(a.calendar[k].length, years.length)
  a.calendar[k].forEach((row) => { assert.equal(row.length, 12); allOf(row, isNumOrNull, `calendar.${k}`) })
}
for (const k of ['median', 'mean', 'q10', 'q25', 'q75', 'q90', 'min', 'max']) { assert.equal(a.climatology[k].length, 12); allOf(a.climatology[k], isNum, `climatology.${k}`) }
for (const k of ['years', 'total', 'complete', 'rank']) assert.equal(a.annual[k].length, years.length)
assert.equal(a.annual.complete.filter(Boolean).length, 25)
assert.equal(a.ytd.year, 2025); assert.equal(a.ytd.throughMonth, 12); assert.equal(a.ytd.current.length, 12)
for (const k of ['median', 'q25', 'q75', 'min', 'max']) assert.equal(a.ytd[k].length, 12)
assert.ok(isNum(a.ytd.rank) && isNum(a.ytd.of) && isNumOrNull(a.ytd.ratio))
const c = a.current
assert.equal(c.m, M_LAST); assert.equal(c.year, 2025); assert.equal(c.month, 12); assert.equal(c.provisional, true)
assert.ok(['normal', 'above', 'well-above', 'extreme', 'below', 'well-below'].includes(c.level))
for (const k of ['value', 'median', 'rank', 'of']) assert.ok(isNum(c[k]), `current.${k}`)
for (const k of ['slopePerYear', 'slopePctPerYear', 'lo', 'hi', 'tau', 'pValue']) assert.ok(isNum(a.trend[k]), `trend.${k}`)
assert.ok(['up', 'down', 'none'].includes(a.trend.direction)); assert.deepEqual(a.trend.years, [2001, 2025])
assert.equal(a.season.peakMonth, 9)
for (const k of ['startMonth', 'endMonth', 'lengthMonths', 'concentration']) assert.ok(isNum(a.season[k]))
assert.equal(a.outlook.months.length, 3); assert.deepEqual(a.outlook.months, [312, 313, 314])
for (const k of ['median', 'lo80', 'hi80', 'climatology']) { assert.equal(a.outlook[k].length, 3); allOf(a.outlook[k], isNum, `outlook.${k}`) }
assert.ok(['anomaly-persistence', 'climatology'].includes(a.outlook.method))
assert.deepEqual(a.seam.overlap, [VIIRS_START, M_LAST]); assert.equal(a.seam.nMonths, M_LAST - VIIRS_START + 1)
assert.ok(Math.abs(a.seam.ratioNaive - 4) < 0.05, `ratioNaive ${a.seam.ratioNaive}`)
assert.ok(Math.abs(a.seam.ratioHarmonized - 1) < 0.05, `ratioHarmonized ${a.seam.ratioHarmonized}`)
assert.ok(a.seam.r > 0.95 && Math.abs(a.seam.biasPct) < 5)
assert.equal(a.records.topMonths.length, 5); assert.equal(a.records.topYears.length, 5)
assert.equal(a.aoi.level, 0); assert.equal(a.aoi.rows, kept); assert.ok(a.aoi.nCells > 200 && a.aoi.nCells < 400)
assert.equal(a.aoi.areaKm2, aoi.areaKm2)

// dn filter: day + night = both.
const day = JSON.parse(kernel.analyze(JSON.stringify({ ...opts, dn: 'day' })))
const night = JSON.parse(kernel.analyze(JSON.stringify({ ...opts, dn: 'night' })))
assert.ok(Math.abs(day.series.harmonized[200] + night.series.harmonized[200] - a.series.harmonized[200]) < 1e-6)

// ---------- cell layer ----------
const layer = kernel.cell_layer(JSON.stringify({ mFrom: 296, mTo: 298, mode: 'harmonized', switchM: SWITCH, baseline: [2003, 2022] }))
const cells = layer.take_cells(), weights = layer.take_weights(), values = layer.take_values()
assert.equal(layer.level, 0); layer.free()
assert.ok(cells instanceof Uint32Array && weights instanceof Float32Array && values instanceof Float32Array)
assert.equal(cells.length, a.aoi.nCells); assert.equal(weights.length, cells.length); assert.equal(values.length, cells.length)
assert.ok(weights.every((w) => w > 0 && w <= 1) && values.every((v) => v >= 0))
const ratio = kernel.cell_layer(JSON.stringify({ mFrom: 296, mTo: 298, mode: 'ratio', switchM: SWITCH, baseline: [2003, 2022] }))
const rv = ratio.take_values(); ratio.free()
assert.ok(rv.every((v) => Number.isNaN(v) || (v > 0.3 && v < 5)), 'ratio values plausible')

// ---------- errors surface as exceptions with readable messages ----------
assert.throws(() => kernel.analyze('{"switchM":1}'), /invalid analyze options/)
assert.throws(() => kernel.set_aoi(Float64Array.from([179, 0, -179, 0, -179, 1, 179, 1]), Uint32Array.from([0])), /antimeridian/)
assert.throws(() => kernel.tiles_for(7), /unknown level/)
assert.throws(() => kernel.ingest_tile(new Uint32Array(2), new Uint16Array(1), new Uint16Array(2), new Uint8Array(2), new Uint32Array(2),
  new Uint32Array(2), new Float32Array(2), new Uint32Array(2), new Uint32Array(2), new Uint32Array(2)), /differ in length/)
assert.throws(() => new Kernel('{"m_first": 1}'), /invalid meta.json/)
// A failed set_aoi keeps the previous AOI; begin() resets the rows: zero rows is still valid output.
kernel.begin(0)
const empty = JSON.parse(kernel.analyze(JSON.stringify(opts)))
assert.equal(empty.aoi.rows, 0); assert.equal(empty.series.harmonized[100], 0); assert.equal(empty.current.ratio, null)
assert.equal(empty.outlook.method, 'climatology')

// ---------- performance: country-sized polygon at L0, ~2 M rows ----------
const big = new Kernel(JSON.stringify(meta))
const ring = []
for (let i = 0; i < 4000; i++) {
  const t = (i / 4000) * 2 * Math.PI, r = 17 + 2 * Math.sin(7 * t) + 0.5 * Math.cos(53 * t)
  ring.push(-55 + r * Math.cos(t), -12 + 0.9 * r * Math.sin(t))
}
t0 = performance.now()
big.set_aoi(Float64Array.from(ring), Uint32Array.from([0]))
const bigTiles = big.tiles_for(0)
const tAoi = performance.now() - t0
big.begin(0)
// 3500 cells × 302 months × 2 = 2.1 M rows inside the AOI, as one synthetic tile.
const N = 3500 * (M_LAST - M_FIRST + 1) * 2
const bt = {
  cell: new Uint32Array(N), stratum: new Uint16Array(N), m: new Uint16Array(N), dn: new Uint8Array(N),
  meq: new Uint32Array(N).fill(150), kv: new Uint32Array(N).fill(140), kvsq: new Float32Array(N).fill(1.96),
  v: new Uint32Array(N).fill(560), nmod: new Uint32Array(N).fill(2), nvii: new Uint32Array(N).fill(8),
}
let r = 0
for (let k = 0; k < 3500; k++) {
  const cell = (1560 + Math.floor(k / 70)) * 7200 + 2500 + (k % 70)
  for (let m = M_FIRST; m <= M_LAST; m++) for (let dn = 0; dn < 2; dn++) {
    bt.cell[r] = cell; bt.stratum[r] = k % 3; bt.m[r] = m; bt.dn[r] = dn; r++
  }
}
t0 = performance.now()
const bigKept = ingest(big, bt)
const tIngest = performance.now() - t0
t0 = performance.now()
const bigJson = big.analyze(JSON.stringify(opts))
const tBig = performance.now() - t0
JSON.parse(bigJson)
assert.equal(bigKept, N)
assert.ok(tBig < 200, `analyze over ${N} rows took ${tBig.toFixed(1)} ms`)

console.log(`ok: ${kept}/${tile.cell.length} rows kept, ${a.aoi.nCells} cells, area ${aoi.areaKm2.toFixed(0)} km²`)
console.log(`   seam ratioNaive ${a.seam.ratioNaive.toFixed(3)}, ratioHarmonized ${a.seam.ratioHarmonized.toFixed(3)}, r ${a.seam.r.toFixed(3)}`)
console.log(`   current ${c.year}-${c.month} value ${c.value.toFixed(1)} (${c.level}, p${c.percentile?.toFixed(0)}), season ${a.season.startMonth}-${a.season.endMonth} peak ${a.season.peakMonth}`)
console.log(`   trend ${a.trend.slopePerYear.toFixed(2)}/yr p=${a.trend.pValue.toFixed(3)} ${a.trend.direction}; outlook ${a.outlook.method} skill ${a.outlook.skill.toFixed(2)}`)
console.log(`   analyze (small AOI) ${tAnalyze.toFixed(1)} ms; JSON ${(kernel.analyze(JSON.stringify(opts)).length / 1024).toFixed(0)} KB`)
console.log(`   big: set_aoi+tiles_for ${tAoi.toFixed(1)} ms (${bigTiles.length} tiles); ingest ${N} rows ${tIngest.toFixed(0)} ms; analyze ${tBig.toFixed(1)} ms`)
