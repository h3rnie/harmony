// Node test for the Hotspots CSV export core (web/src/lib/export/hotspotsCore.ts).
//
// Runs the real selection + row-group pruning + exact filtering code against real point files served over local HTTP
// (with Range support and byte accounting), for a polygon with a hole in Paraguay, and cross-checks the result
// against DuckDB (spatial) reading the same files.
//
//   node scripts/hotspots-export-test.mjs [--data data/dist/points] [--no-duckdb]
//
// Needs Node >= 22.15 (type stripping + module.registerHooks) and `uv` with the pipeline env (duckdb) for the cross-check.
// Source files are first copied to a scratch folder so a pipeline run replacing data/dist cannot change them mid-test.
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argVal = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const dataDir = path.resolve(root, argVal('--data', 'data/dist/points'))
const useDuck = !args.includes('--no-duckdb')

// The app imports '../geo' without extension (bundler resolution); teach Node to find the .ts file.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context) } catch { /* fall through */ }
    }
    return nextResolve(specifier, context)
  },
})
const core = await import(pathToFileURL(path.join(root, 'web/src/lib/export/hotspotsCore.ts')).href)
const { toM } = await import(pathToFileURL(path.join(root, 'web/src/lib/format.ts')).href)

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failures++
}
const mb = (b) => `${(b / 1e6).toFixed(2)} MB`

// ---- scenario -------------------------------------------------------------
// Chaco / northern Paraguay: straddles lon -60 and lat -20, so it needs 4 tiles (11_6, 11_7, 12_6, 12_7).
const outer = [[-61.5, -22.5], [-58.0, -23.0], [-56.5, -20.5], [-59.5, -18.5], [-62.0, -20.0], [-61.5, -22.5]]
const hole = [[-60.5, -21.5], [-59.0, -21.5], [-59.0, -20.2], [-60.5, -20.2], [-60.5, -21.5]]
const rings = [outer, hole]
const wkt = `POLYGON((${outer.map((p) => p.join(' ')).join(',')}),(${hole.map((p) => p.join(' ')).join(',')}))`
const TILES = ['11_6', '11_7', '12_6', '12_7']
const YEARS = [2022, 2023]

// ---- stage a stable copy of the files ---------------------------------------
const srcIndex = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'))
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-hotspots-'))
const index = {}
const stagedFiles = []
for (const t of TILES) {
  for (const y of YEARS) {
    const src = path.join(dataDir, t, `${y}.parquet`)
    if (!srcIndex[t]?.[y] || !fs.existsSync(src)) continue
    fs.mkdirSync(path.join(stage, 'points', t), { recursive: true })
    const dst = path.join(stage, 'points', t, `${y}.parquet`)
    fs.copyFileSync(src, dst)
    const bytes = fs.statSync(dst).size
    ;(index[t] ??= {})[y] = [bytes, srcIndex[t][y][1]]
    stagedFiles.push(dst)
  }
}
fs.writeFileSync(path.join(stage, 'points', 'index.json'), JSON.stringify(index))
if (!stagedFiles.length) { console.error(`No point files found under ${dataDir}`); process.exit(2) }
console.log(`staged ${stagedFiles.length} files (${mb(stagedFiles.reduce((a, f) => a + fs.statSync(f).size, 0))}) in ${stage}`)

// ---- local HTTP server with Range support and byte accounting ---------------
let served = 0, requests = 0
const server = createServer((req, res) => {
  const file = path.join(stage, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!file.startsWith(stage) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
  const size = fs.statSync(file).size
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  requests++
  if (m) {
    const start = m[1] === '' ? size - Number(m[2]) : Number(m[1])
    const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream' })
    served += end - start + 1
    fs.createReadStream(file, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' })
    served += size
    fs.createReadStream(file).pipe(res)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const resetServed = () => { served = 0; requests = 0 }

// ---- DuckDB reference -------------------------------------------------------
function duck(files, fromIso, toIso) {
  const code = `
import duckdb, json, sys, hashlib
cfg = json.load(sys.stdin)
con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial")
rows = con.execute(
  "SELECT latitude, longitude, strftime(acq_time_utc, '%Y-%m-%d'), strftime(acq_time_utc, '%H%M'), satellite, frp, used "
  "FROM read_parquet(?) WHERE acq_time_utc >= CAST(? AS TIMESTAMP) AND acq_time_utc < CAST(? AS TIMESTAMP) "
  "AND ST_Within(ST_Point(longitude, latitude), ST_GeomFromText(?))",
  [cfg['files'], cfg['from'], cfg['to'], cfg['wkt']]).fetchall()
def num(x):
    t = repr(x)
    return t[:-2] if t.endswith('.0') else t
lines = sorted(f"{num(r[0])},{num(r[1])},{r[2]},{r[3]},{r[4]}" for r in rows)
print(json.dumps({"count": len(rows), "frp": sum(r[5] or 0 for r in rows), "used": sum(1 for r in rows if r[6]),
  "sha": hashlib.sha1("\\n".join(lines).encode()).hexdigest()}))
`
  const env = { ...process.env, PATH: `${process.env.HOME ?? os.homedir()}/.local/bin${path.delimiter}${process.env.PATH}`, UV_SYSTEM_CERTS: 'true' }
  const r = spawnSync('uv', ['run', 'python', '-c', code], {
    cwd: path.join(root, 'pipeline'), env, input: JSON.stringify({ files, from: fromIso, to: toIso, wkt }), encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`duckdb failed: ${r.stderr || r.error}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

// ---- CSV parsing of our own output -------------------------------------------
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l !== '')
  const comments = lines.filter((l) => l.startsWith('#'))
  const body = lines.filter((l) => !l.startsWith('#'))
  return { comments, header: body[0], rows: body.slice(1).map((l) => l.split(',')) }
}
const fetchImpl = (url, init) => fetch(url, init)
const common = { index, baseUrl, fetch: fetchImpl }
const ACK = 'TEST-ACK'

async function scenario(name, mFrom, mTo, fromIso, toIso) {
  console.log(`\n== ${name} ==`)
  resetServed()
  const t0 = Date.now()
  const out = await core.exportHotspots({ rings, mFrom, mTo }, { ...common, ack: ACK, label: 'Chaco test polygon' })
  check(out.kind === 'ok', 'export returned a CSV')
  const text = await out.blob.text()
  const { comments, header, rows } = parseCsv(text)
  const refs = core.selectFiles(index, [-62, -23, -56.5, -18.5], mFrom, mTo)
  const selectedBytes = refs.reduce((a, r) => a + r.bytes, 0)
  console.log(`   ${out.rows} rows, ${out.files} files read of ${refs.length} selected, ${out.groupsRead} row groups, ${Date.now() - t0} ms`)
  console.log(`   fetched ${mb(served)} in ${requests} requests (core counter ${mb(out.bytesFetched)}); selected files total ${mb(selectedBytes)} -> ${(100 * served / selectedBytes).toFixed(1)}% of bytes`)
  check(header === core.CSV_COLUMNS.join(','), 'column header row matches the contract order')
  check(rows.length === out.rows, `data rows (${rows.length}) equals reported row count (${out.rows})`)
  check(rows.every((r) => r.length === core.CSV_COLUMNS.length), 'every row has 17 fields')
  check(comments.some((c) => c.includes('used_in_harmonized=false')) && comments.some((c) => c.includes(ACK)) && comments.some((c) => c.startsWith('# Rows: ')), 'header carries the used_in_harmonized note, the acknowledgement and the row count')
  check(out.bytesFetched === served, `byte accounting matches the server (${out.bytesFetched} vs ${served})`)
  return { out, text, rows, refs, selectedBytes }
}

try {
  const results = []
  for (const sc of [
    { name: 'Sep 2023', from: toM(2023, 9), to: toM(2023, 9), a: '2023-09-01', b: '2023-10-01' },
    { name: 'Dec 2022 - Feb 2023 (crosses a year file boundary)', from: toM(2022, 12), to: toM(2023, 2), a: '2022-12-01', b: '2023-03-01' },
  ]) {
    const r = await scenario(sc.name, sc.from, sc.to, sc.a, sc.b)
    results.push(r)
    if (useDuck) {
      const files = r.refs.map((f) => path.join(stage, 'points', f.key, `${f.year}.parquet`).replaceAll('\\', '/'))
      const d = duck(files, sc.a, sc.b)
      console.log(`   DuckDB: ${d.count} rows (used ${d.used}, sum frp ${d.frp.toFixed(3)})`)
      check(r.out.rows === d.count, `row count equals DuckDB (${r.out.rows} vs ${d.count})`)
      const usedCsv = r.rows.filter((x) => x[16] === 'true').length
      check(usedCsv === d.used, `used_in_harmonized=true count equals DuckDB (${usedCsv} vs ${d.used})`)
      const frp = r.rows.reduce((a, x) => a + (Number(x[7]) || 0), 0)
      check(Math.abs(frp - d.frp) <= 1e-5 * Math.max(1, d.frp), `sum(frp) equals DuckDB (${frp.toFixed(3)} vs ${d.frp.toFixed(3)})`)
      const lines = r.rows.map((x) => `${x[0]},${x[1]},${x[2]},${x[3]},${x[4]}`).sort()
      const sha = createHash('sha1').update(lines.join('\n')).digest('hex')
      check(sha === d.sha, 'sorted (lat, lon, date, time, satellite) tuples hash identically to DuckDB')
    }
    check(r.rows.length > 0, 'scenario is non-trivial (rows > 0)')
  }

  console.log('\n== pruning, stats, determinism ==')
  resetServed()
  const m1 = toM(2023, 9)
  const plan = await core.planHotspotExport({ rings, mFrom: m1, mTo: m1 }, { ...common })
  console.log(`   plan: ${plan.files.length}/${plan.filesConsidered} files, ${plan.keptGroups}/${plan.totalGroups} row groups, est ${plan.estRows} rows (likely ~${plan.likelyRows}), est download ${mb(plan.estDownloadBytes)}, footers ${mb(plan.metaBytes)}`)
  check(plan.groupsWithoutStats === 0, 'latitude/longitude row-group statistics present in every group')
  check(served === plan.metaBytes, `planning fetched only footers (${served} bytes)`)
  check(plan.keptGroups < plan.totalGroups, `row-group pruning removed groups (${plan.keptGroups} of ${plan.totalGroups} kept)`)
  const planAgain = await core.planHotspotExport({ rings, mFrom: m1, mTo: m1 }, { ...common })
  const a = await core.runHotspotExport(plan, { ack: ACK, now: () => new Date(0) })
  const b = await core.runHotspotExport(planAgain, { ack: ACK, now: () => new Date(0) })
  check((await a.blob.text()) === (await b.blob.text()), 'two runs produce byte-identical output (deterministic order)')
  const full = (await a.blob.text())
  check(a.rows <= plan.estRows, `rows (${a.rows}) <= estimate (${plan.estRows})`)

  console.log('\n== too-large guard and truncation ==')
  resetServed()
  const tooBig = await core.exportHotspots({ rings, mFrom: m1, mTo: m1 }, { ...common, ack: ACK, maxRows: 100 })
  check(tooBig.kind === 'too-large' && tooBig.estimatedRows === plan.estRows && tooBig.maxRows === 100, `too-large result carries the estimate (${tooBig.estimatedRows})`)
  check(served === tooBig.plan.metaBytes, `no row data downloaded before refusing (${served} bytes = footers only)`)
  const forced = await core.exportHotspots({ rings, mFrom: m1, mTo: m1 }, { ...common, ack: ACK, maxRows: 100, force: true, now: () => new Date(0) })
  const ft = parseCsv(await forced.blob.text())
  check(forced.kind === 'ok' && forced.truncated && forced.rows === 100 && ft.rows.length === 100, 'force exports exactly the first 100 rows, flagged truncated')
  const fullRows = parseCsv(full).rows.slice(0, 100).map((r) => r.join(','))
  check(ft.rows.map((r) => r.join(',')).join('\n') === fullRows.join('\n'), 'truncated output equals the head of the full output')
  check(ft.comments.some((c) => c.includes('truncated')), 'header says the file is truncated')

  console.log('\n== cancellation ==')
  const ctl = new AbortController()
  const plan3 = await core.planHotspotExport({ rings, mFrom: m1, mTo: m1 }, { ...common, signal: ctl.signal })
  let aborted = false
  try {
    await core.runHotspotExport(plan3, { ack: ACK, signal: ctl.signal, onProgress: () => ctl.abort() })
  } catch (e) { aborted = core.isAbort(e) }
  check(aborted, 'abort signal stops the run with an AbortError')

  console.log(`\nbytes: this test fetched at most ${mb(served)} in the last stage; see per-scenario lines above for pruning effectiveness.`)
} finally {
  server.close()
  // leave the scratch copy in place only on failure, for inspection
  if (!failures) {
    for (const f of stagedFiles) fs.unlinkSync(f)
    fs.unlinkSync(path.join(stage, 'points', 'index.json'))
    for (const t of TILES) { try { fs.rmdirSync(path.join(stage, 'points', t)) } catch { /* not staged */ } }
    try { fs.rmdirSync(path.join(stage, 'points')); fs.rmdirSync(stage) } catch { /* ignore */ }
  } else console.log(`scratch files kept in ${stage}`)
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
