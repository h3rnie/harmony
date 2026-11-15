// Smoke + unit tests for the live NRT proxy (web/server/liveCore.ts, livePlugin.ts) and the pace computation
// (web/src/lib/live/pace.ts). Needs Node >= 24 (runs the .ts sources directly).
//
//   node scripts/live-smoke.mjs --unit                      # offline only: pace, CSV parsing, validation, cache, busy, redaction
//   pnpm --dir web dev --port 5177 --strictPort > live-dev.log 2>&1   # in another terminal (key from .env.local)
//   node scripts/live-smoke.mjs --url http://localhost:5177 --log live-dev.log
//
// HTTP part: ~6 small FIRMS requests (3 through the proxy, 3 direct for comparison) on a ~3 square-degree box.
// TLS: behind an intercepting proxy run with NODE_USE_SYSTEM_CA=1. The key is never printed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }

const core = await import(pathUrl('web/server/liveCore.ts'))
const pace = await import(pathUrl('web/src/lib/live/pace.ts'))
function pathUrl(p) { return new URL('file:///' + path.join(ROOT, p).replace(/\\/g, '/')).href }

let failures = 0
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++ }
const eq = (a, b, msg) => ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`)

// ------------------------------------------------------------------ unit: pace
{
  console.log('\n# pace (hand-made rows)')
  // Reference longitude 0 -> local-solar day == UTC day. Day D = 2026-11-10, now = 2026-11-12 12:00Z.
  const D = Date.UTC(2026, 10, 10) / 1000
  const now = Date.UTC(2026, 10, 12, 12) / 1000
  const windowStart = D - 2 * 86400 // fetched window starts two days before D, so D is complete
  const rows = { n: 0, lat: [], lon: [], t: [], sat: [], conf: [], dn: [] }
  const add = (lat, lon, t, sat, conf, dn) => { rows.lat.push(lat); rows.lon.push(lon); rows.t.push(t); rows.sat.push(sat); rows.conf.push(conf); rows.dn.push(dn); rows.n++ }
  // NOAA-20 on day D: 3 detections in one 0.0125° sub-cell (day) -> 1, same sub-cell at night -> +1, another sub-cell -> +1 = 3
  add(0.001, 0.001, D + 13 * 3600, 0, 2, 0)
  add(0.004, 0.006, D + 13 * 3600, 0, 1, 0)
  add(0.011, 0.002, D + 13 * 3600 + 60, 0, 2, 0)
  add(0.002, 0.003, D + 1 * 3600, 0, 1, 1) // night, same sub-cell
  add(0.020, 0.001, D + 13 * 3600, 0, 1, 0) // second sub-cell (lat 0.02 -> iy + 1)
  add(0.030, 0.001, D + 13 * 3600, 0, 0, 0) // low confidence: ignored for pace
  // NOAA-21 on day D: overlapping sub-cell (counts once for N21), one new = 1 (+1) = 2 ... plus one outside the AOI
  add(0.005, 0.005, D + 12 * 3600, 1, 2, 0)
  add(0.006, 0.007, D + 12 * 3600, 1, 2, 0)
  add(0.040, 0.040, D + 12 * 3600, 1, 1, 0)
  add(5, 5, D + 12 * 3600, 1, 2, 0) // outside AOI
  // MODIS (Terra) on day D: counted as a detection, not used for the pace
  add(0.001, 0.001, D + 10 * 3600, 2, 1, 0)
  const inside = rows.lat.map((la) => (la < 1 ? 1 : 0))
  // Normal: November median 30 AFCD-M in the month -> 1 per day; k for November = 2
  const z = new Array(12).fill(0)
  const med = z.map((_, i) => (i === 10 ? 30 : 0))
  const normal = { median: med, q10: z.map((_, i) => (i === 10 ? 6 : 0)), q25: z.map((_, i) => (i === 10 ? 15 : 0)), q75: z.map((_, i) => (i === 10 ? 45 : 0)), q90: z.map((_, i) => (i === 10 ? 60 : 0)), max: z.map((_, i) => (i === 10 ? 90 : 0)) }
  // Calibration from a series: two Novembers (m = 310, 298) cal 40+20 / raw 20+10 = 2; one October 999/1
  const cal = pace.calibrationFromSeries([298, 309, 310], [20, 999, 40], [10, 1, 20])
  eq(cal.byMonth[10], 2, 'k_eff November = Σcal/Σraw')
  eq(cal.byMonth[9] ?? -1, -1, 'October with Σraw < 10 has no month factor')
  const r = pace.computePace({ rows, inside, dn: 'both', windowStart, now, refLon: 0, sourceOk: { n20: true, n21: true }, calibration: cal, normal, nDays: 3 })
  const day = r.days.find((x) => x.date === '2026-11-10')
  eq(day.perSat[0], 3, 'NOAA-20 sub-cell-days: duplicates in a sub-cell collapse, night counts separately')
  eq(day.perSat[1], 2, 'NOAA-21 sub-cell-days (outside-AOI row excluded)')
  eq(day.viirsCd, 2.5, 'VIIRS cell-days = mean over satellites, never the sum')
  eq(day.value, 5, 'AFCD-M = 2.5 × k 2')
  ok(day.complete, 'day D is complete (inside window, older than latency)')
  const d11 = r.days.find((x) => x.date === '2026-11-11')
  eq(d11.value, 0, 'a reporting day with no fires is 0, not missing')
  ok(d11.complete, 'day D+1 complete')
  ok(!r.days.find((x) => x.date === '2026-11-12').complete, 'today (partial) excluded from the pace')
  eq(r.nComplete, 2, 'two complete days')
  eq(r.pace, 2.5, 'pace = mean(5, 0)')
  eq(r.normalPace, 1, 'normal pace = 30 / 30 days')
  eq(r.ratio, 2.5, 'ratio = 2.5×')
  ok(r.level === 'well-above', `level from the band (q75 1.5/day, q90 2/day, max 3/day) -> ${r.level}`)
  eq(r.detTotal, 9, 'accepted detections inside AOI (low-confidence and outside rows excluded, MODIS included)')
  // day|night split: night only -> NOAA-20 1 sub-cell-day, NOAA-21 0 -> 0.5
  const rn = pace.computePace({ rows, inside, dn: 'night', windowStart, now, refLon: 0, sourceOk: { n20: true, n21: true }, calibration: cal, normal, nDays: 3 })
  eq(rn.days.find((x) => x.date === '2026-11-10').viirsCd, 0.5, 'night filter: mean(1, 0)')
  // a failed source: only NOAA-20 reports -> 3, not 1.5
  const r1 = pace.computePace({ rows, inside, dn: 'both', windowStart, now, refLon: 0, sourceOk: { n20: true, n21: false }, calibration: cal, normal, nDays: 3 })
  eq(r1.days.find((x) => x.date === '2026-11-10').viirsCd, 3, 'failed NOAA-21 source: average over the satellite that reported')
  // local-solar date: an acquisition at 23:00 UTC at lon +30 belongs to the next local day
  eq(pace.localSolarDay(D + 23 * 3600, 30) - D / 86400, 1, 'local-solar date = date(UTC + lon/15 h)')
  // zero baseline -> no ratio
  const r0 = pace.computePace({ rows, inside, dn: 'both', windowStart, now, refLon: 0, sourceOk: { n20: true, n21: true }, calibration: cal, normal: { ...normal, median: z, q25: z, q75: z, q10: z, q90: z, max: z }, nDays: 3 })
  ok(r0.ratio === null && r0.level === null && r0.pace === 2.5, 'zero normal: pace shown, ratio and level null')
  // no calibration -> raw cell-days, no comparison
  const rc = pace.computePace({ rows, inside, dn: 'both', windowStart, now, refLon: 0, sourceOk: { n20: true, n21: true }, calibration: { byMonth: z.map(() => null), all: null }, normal, nDays: 3 })
  ok(rc.calibration === 'none' && rc.pace === 1.25 && rc.ratio === null, 'no calibration: VIIRS cell-days, no ratio')
}

// ------------------------------------------------------------------ unit: core
{
  console.log('\n# core (offline, fake fetch)')
  const { parseFirmsCsv, parseLiveParams, getLive, resetLiveState, redact, LiveError, acqEpoch, plannedCalls, UpstreamFormatError } = core
  eq(acqEpoch('2026-11-14', '455'), Date.UTC(2026, 10, 14, 4, 55) / 1000, 'acq_time "455" -> 04:55')
  eq(acqEpoch('2026-11-14', '0'), Date.UTC(2026, 10, 14, 0, 0) / 1000, 'acq_time "0" -> 00:00')
  const viirs = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n' +
    '-20.1,-60.2,330.1,0.4,0.4,2026-11-14,455,N20,n,2.0NRT,290.1,4.56,N\n-20.2,-60.3,340,0.4,0.4,2026-11-14,1712,N20,h,2.0NRT,300,12.3,D\n-20.3,-60.4,310,0.4,0.4,2026-11-14,1712,N20,l,2.0NRT,300,1.1,D\n'
  const p = parseFirmsCsv(viirs, 'VIIRS_NOAA20_NRT')
  ok(p.t.length === 3 && p.conf.join() === '1,2,0' && p.dn.join() === '1,0,0' && p.sat.join() === '0,0,0', 'VIIRS CSV parsed (conf l/n/h, day|night, sat)')
  const modis = 'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n' +
    '-20,-60,320,1,1,2026-11-14,1405,Terra,29,6.1NRT,300,10,D\n-20,-60,320,1,1,2026-11-14,1405,Aqua,30,6.1NRT,300,10,D\n-20,-60,320,1,1,2026-11-14,1405,Aqua,80,6.1NRT,300,10,D\n'
  const m = parseFirmsCsv(modis, 'MODIS_NRT')
  ok(m.conf.join() === '0,1,2' && m.sat.join() === '2,3,3', 'MODIS confidence <30/30-79/>=80 and Terra/Aqua')
  ok(parseFirmsCsv(viirs.split('\n')[0] + '\n', 'VIIRS_NOAA20_NRT').t.length === 0, 'header-only CSV = 0 rows')
  let threw = false
  try { parseFirmsCsv('Invalid MAP_KEY.', 'MODIS_NRT') } catch (e) { threw = e instanceof UpstreamFormatError }
  ok(threw, '200 with an error message instead of CSV is an upstream error')
  const pc = plannedCalls(7, Date.UTC(2026, 10, 15, 10))
  ok(pc.length === 2 && pc[0].range === 5 && !pc[0].start && pc[1].range === 2 && pc[1].start === '2026-11-09', '7 days -> 5 (ending today) + 2 from 2026-11-09')

  const bad = (q) => { try { parseLiveParams(new URLSearchParams(q)); return null } catch (e) { return e } }
  for (const q of ['', 'bbox=1,2,3', 'bbox=a,b,c,d', 'bbox=-200,0,10,10', 'bbox=10,0,5,5', 'bbox=0,0,1,1&days=0', 'bbox=0,0,1,1&days=8', 'bbox=0,0,1,1&days=2.5', 'bbox=0,0,1,1&foo=1']) {
    const e = bad(q)
    ok(e instanceof LiveError && e.status === 400 && e.code === 'bad_request', `400 for "${q}"`)
  }
  const big = bad('bbox=-80,-40,-40,0&days=1')
  ok(big?.code === 'too_large' && big.extra.limit === 900 && big.extra.area === 1600, 'over-cap bbox -> too_large with limit and area')
  const snapped = parseLiveParams(new URLSearchParams('bbox=-61.3,-20.2,-59.6,-19.1&days=2'))
  ok(snapped.bbox.join() === '-61.5,-20.5,-59.5,-19', `bbox snapped outward to 0.5° (${snapped.bbox.join()})`)

  const KEY = 'abcdef0123456789abcdef0123456789'
  ok(!redact(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/MODIS_NRT/1,2,3,4/1`, KEY).includes(KEY), 'redact() removes the key from URLs')
  // fake upstream: counts calls, VIIRS N21 fails with a key-bearing message
  let calls = 0, usageShare = 0.5
  const fake = async (url) => {
    if (url.includes('mapkey_status')) return new Response(JSON.stringify({ transaction_limit: 5000, current_transactions: usageShare * 5000 }))
    calls++
    await new Promise((r) => setTimeout(r, 20))
    if (url.includes('NOAA21')) return new Response(`Invalid request for key ${KEY}`)
    if (url.includes('MODIS')) return new Response(modis)
    return new Response(viirs)
  }
  resetLiveState()
  const q = () => new URLSearchParams('bbox=-61,-21,-59,-19&days=2')
  const [a1, a2] = await Promise.all([getLive(q(), { FIRMS_MAP_KEY: KEY }, { fetch: fake }), getLive(q(), { FIRMS_MAP_KEY: KEY }, { fetch: fake })])
  ok(calls === 3, `in-flight de-duplication: 2 concurrent requests -> ${calls} upstream calls (3 sources)`)
  ok(a1.n === 6 && a1.sources.VIIRS_NOAA21_NRT.error && a1.sources.VIIRS_NOAA20_NRT.rows === 3, 'partial result: N21 error reported, others served')
  ok(!JSON.stringify(a1).includes(KEY) && !JSON.stringify(a2).includes(KEY), 'key never in the response (upstream message redacted)')
  ok(a2.cached === true, 'concurrent duplicate marked cached')
  const a3 = await getLive(q(), { FIRMS_MAP_KEY: KEY }, { fetch: fake })
  ok(a3.cached && calls === 3, 'second call: cache hit, no upstream request')
  // busy: expire the cache (partial ttl 2 min) and push usage over 90 %
  usageShare = 0.95
  const later = Date.now() + 3 * 60_000 + 61_000
  const a4 = await getLive(q(), { FIRMS_MAP_KEY: KEY }, { fetch: fake, now: () => later })
  ok(a4.stale === true && calls === 3, 'usage > 90 %: stale cache served, no upstream request')
  const e5 = await getLive(new URLSearchParams('bbox=10,10,11,11&days=1'), { FIRMS_MAP_KEY: KEY }, { fetch: fake, now: () => later }).catch((e) => e)
  ok(e5 instanceof LiveError && e5.status === 503 && e5.code === 'busy', 'usage > 90 % without cache: 503 busy')
  const e6 = await getLive(q(), {}, { fetch: fake }).catch((e) => e)
  ok(e6 instanceof LiveError && e6.status === 503 && e6.code === 'no_key', 'missing key: 503 no_key')
  ok(core.liveStatus({}).available === false, 'status without key: available false')
  resetLiveState()

  // A large active box: 7 days = two FIRMS calls per source, 2 x 120k rows for NOAA-20 alone (merged twice).
  // `push(...rows)` used to throw RangeError (argument count) at ~125k elements.
  const ROWS = 120_000
  const bigCsv = viirs.split('\n')[0] + '\n' + '-20.1,-60.2,330.1,0.4,0.4,2026-11-14,455,N20,n,2.0NRT,290.1,4.56,N\n'.repeat(ROWS)
  const header = viirs.split('\n')[0] + '\n'
  const fakeBig = async (url) => {
    if (url.includes('mapkey_status')) return new Response(JSON.stringify({ transaction_limit: 5000, current_transactions: 10 }))
    return new Response(url.includes('NOAA20') ? bigCsv : url.includes('MODIS') ? modis.split('\n')[0] + '\n' : header)
  }
  const big7 = await getLive(new URLSearchParams('bbox=-61,-21,-59,-19&days=7'), { FIRMS_MAP_KEY: KEY }, { fetch: fakeBig }).catch((e) => e)
  ok(!(big7 instanceof Error) && big7.n === 2 * ROWS && big7.lat.length === 2 * ROWS && big7.sources.VIIRS_NOAA20_NRT.rows === 2 * ROWS,
    `>= 200k rows merge without RangeError (${big7 instanceof Error ? `${big7.name}: ${big7.message}` : `n=${big7.n}`})`)
  resetLiveState()
}

// ------------------------------------------------------------------ unit: cross-site guard (core + plugin)
{
  console.log('\n# cross-site guard')
  const so = await import(pathUrl('web/server/sameOrigin.ts'))
  const { assertSameOrigin, LiveError } = core
  const h = (o) => ({ host: 'localhost:5194', ...o })
  ok(so.crossSiteReason(h({})) === null, 'no Origin / Sec-Fetch-Site (curl, scripts): allowed')
  ok(so.crossSiteReason(h({ origin: 'http://localhost:5194', 'sec-fetch-site': 'same-origin' })) === null, 'same-origin Origin: allowed')
  ok(so.crossSiteReason(h({ origin: 'https://evil.example' })) !== null, 'foreign Origin: refused')
  ok(so.crossSiteReason(h({ origin: 'http://localhost:5193' })) !== null, 'same host, other port: refused')
  ok(so.crossSiteReason(h({ origin: 'null' })) !== null, 'opaque Origin "null": refused')
  ok(so.crossSiteReason(h({ 'sec-fetch-site': 'cross-site' })) !== null, 'Sec-Fetch-Site cross-site without Origin: refused')
  ok(so.crossSiteReason(new Headers({ host: 'a.example', origin: 'https://a.example' })) === null && so.crossSiteReason(new Headers({ host: 'a.example', origin: 'https://b.example' })) !== null, 'fetch Headers objects work too')
  let le = null; try { assertSameOrigin(h({ origin: 'https://evil.example' })) } catch (e) { le = e }
  ok(le instanceof LiveError && le.status === 403 && le.code === 'forbidden', 'liveCore.assertSameOrigin -> LiveError 403 forbidden')

  // The Vite plugin handler, driven with fake req/res (no server, no key, no upstream call).
  const { livePlugin } = await import(pathUrl('web/server/livePlugin.ts'))
  let handler = null
  livePlugin({ envDir: path.join(ROOT, 'scripts') }).configureServer({ middlewares: { use: (_route, fn) => { handler = fn } } })
  const call = (url, headers, method = 'GET') => new Promise((resolve) => {
    const res = { statusCode: 0, headersSent: false, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }) } }
    handler({ url, method, headers }, res, () => resolve({ status: 'next' }))
  })
  const r1 = await call('/status', h({ origin: 'https://evil.example' }))
  ok(r1.status === 403 && r1.body.error === 'forbidden', `GET /api/live/status from another origin -> 403 (${r1.status})`)
  const r2 = await call('/?bbox=0,0,1,1&days=1', h({ 'sec-fetch-site': 'cross-site' }))
  ok(r2.status === 403, `GET /api/live with Sec-Fetch-Site cross-site -> 403 (${r2.status})`)
  const r3 = await call('/status', h({ origin: 'http://localhost:5194', 'sec-fetch-site': 'same-origin' }))
  ok(r3.status === 200 && typeof r3.body.available === 'boolean', `same-origin status -> 200 (${r3.status})`)
  const r4 = await call('/status', h({}))
  ok(r4.status === 200, `no Origin (curl) status -> 200 (${r4.status})`)
  const r5 = await call('/', h({}), 'POST')
  ok(r5.status === 405, `no Origin POST -> still 405 (${r5.status})`)
}

// ------------------------------------------------------------------ HTTP against a dev server
if (!flag('unit')) {
  const BASE = (opt('url', 'http://localhost:5177') || '').replace(/\/+$/, '')
  console.log(`\n# HTTP ${BASE}`)
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  const KEY = /^FIRMS_MAP_KEY=\s*"?([^"\r\n]+)"?/m.exec(env)?.[1]?.trim()
  if (!KEY) { console.log('FAIL  no FIRMS_MAP_KEY in .env.local'); process.exit(1) }
  const bodies = []
  const get = async (p, init) => {
    const r = await fetch(BASE + p, init)
    const text = await r.text()
    bodies.push(text + JSON.stringify([...r.headers]))
    let j = null
    try { j = JSON.parse(text) } catch { /* */ }
    return { status: r.status, j, headers: r.headers }
  }
  const usage = async () => {
    const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${KEY}`)
    return (await r.json()).current_transactions
  }
  const u0 = await usage()
  console.log(`info  key usage before: ${u0} / 5000 (shared with other jobs)`)
  if (u0 / 5000 > 0.85) { console.log('SKIP  key usage above 85 %: not adding load'); process.exit(failures ? 1 : 0) }

  const s0 = await get('/api/live/status')
  ok(s0.status === 200 && s0.j?.available === true && s0.j.limits?.maxAreaDeg2 === 900, 'GET /api/live/status -> available, limits')
  const req0 = s0.j?.upstream_requests ?? 0

  const BBOX = '-61.3,-20.2,-59.6,-19.1' // Chaco, Paraguay/Bolivia border
  const t0 = Date.now()
  const r1 = await get(`/api/live?bbox=${BBOX}&days=2`)
  const ms1 = Date.now() - t0
  ok(r1.status === 200 && r1.j?.v === 1, `first call 200 in ${ms1} ms, n=${r1.j?.n}, sources ${JSON.stringify(r1.j?.sources)}`)
  ok(r1.j?.cached === false, 'first call fetched upstream')
  ok(/max-age=\d+/.test(r1.headers.get('cache-control') ?? ''), `Cache-Control: ${r1.headers.get('cache-control')}`)
  const s1 = await get('/api/live/status')
  console.log(`info  upstream requests for the first call: ${s1.j.upstream_requests - req0}`)

  // Direct FIRMS call for the same snapped bbox: row counts must match
  const sb = r1.j.bbox.join(',')
  for (const src of ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT']) {
    const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/${src}/${sb}/2`)
    const text = await r.text()
    const rows = text.startsWith('latitude,') ? text.trim().split('\n').length - 1 : NaN
    ok(rows === r1.j.sources[src].rows, `${src}: proxy ${r1.j.sources[src].rows} rows = direct ${rows}`)
  }

  const r2 = await get(`/api/live?bbox=${BBOX}&days=2`)
  const s2 = await get('/api/live/status')
  ok(r2.status === 200 && r2.j.cached === true && r2.j.n === r1.j.n, 'second call is a cache hit with the same rows')
  ok(s2.j.upstream_requests === s1.j.upstream_requests, `no upstream request for the cache hit (${s1.j.upstream_requests} -> ${s2.j.upstream_requests})`)
  const r2b = await get(`/api/live?bbox=-61.2,-20.4,-59.9,-19.2&days=2`)
  ok(r2b.j?.cached === true, 'a nearby bbox snapping to the same 0.5° box shares the cache entry')
  ok(s2.j.latest_t === r1.j.latest_t, 'status reports latest_t from the cache')

  for (const q of ['', '?bbox=1,2,3', '?bbox=x,1,2,3', '?bbox=-200,0,1,1', '?bbox=10,0,5,5', `?bbox=${BBOX}&days=9`, `?bbox=${BBOX}&days=0`]) {
    const r = await get(`/api/live${q}`)
    ok(r.status === 400 && r.j?.error === 'bad_request', `400 for "${q || '(no params)'}": ${r.j?.detail}`)
  }
  const big = await get('/api/live?bbox=-80,-40,-40,0&days=1')
  ok(big.status === 400 && big.j?.error === 'too_large' && big.j.limit === 900, `over-cap -> 400 too_large, limit ${big.j?.limit}, area ${big.j?.area}`)
  const post = await get('/api/live?bbox=0,0,1,1', { method: 'POST' })
  ok(post.status === 405, 'POST -> 405')

  ok(bodies.every((b) => !b.includes(KEY)), `key absent from all ${bodies.length} responses (bodies + headers)`)
  const logPath = opt('log')
  if (logPath) {
    const log = fs.readFileSync(logPath, 'utf8')
    ok(!log.includes(KEY), `key absent from the dev-server log (${log.split('\n').filter((l) => l.includes('[live]')).length} [live] lines)`)
  }
  const u1 = await usage()
  console.log(`info  key usage after: ${u1} / 5000 (delta ${u1 - u0}, includes other jobs on the same key)`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
