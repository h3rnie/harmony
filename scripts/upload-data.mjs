// Upload the pipeline output (data/dist) to a Cloudflare R2 bucket under an immutable, versioned prefix.
//
//   node scripts/upload-data.mjs --help
//
// Every object goes to v/<version>/<path under data/dist>; the app is built with
// VITE_DATA_BASE=<R2_PUBLIC_BASE>/v/<version>. Two backends: the S3 API (R2 access keys) or the
// Cloudflare CLI `cf` (its own login). See printHelp() for flags and the order of use.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE = path.join(ROOT, 'data', 'dist')
const CORS_FILE = path.join(ROOT, 'scripts', 'r2-cors.json')
const MANIFEST_FILE = process.env.R2_MANIFEST ? path.resolve(process.env.R2_MANIFEST) : path.join(ROOT, '.cache', 'r2-upload-manifest.json')
const APP_ORIGIN = 'https://harmony.hernie.me'
const PREVIEW_ORIGIN_SAMPLE = 'https://harmony-git-main-her.vercel.app'
const FOREIGN_ORIGIN_SAMPLE = 'https://example.com'
const CACHE_CONTROL = 'public, max-age=31536000, immutable'
const BUFFER_LIMIT = 16 * 1024 * 1024 // S3: read whole file into memory below this size
const MULTIPART_THRESHOLD = 64 * 1024 * 1024 // S3: lib-storage multipart upload above this size
const PART_SIZE = 16 * 1024 * 1024
const CLI_MAX_OBJECT = 300 * 1000 * 1000 // cf r2 objects put (REST API) limit
const CLI_TIMEOUT_MS = 30 * 60 * 1000
const MAX_ATTEMPTS = 6
const REQUIRED_S3 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']
const REQUIRED_CLI = ['R2_BUCKET']
let SECRETS = [] // values redacted from any printed error text

const CONTENT_TYPES = {
  '.parquet': 'application/vnd.apache.parquet',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
  '.f32': 'application/octet-stream',
  '.u16': 'application/octet-stream',
  '.bin': 'application/octet-stream',
}

function printHelp() {
  console.log(`Upload data/dist to Cloudflare R2 under an immutable versioned prefix.

Usage: node scripts/upload-data.mjs [flags]      (or: pnpm upload:data [flags])

Layout
  Every file data/dist/<rel> is stored as  v/<version>/<rel>, meant to be served with
  Cache-Control: "${CACHE_CONTROL}" (a version prefix is never rewritten).
  The app is then built with  VITE_DATA_BASE=<R2_PUBLIC_BASE>/v/<version>.
  A data refresh = upload a new version, then redeploy the app with the new base.

Backends (--backend auto|s3|cli, default auto = s3 when R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are set, else cli)
  s3   S3 API with R2 access keys. Sets Content-Type, Cache-Control and an "md5" metadata field per object;
       resumes by HEADing each object (skip when size and MD5 match). Multipart above ${MULTIPART_THRESHOLD / 1048576} MB.
  cli  Cloudflare CLI: one "cf r2 objects put <key> --bucket-name <bucket> --file <path> --content-type <type>"
       per object (uses the CLI's own login; R2_ACCOUNT_ID, when set, is passed as CLOUDFLARE_ACCOUNT_ID).
       The REST endpoint behind it cannot set Cache-Control: add a Response Header Transform Rule on the
       custom domain (Cache-Control: ${CACHE_CONTROL}).
       Resumes from a local manifest (${path.relative(ROOT, MANIFEST_FILE).split(path.sep).join('/')}, JSON lines, appended after every
       successful upload); entries whose bucket, size and MD5 match are skipped. Max ${CLI_MAX_OBJECT / 1e6} MB per object.
       The first object is uploaded alone and fetched back through R2_PUBLIC_BASE (canary) before the rest;
       every upload's reported key is compared with the intended key, and a mismatch aborts the run.
       The cf binary is found on PATH (npm global install) or given by CF_BIN.

Flags
  --dry-run              List what would be uploaded (counts, bytes per top-level dir, sample keys with
                         Content-Type / Cache-Control). No credentials needed, no network calls.
  --version <id>         Version id, [A-Za-z0-9._-]{1,64}. Default: data/dist/meta.json "generated"
                         (e.g. 2026-11-15T11:07:45Z -> 20261115T110745Z). Runs that upload parts of
                         the same dataset (tiles first, points later) MUST pass the same --version.
  --prefix <p>           Only files whose path under data/dist starts with <p>. Repeatable,
                         e.g. --prefix tiles/ --prefix overview/ --prefix meta.json
  --backend <b>          auto | s3 | cli (see above).
  --concurrency <n>      Parallel object uploads (default 16 for s3, 8 for cli).
  --force                cli: ignore the manifest and upload everything again.
  --cf-dry-run           cli: run every "cf ..." command with the CLI's own --dry-run (no writes, manifest
                         untouched); reports the request URL the CLI would use and per-call timing.
  --source <dir>         Source directory (default data/dist).
  --upload               Upload (the default action when neither --cors nor --verify is given;
                         pass it explicitly to combine with them).
  --cors                 Apply scripts/r2-cors.json to the bucket and print the rules read back.
                         s3: PutBucketCors, needs a token with "Admin Read & Write".
                         cli: "cf r2 buckets cors update <bucket> --rules <json> --force", then "cors get".
                         Alternatively paste the JSON into R2 > bucket > Settings > CORS policy.
  --verify               s3: list v/<version>/ (respecting --prefix) and compare object count and bytes.
                         cli: ranged GET (bytes=0-0) of every selected object through R2_PUBLIC_BASE,
                         checking presence and size, plus manifest coverage.
                         Both: ranged GET with Origin ${APP_ORIGIN} on meta.json and one parquet
                         file, plus CORS preflights. Prints PASS/FAIL per check; exits non-zero on any FAIL.
  --help                 This text.

  Actions run in the order cors -> upload -> verify.
  Retries use exponential backoff with jitter on 5xx, throttling, network errors and (cli) non-zero exits.

Configuration (process env, else .env.local, else .env in the repo root)
  R2_BUCKET        required for every backend
  R2_ACCOUNT_ID    required for s3; optional for cli (passed to cf as CLOUDFLARE_ACCOUNT_ID)
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   s3 only
  R2_PUBLIC_BASE   public custom-domain base (e.g. https://data.harmony.hernie.me); required for --verify
                   and for the cli canary
  R2_ENDPOINT      optional S3 endpoint override (testing); default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
  CF_BIN           optional path to the cf CLI entry script (…/node_modules/cf/bin/cf)
  R2_MANIFEST      optional manifest path override (testing)
  See docs/DEPLOYMENT.md.

Order of use
  1. node scripts/upload-data.mjs --dry-run
  2. node scripts/upload-data.mjs --cors                                   (once per bucket)
  3. node scripts/upload-data.mjs --version <V> --prefix tiles/ --prefix overview/ --prefix ml/ \\
       --prefix meta.json --prefix watch.json --prefix validation.json
  4. node scripts/upload-data.mjs --version <V> --prefix points/          (~11 GB; resumable)
  5. node scripts/upload-data.mjs --version <V> --verify
  6. Set VITE_DATA_BASE=<R2_PUBLIC_BASE>/v/<V> for the web build (Vercel) and redeploy.

CORS note
  scripts/r2-cors.json allows ${APP_ORIGIN}, the Vercel preview origins via the single-wildcard
  pattern https://harmony-*-her.vercel.app (covers harmony-<hash>-her and harmony-git-<branch>-her),
  and localhost:5173/4173 (dev/preview). Cloudflare documents "at most one * wildcard" per origin
  pattern, which may span periods, but only shows it as a leading subdomain (https://*.example.com);
  a mid-hostname wildcard follows the stated rule but is not shown in an example. --verify sends a
  preflight from ${PREVIEW_ORIGIN_SAMPLE} to confirm it. If R2 rejects or ignores the
  pattern, replace it with explicit preview origins (e.g. ${PREVIEW_ORIGIN_SAMPLE}).
  After changing CORS, purge the custom domain's cache: cached responses keep their old CORS headers.`)
}

// ------------------------------------------------------------------ args

let args
try {
  const argv = process.argv.slice(2)
  if (argv[0] === '--') argv.shift() // `pnpm upload:data -- --flag` passes the separator through
  args = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      version: { type: 'string' },
      prefix: { type: 'string', multiple: true, default: [] },
      backend: { type: 'string', default: 'auto' },
      concurrency: { type: 'string' },
      force: { type: 'boolean', default: false },
      'cf-dry-run': { type: 'boolean', default: false },
      source: { type: 'string' },
      upload: { type: 'boolean', default: false },
      cors: { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  }).values
} catch (e) {
  fail(`${e.message}\nRun with --help for usage.`)
}

if (args.help) {
  printHelp()
  process.exit(0)
}

if (!['auto', 's3', 'cli'].includes(args.backend)) fail('--backend must be auto, s3 or cli')
const sourceDir = path.resolve(args.source ?? DEFAULT_SOURCE)
const prefixes = args.prefix.map((p) => p.replace(/\\/g, '/').replace(/^\.?\//, ''))
const doCors = args.cors
const doVerify = args.verify
const doUpload = args.upload || (!doCors && !doVerify)
const cfDryRun = args['cf-dry-run']

// ------------------------------------------------------------------ helpers

function fail(msg, code = 1) {
  console.error(`error: ${redact(String(msg))}`)
  process.exit(code)
}

function redact(s) {
  let out = s
  for (const v of SECRETS) if (v && v.length >= 4) out = out.split(v).join('***')
  return out
}

/** Short, token-free excerpt of CLI output (never print raw CLI output). */
function sanitizeCliText(text) {
  const plain = String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, '<redacted>')
  const line = plain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => !/^at\s/.test(l)) ?? ''
  return redact(line).slice(0, 200)
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}h${String(m).padStart(2, '0')}m${String(r).padStart(2, '0')}s` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function contentTypeFor(rel) {
  return CONTENT_TYPES[path.extname(rel).toLowerCase()] ?? 'application/octet-stream'
}

/** Minimal KEY=VALUE parser (comments, blank lines, optional `export`, optional quotes). */
function parseEnvFile(file) {
  const out = {}
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

function loadConfig(names) {
  const files = [parseEnvFile(path.join(ROOT, '.env.local')), parseEnvFile(path.join(ROOT, '.env'))]
  const cfg = {}
  for (const n of names) {
    const candidates = [process.env[n], ...files.map((f) => f[n])]
    cfg[n] = candidates.map((v) => (v ?? '').trim()).find((v) => v !== '') ?? ''
  }
  return cfg
}

const ALL_CONFIG = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE', 'R2_ENDPOINT']

function chooseBackend(cfg) {
  if (args.backend !== 'auto') return args.backend
  return cfg.R2_ACCESS_KEY_ID && cfg.R2_SECRET_ACCESS_KEY ? 's3' : 'cli'
}

function requireConfig(backend, needPublic) {
  const cfg = loadConfig(ALL_CONFIG)
  SECRETS = [cfg.R2_SECRET_ACCESS_KEY, cfg.R2_ACCESS_KEY_ID, cfg.R2_ACCOUNT_ID]
  const required = [...(backend === 's3' ? REQUIRED_S3 : REQUIRED_CLI), ...(needPublic ? ['R2_PUBLIC_BASE'] : [])]
  const missing = required.filter((n) => !cfg[n])
  if (missing.length) {
    fail(`missing or empty R2 configuration for the ${backend} backend: ${missing.join(', ')}.\n` +
      'Set them in the environment or in .env.local / .env at the repo root (see docs/DEPLOYMENT.md).\n' +
      '--dry-run works without credentials.', 2)
  }
  if (cfg.R2_PUBLIC_BASE) cfg.R2_PUBLIC_BASE = cfg.R2_PUBLIC_BASE.replace(/\/+$/, '')
  return cfg
}

function deriveVersion() {
  if (args.version !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(args.version)) fail('--version must match [A-Za-z0-9._-]{1,64}')
    return { version: args.version, from: '--version' }
  }
  let meta
  try { meta = JSON.parse(fs.readFileSync(path.join(sourceDir, 'meta.json'), 'utf8')) } catch (e) {
    fail(`cannot read ${path.join(sourceDir, 'meta.json')} to derive the version (${e.code ?? e.message}); pass --version <id>`)
  }
  const g = typeof meta.generated === 'string' ? meta.generated : ''
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(g)
  if (!m) fail(`meta.json "generated" (${JSON.stringify(g)}) is not an ISO UTC timestamp; pass --version <id>`)
  return { version: `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`, from: `meta.json generated=${g}` }
}

async function walk(dir) {
  const out = []
  const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile()) continue
    const abs = path.join(e.parentPath ?? e.path, e.name)
    const rel = path.relative(dir, abs).split(path.sep).join('/')
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue // temp / hidden files
    out.push({ rel, abs })
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

async function localFiles() {
  let all
  try { all = await walk(sourceDir) } catch (e) { fail(`cannot read source directory ${sourceDir} (${e.code ?? e.message})`) }
  const sel = prefixes.length ? all.filter((f) => prefixes.some((p) => f.rel.startsWith(p))) : all
  await Promise.all(sel.map(async (f) => { f.size = (await fsp.stat(f.abs)).size }))
  return { all, sel }
}

function topDir(rel) {
  const i = rel.indexOf('/')
  return i < 0 ? '(root files)' : rel.slice(0, i) + '/'
}

function summarizeByTop(files) {
  const m = new Map()
  for (const f of files) {
    const k = topDir(f.rel)
    const e = m.get(k) ?? { count: 0, bytes: 0 }
    e.count++
    e.bytes += f.size
    m.set(k, e)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function printTable(rows, total) {
  const w = Math.max(14, ...rows.map(([k]) => k.length))
  for (const [k, e] of rows) console.log(`  ${k.padEnd(w)} ${String(e.count).padStart(7)} objects ${fmtBytes(e.bytes).padStart(10)}  (${e.bytes} B)`)
  console.log(`  ${'TOTAL'.padEnd(w)} ${String(total.count).padStart(7)} objects ${fmtBytes(total.bytes).padStart(10)}  (${total.bytes} B)`)
}

function md5File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5')
    fs.createReadStream(abs)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
  })
}

function httpStatus(err) {
  return err?.$metadata?.httpStatusCode ?? err?.$response?.statusCode ?? err?.status
}

const FATAL_NAMES = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized', 'NoSuchBucket', 'InvalidBucketName', 'KeyMismatch', 'CliAuth'])
function isFatal(err) {
  const s = httpStatus(err)
  return s === 401 || s === 403 || FATAL_NAMES.has(err?.name) || FATAL_NAMES.has(err?.Code)
}

const TRANSIENT_NAMES = new Set(['SlowDown', 'Throttling', 'ThrottlingException', 'TooManyRequests', 'TooManyRequestsException',
  'RequestTimeout', 'RequestTimeoutException', 'ServiceUnavailable', 'InternalError', 'InternalServerError', 'TimeoutError',
  'NetworkingError', 'BadDigest', 'CliTransient'])
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
function isTransient(err) {
  const s = httpStatus(err)
  if (s === 429 || (s >= 500 && s < 600)) return true
  if (TRANSIENT_NAMES.has(err?.name) || TRANSIENT_NAMES.has(err?.Code)) return true
  const code = err?.code ?? err?.cause?.code
  if (code && TRANSIENT_CODES.has(code)) return true
  return err?.$retryable !== undefined
}

function describeErr(err) {
  const s = httpStatus(err)
  const parts = [err?.name ?? 'Error']
  if (s) parts.push(`HTTP ${s}`)
  if (err?.code) parts.push(err.code)
  if (err?.message && err.message !== err.name) parts.push(err.message)
  return redact(parts.join(': ')).slice(0, 300)
}

let aborted = null
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isFatal(err)) { aborted ??= err; throw err }
      if (attempt >= MAX_ATTEMPTS || !isTransient(err) || aborted) throw err
      const delay = Math.random() * Math.min(30_000, 500 * 2 ** (attempt - 1)) + 100
      await sleep(delay)
    }
  }
}

async function pool(items, n, fn) {
  let next = 0
  const worker = async () => {
    while (!aborted && next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

// ------------------------------------------------------------------ cf CLI plumbing

function isNodeScript(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(80)
    fs.readSync(fd, b, 0, 80, 0)
    fs.closeSync(fd)
    return /^#!.*\bnode\b/.test(b.toString('utf8'))
  } catch { return false }
}

/** Locate the cf CLI without going through a shell (.cmd wrappers cannot be spawned without one). */
function resolveCf() {
  const wrap = (f) => (/\.[cm]?js$/i.test(f) || isNodeScript(f) ? { cmd: process.execPath, pre: [f], where: f } : { cmd: f, pre: [], where: f })
  const explicit = process.env.CF_BIN
  if (explicit) {
    if (/\.(cmd|bat|ps1)$/i.test(explicit)) fail('CF_BIN must point to the cf entry script (…/node_modules/cf/bin/cf) or a native executable, not a .cmd/.bat/.ps1 wrapper')
    if (!fs.existsSync(explicit)) fail(`CF_BIN does not exist: ${explicit}`)
    return wrap(path.resolve(explicit))
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const entry = path.join(dir, 'node_modules', 'cf', 'bin', 'cf') // npm global prefix layout (Windows)
    if (fs.existsSync(entry) && ['cf', 'cf.cmd'].some((n) => fs.existsSync(path.join(dir, n)))) return wrap(entry)
    const bin = path.join(dir, process.platform === 'win32' ? 'cf.exe' : 'cf')
    if (fs.existsSync(bin)) {
      const real = fs.realpathSync(bin)
      return wrap(real)
    }
  }
  fail('cf CLI not found on PATH; install it (npm i -g cf) and log in, or set CF_BIN')
}

let CF = null
let cfEnv = null
let cfCalls = 0
let cfMsTotal = 0

/** Run cf without a shell; capture output only for classification and parsing. */
function runCf(cliArgs, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(CF.cmd, [...CF.pre, ...cliArgs], { env: cfEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out = []
    const err = []
    let outLen = 0
    let errLen = 0
    const cap = 1 << 20
    child.stdout.on('data', (d) => { if (outLen < cap) { out.push(d); outLen += d.length } })
    child.stderr.on('data', (d) => { if (errLen < cap) { err.push(d); errLen += d.length } })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const done = (code, spawnError) => {
      clearTimeout(timer)
      const ms = Date.now() - t0
      cfCalls++
      cfMsTotal += ms
      resolve({ code, spawnError, ms, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    }
    child.on('error', (e) => done(-1, e))
    child.on('close', (code, signal) => done(code ?? (signal ? -2 : -1)))
  })
}

function cliError(r, what) {
  const text = `${r.stderr}\n${r.stdout}`
  const e = new Error(`${what}: cf exited ${r.code}${r.spawnError ? ` (${r.spawnError.code ?? r.spawnError.message})` : ''}: ${sanitizeCliText(r.stderr || r.stdout) || '(no output)'}`)
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|authentication error|not logged in|cf auth login|invalid (api )?token|bucket (does not exist|not found)|no such bucket/i.test(text)) e.name = 'CliAuth'
  else if (/empty file|cannot read invalid|ENOENT/i.test(text)) e.name = 'CliLocal'
  else e.name = 'CliTransient' // includes 429 / 5xx / network text and any other non-zero exit: retried with backoff
  return e
}

function parseJsonLoose(text) {
  const t = text.trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { /* fall through */ }
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)) } catch { /* ignore */ } }
  return null
}

// ------------------------------------------------------------------ main

const { version, from: versionFrom } = deriveVersion()
const keyPrefix = `v/${version}/`
const keyFor = (rel) => keyPrefix + rel

const { all, sel } = await localFiles()
if (!sel.length && (doUpload || doVerify)) fail(`no files under ${sourceDir}${prefixes.length ? ` match --prefix ${prefixes.join(' ')}` : ''}`)
const localTotal = { count: sel.length, bytes: sel.reduce((a, f) => a + f.size, 0) }

console.log(`source   ${sourceDir}`)
console.log(`version  ${version}  (${versionFrom})`)
console.log(`keys     ${keyPrefix}<path>${prefixes.length ? `   prefixes: ${prefixes.join(', ')}` : ''}`)

if (args['dry-run']) {
  const backend = chooseBackend(loadConfig(ALL_CONFIG))
  console.log(`backend  ${backend}`)
  console.log(`\nDRY RUN: would upload ${localTotal.count} of ${all.length} local files, ${fmtBytes(localTotal.bytes)} (no network calls)\n`)
  printTable(summarizeByTop(sel), localTotal)
  console.log('\nsample keys:')
  const seen = new Set()
  const samples = []
  for (const f of sel) { const t = topDir(f.rel); if (!seen.has(t)) { seen.add(t); samples.push(f) } }
  for (const f of sel) { if (samples.length >= 8) break; if (!samples.includes(f) && !samples.some((s) => path.extname(s.rel) === path.extname(f.rel))) samples.push(f) }
  const cc = backend === 's3' ? CACHE_CONTROL : `(not settable via cli; from a response-header rule: ${CACHE_CONTROL})`
  for (const f of samples) console.log(`  ${keyFor(f.rel)}  [${fmtBytes(f.size)}]\n      Content-Type: ${contentTypeFor(f.rel)}   Cache-Control: ${cc}`)
  const multipart = sel.filter((f) => f.size > MULTIPART_THRESHOLD).length
  if (backend === 's3' && multipart) console.log(`\n${multipart} file(s) above ${MULTIPART_THRESHOLD / 1048576} MB would use multipart upload`)
  if (backend === 'cli') {
    const tooBig = sel.filter((f) => f.size > CLI_MAX_OBJECT).length
    const empty = sel.filter((f) => f.size === 0).length
    if (tooBig) console.log(`\nWARNING: ${tooBig} file(s) exceed the ${CLI_MAX_OBJECT / 1e6} MB cli limit`)
    if (empty) console.log(`\nWARNING: ${empty} empty file(s): cf r2 objects put rejects empty files`)
  }
  if (doCors) console.log('\n--cors would apply scripts/r2-cors.json (skipped in dry run)')
  if (doVerify) console.log('--verify skipped in dry run')
  const pub = loadConfig(['R2_PUBLIC_BASE']).R2_PUBLIC_BASE.replace(/\/+$/, '')
  console.log(`\nVITE_DATA_BASE=${pub || '<R2_PUBLIC_BASE>'}/v/${version}`)
  process.exit(0)
}

const backend = chooseBackend(loadConfig(ALL_CONFIG))
const cfg = requireConfig(backend, doVerify)
const concurrency = Number(args.concurrency ?? (backend === 'cli' ? 8 : 16))
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) fail('--concurrency must be an integer 1..256')
if (cfDryRun && backend !== 'cli') fail('--cf-dry-run only applies to the cli backend')
console.log(`backend  ${backend}${backend === 'cli' && cfDryRun ? '  (cf --dry-run: no writes)' : ''}`)

let s3 = null
let client = null
if (backend === 's3') {
  ({ s3, client } = await sdk(cfg))
} else {
  CF = resolveCf()
  cfEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  if (cfg.R2_ACCOUNT_ID) cfEnv.CLOUDFLARE_ACCOUNT_ID = cfg.R2_ACCOUNT_ID
  console.log(`cf       ${CF.where}${cfg.R2_ACCOUNT_ID ? '  (account from R2_ACCOUNT_ID)' : '  (account: the CLI\'s active account)'}`)
}

let exitCode = 0
if (doCors) exitCode = Math.max(exitCode, backend === 's3' ? await applyCorsS3() : await applyCorsCli())
if (doUpload) exitCode = Math.max(exitCode, await upload())
if (doVerify && !aborted && !cfDryRun) exitCode = Math.max(exitCode, backend === 's3' ? await verifyS3() : await verifyCli())
process.exit(exitCode)

// ------------------------------------------------------------------ s3 client

async function sdk(c) {
  const mod = await import('@aws-sdk/client-s3')
  const endpoint = c.R2_ENDPOINT || `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const cl = new mod.S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.R2_ACCESS_KEY_ID, secretAccessKey: c.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1, // retries are handled by withRetry()
  })
  return { s3: mod, client: cl }
}

// ------------------------------------------------------------------ cors

function readCorsRules() {
  try {
    const j = JSON.parse(fs.readFileSync(CORS_FILE, 'utf8'))
    const rules = Array.isArray(j) ? j : j.CORSRules ?? j.rules
    if (!Array.isArray(rules) || !rules.length) throw new Error('expected a non-empty array of rules (or {"CORSRules": [...]})')
    return rules
  } catch (e) { fail(`cannot read ${CORS_FILE}: ${e.message}`) }
}

async function applyCorsS3() {
  console.log('\n# CORS (scripts/r2-cors.json, S3 PutBucketCors)')
  const rules = readCorsRules()
  const put = new s3.PutBucketCorsCommand({ Bucket: cfg.R2_BUCKET, CORSConfiguration: { CORSRules: rules } })
  // S3 requires an integrity header on PutBucketCors; send Content-MD5 explicitly (accepted by S3 and R2).
  put.middlewareStack.add((next) => async (a) => {
    const body = a.request?.body
    if (typeof body === 'string' || body instanceof Uint8Array) {
      a.request.headers['content-md5'] = crypto.createHash('md5').update(body).digest('base64')
    }
    return next(a)
  }, { step: 'build', name: 'harmonyContentMd5' })
  try {
    await withRetry(() => client.send(put))
    const got = await withRetry(() => client.send(new s3.GetBucketCorsCommand({ Bucket: cfg.R2_BUCKET })))
    console.log('applied; bucket now has:')
    console.log(JSON.stringify(got.CORSRules ?? [], null, 2))
    console.log('Note: purge the custom domain cache if objects were already served with older CORS headers.')
    return 0
  } catch (err) {
    console.error(`CORS failed: ${describeErr(err)}`)
    if (isFatal(err)) {
      console.error('Bucket CORS needs an R2 API token with "Admin Read & Write"; an "Object Read & Write" token is refused.\n' +
        'Alternative: paste scripts/r2-cors.json into the dashboard (R2 > bucket > Settings > CORS policy).')
    }
    aborted = null // a CORS permission error must not stop an upload in the same run
    return 1
  }
}

/** S3-style rules (dashboard format) -> Cloudflare REST shape used by `cf r2 buckets cors update --rules`. */
function toRestCors(rules) {
  return rules.map((r) => {
    const allowed = { origins: r.AllowedOrigins ?? [], methods: r.AllowedMethods ?? [] }
    if (r.AllowedHeaders?.length) allowed.headers = r.AllowedHeaders
    const out = { allowed }
    if (r.ExposeHeaders?.length) out.exposeHeaders = r.ExposeHeaders
    if (r.MaxAgeSeconds !== undefined) out.maxAgeSeconds = r.MaxAgeSeconds
    if (r.ID) out.id = r.ID
    return out
  })
}

async function applyCorsCli() {
  console.log(`\n# CORS (scripts/r2-cors.json, cf r2 buckets cors update${cfDryRun ? ' --dry-run' : ''})`)
  const rules = JSON.stringify(toRestCors(readCorsRules()))
  const dry = cfDryRun ? ['--dry-run'] : []
  const r = await runCf(['r2', 'buckets', 'cors', 'update', cfg.R2_BUCKET, '--rules', rules, '--force', ...dry])
  if (r.code !== 0) {
    console.error(`CORS failed: ${cliError(r, 'cors update').message}`)
    return 1
  }
  if (cfDryRun) {
    const j = parseJsonLoose(r.stdout)
    console.log('cf would send:')
    console.log(JSON.stringify({ method: j?.method, body: j?.body }, null, 2))
    return 0
  }
  const g = await runCf(['r2', 'buckets', 'cors', 'get', cfg.R2_BUCKET])
  if (g.code !== 0) {
    console.error(`CORS read-back failed: ${cliError(g, 'cors get').message}`)
    return 1
  }
  const j = parseJsonLoose(g.stdout)
  console.log('applied; bucket now has:')
  console.log(JSON.stringify(j?.rules ?? j?.result?.rules ?? j ?? '(unparseable output)', null, 2))
  console.log('Note: purge the custom domain cache if objects were already served with older CORS headers.')
  return 0
}

// ------------------------------------------------------------------ upload (shared runner)

async function upload() {
  console.log(`\n# upload ${localTotal.count} objects, ${fmtBytes(localTotal.bytes)}, concurrency ${concurrency}`)
  if (backend === 'cli') {
    console.log(`Note: the cli backend cannot set Cache-Control; serve "${CACHE_CONTROL}" via a Response Header Transform Rule on the custom domain.`)
  }
  const ctx = backend === 's3' ? await s3Uploader() : cliUploader()
  const st = { done: 0, uploaded: 0, skipped: 0, failed: 0, bytesUp: 0, bytesSkip: 0 }
  const failures = []
  const t0 = Date.now()
  const progressLine = () => {
    const el = (Date.now() - t0) / 1000
    const doneBytes = st.bytesUp + st.bytesSkip
    const rate = el > 0 ? st.bytesUp / el : 0
    const remaining = localTotal.bytes - doneBytes
    const eta = rate > 0 && remaining > 0 ? `  eta ~${fmtDuration((remaining / rate) * 1000)}` : ''
    const pct = localTotal.count ? ((st.done / localTotal.count) * 100).toFixed(1) : '100'
    return `[${String(st.done).padStart(String(localTotal.count).length)}/${localTotal.count} ${pct.padStart(5)}%] ` +
      `up ${st.uploaded} skip ${st.skipped} fail ${st.failed} | ${fmtBytes(doneBytes)} / ${fmtBytes(localTotal.bytes)} ` +
      `| ${fmtBytes(rate)}/s${eta} | ${fmtDuration(el * 1000)}`
  }
  const one = async (f) => {
    try {
      const res = await ctx.put(f)
      if (res === 'skipped') { st.skipped++; st.bytesSkip += f.size } else { st.uploaded++; st.bytesUp += f.size }
    } catch (err) {
      st.failed++
      failures.push({ key: keyFor(f.rel), msg: describeErr(err) })
      if (isFatal(err)) aborted ??= err
    }
    st.done++
  }
  let lastDone = -1
  const timer = setInterval(() => { if (st.done !== lastDone) { lastDone = st.done; console.log(progressLine()) } }, 5000)

  let rest = sel
  if (ctx.canary) {
    // Upload one object alone and check it end to end before starting the pool.
    const first = sel.find((f) => f.rel === 'meta.json') ?? sel[0]
    rest = sel.filter((f) => f !== first)
    await one(first)
    if (!aborted && failures.length) aborted = Object.assign(new Error('the first (canary) upload failed; the rest was not started'), { name: 'CanaryFailed' })
    if (!aborted) await ctx.canary(first)
  }
  if (!aborted) await pool(rest, concurrency, one)
  clearInterval(timer)
  console.log(progressLine())

  const el = Date.now() - t0
  const notAttempted = localTotal.count - st.done
  console.log('\n# summary')
  console.log(`  ${cfDryRun ? 'dry-run ' : 'uploaded'}  ${st.uploaded} objects, ${fmtBytes(st.bytesUp)}`)
  console.log(`  skipped   ${st.skipped} objects, ${fmtBytes(st.bytesSkip)} (${backend === 's3' ? 'already present, MD5 match' : 'manifest: same bucket, size and MD5'})`)
  console.log(`  failed    ${st.failed} objects${notAttempted ? `  (+${notAttempted} not attempted after a fatal error)` : ''}`)
  console.log(`  elapsed   ${fmtDuration(el)}, throughput ${fmtBytes(el > 0 ? (st.bytesUp / el) * 1000 : 0)}/s`)
  if (backend === 'cli' && cfCalls) console.log(`  cf calls  ${cfCalls}, mean ${(cfMsTotal / cfCalls).toFixed(0)} ms per call (wall time per call incl. process start)`)
  if (ctx.report) ctx.report()
  if (aborted) {
    console.log(`\nABORTED on a non-retryable error: ${describeErr(aborted)}`)
    console.log(aborted.name === 'KeyMismatch'
      ? '!!! KEY ENCODING PROBLEM: R2 did not store/serve the object under the intended key (the cf CLI sends "/" as %2F).\n' +
        '!!! Do not continue with the cli backend. Delete the stray canary object in the dashboard (R2 > bucket > Objects)\n' +
        '!!! and upload with the s3 backend (R2 API token) instead.'
      : 'Check the credentials / CLI login, bucket name and account id (see docs/DEPLOYMENT.md).')
  }
  if (failures.length) {
    console.log('\nfirst failures:')
    for (const x of failures.slice(0, 10)) console.log(`  ${x.key}: ${x.msg}`)
    if (failures.length > 10) console.log(`  ... and ${failures.length - 10} more`)
  }
  printBase()
  return st.failed || aborted ? 1 : 0
}

function printBase() {
  console.log(`\nVITE_DATA_BASE=${cfg.R2_PUBLIC_BASE || '<R2_PUBLIC_BASE>'}/v/${version}`)
  console.log(`Note: tiles-first / points-later runs must all use --version ${version} so the app sees one dataset.`)
}

// ------------------------------------------------------------------ upload: s3

async function s3Uploader() {
  const { Upload } = await import('@aws-sdk/lib-storage')
  return {
    async put(f) {
      const Key = keyFor(f.rel)
      const size = (await fsp.stat(f.abs)).size
      const buf = size <= BUFFER_LIMIT ? await fsp.readFile(f.abs) : null
      if (buf && buf.length !== size) throw new Error('file changed while reading')
      const md5 = buf ? crypto.createHash('md5').update(buf).digest('hex') : await md5File(f.abs)

      let head = null
      try {
        head = await withRetry(() => client.send(new s3.HeadObjectCommand({ Bucket: cfg.R2_BUCKET, Key })))
      } catch (err) {
        if (!(err?.name === 'NotFound' || err?.name === 'NoSuchKey' || httpStatus(err) === 404)) throw err
      }
      if (head && head.ContentLength === size) {
        const etag = String(head.ETag ?? '').replace(/"/g, '').toLowerCase()
        if (etag === md5 || head.Metadata?.md5 === md5) return 'skipped'
      }

      const params = { Bucket: cfg.R2_BUCKET, Key, ContentType: contentTypeFor(f.rel), CacheControl: CACHE_CONTROL, Metadata: { md5 } }
      if (size > MULTIPART_THRESHOLD) {
        await withRetry(async () => {
          const up = new Upload({ client, params: { ...params, Body: fs.createReadStream(f.abs) }, partSize: PART_SIZE, queueSize: 4, leavePartsOnError: false })
          await up.done()
        })
      } else {
        await withRetry(() => client.send(new s3.PutObjectCommand({
          ...params,
          Body: buf ?? fs.createReadStream(f.abs),
          ContentLength: size,
          ContentMD5: buf ? Buffer.from(md5, 'hex').toString('base64') : undefined,
        })))
      }
      return 'uploaded'
    },
  }
}

// ------------------------------------------------------------------ upload: cli

function loadManifest() {
  const m = new Map()
  let text = ''
  try { text = fs.readFileSync(MANIFEST_FILE, 'utf8') } catch { return m }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.key === 'string') m.set(e.key, e)
    } catch { /* torn line from an interrupted write: ignore */ }
  }
  return m
}

function appendManifest(entry) {
  fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true })
  fs.appendFileSync(MANIFEST_FILE, JSON.stringify(entry) + '\n')
}

function cliUploader() {
  const manifest = args.force ? new Map() : loadManifest()
  let dryUrlSample = null
  let encodedSlash = false
  let keyChecked = 0
  let keyMismatches = 0
  const ctx = {
    async put(f) {
      const Key = keyFor(f.rel)
      const size = (await fsp.stat(f.abs)).size
      if (size === 0) throw Object.assign(new Error('empty file: cf r2 objects put rejects empty bodies'), { name: 'CliLocal' })
      if (size > CLI_MAX_OBJECT) throw Object.assign(new Error(`larger than the ${CLI_MAX_OBJECT / 1e6} MB cli limit; use the s3 backend`), { name: 'CliLocal' })
      const md5 = await md5File(f.abs)
      const prev = manifest.get(Key)
      if (prev && prev.bucket === cfg.R2_BUCKET && prev.size === size && prev.md5 === md5) return 'skipped'

      const cliArgs = ['r2', 'objects', 'put', Key, '--bucket-name', cfg.R2_BUCKET, '--file', f.abs, '--content-type', contentTypeFor(f.rel)]
      if (cfDryRun) cliArgs.push('--dry-run')
      const r = await withRetry(async () => {
        const res = await runCf(cliArgs)
        if (res.code !== 0) throw cliError(res, 'r2 objects put')
        return res
      })
      const j = parseJsonLoose(r.stdout)
      if (cfDryRun) {
        const url = String(j?.url ?? '')
        dryUrlSample ??= url.replace(/\/accounts\/[^/]+\//, '/accounts/<account>/')
        if (/\/objects\/.*%2F/i.test(url)) encodedSlash = true
        return 'uploaded'
      }
      const reported = j?.key ?? j?.result?.key
      if (typeof reported === 'string') {
        keyChecked++
        if (reported !== Key) {
          keyMismatches++
          throw Object.assign(new Error(`R2 stored key ${JSON.stringify(reported)} instead of ${JSON.stringify(Key)} (the CLI percent-encodes "/" as %2F)`), { name: 'KeyMismatch' })
        }
      }
      appendManifest({ key: Key, bucket: cfg.R2_BUCKET, size, md5, contentType: contentTypeFor(f.rel), uploadedAt: new Date().toISOString() })
      manifest.set(Key, { key: Key, bucket: cfg.R2_BUCKET, size, md5 })
      return 'uploaded'
    },
    report() {
      if (cfDryRun) {
        if (dryUrlSample) console.log(`  cf request URL (sample): ${dryUrlSample}`)
        if (encodedSlash) {
          console.log('\n  !!! KEY ENCODING: the CLI percent-encodes "/" in the object key as %2F in the request path, while the')
          console.log('  !!! API docs say slashes must be sent literally. The real run uploads one canary object first and aborts')
          console.log('  !!! if R2 reports or serves a different key.')
        }
      } else {
        console.log(`  key check ${keyChecked} upload response(s) carried a key${keyMismatches ? `, ${keyMismatches} MISMATCHED` : keyChecked ? ', all matched' : ''}`)
        console.log(`  manifest  ${path.relative(ROOT, MANIFEST_FILE).split(path.sep).join('/')} (${manifest.size} entries)`)
      }
    },
  }
  if (!cfDryRun) {
    ctx.canary = async (f) => {
      if (!cfg.R2_PUBLIC_BASE) {
        console.log('WARNING: R2_PUBLIC_BASE not set; skipping the canary fetch (key check relies on the upload response only)')
        return
      }
      const url = `${cfg.R2_PUBLIC_BASE}/${keyFor(f.rel).split('/').map(encodeURIComponent).join('/')}?canary=${Date.now()}`
      const r = await rangedGet(url, 0, 0)
      if (r.ok && r.size === f.size) { console.log(`canary OK: ${keyFor(f.rel)} is served by the public base (${r.status}, ${r.size} B)`); return }
      const e = new Error(`canary: ${keyFor(f.rel)} uploaded but the public base answers ${r.status}${r.size !== undefined ? ` (size ${r.size}, want ${f.size})` : ''}; ` +
        'the object was most likely stored under a different key (e.g. with %2F). Nothing else was uploaded.')
      e.name = 'KeyMismatch'
      aborted = e
    }
  }
  return ctx
}

// ------------------------------------------------------------------ verify

/** GET bytes=a-b; returns {ok, status, size (from Content-Range / Content-Length), headers}. */
async function rangedGet(url, a, b, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}`, ...headers }, redirect: 'manual' })
      await r.arrayBuffer()
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep(300 * 2 ** attempt * Math.random() + 100); continue }
      const cr = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '')
      const size = r.status === 206 && cr ? Number(cr[1]) : r.status === 200 ? Number(r.headers.get('content-length')) : undefined
      return { ok: r.status === 206 || r.status === 200, status: r.status, size, headers: r.headers }
    } catch (err) {
      if (attempt >= 4) return { ok: false, status: `network error (${err?.cause?.code ?? err?.name ?? 'error'})` }
      await sleep(300 * 2 ** attempt * Math.random() + 100)
    }
  }
}

function makeChecker() {
  const c = { failed: 0, warned: 0 }
  c.check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) c.failed++ }
  c.warn = (ok, msg) => { console.log(`${ok ? 'PASS' : 'WARN'}  ${msg}`); if (!ok) c.warned++ }
  return c
}

async function verifyS3() {
  console.log(`\n# verify ${keyPrefix} (S3 listing)`)
  const c = makeChecker()
  const listPrefixes = prefixes.length ? prefixes.map((p) => keyPrefix + p) : [keyPrefix]
  const remote = new Map()
  try {
    for (const Prefix of listPrefixes) {
      let ContinuationToken
      do {
        const r = await withRetry(() => client.send(new s3.ListObjectsV2Command({ Bucket: cfg.R2_BUCKET, Prefix, ContinuationToken })))
        for (const o of r.Contents ?? []) remote.set(o.Key, o.Size ?? 0)
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (ContinuationToken)
    }
    const remoteBytes = [...remote.values()].reduce((a, b) => a + b, 0)
    c.check(remote.size === localTotal.count, `object count: remote ${remote.size}, local ${localTotal.count}`)
    c.check(remoteBytes === localTotal.bytes, `total bytes: remote ${remoteBytes}, local ${localTotal.bytes}`)
    const missing = sel.filter((f) => !remote.has(keyFor(f.rel)))
    const wrongSize = sel.filter((f) => remote.has(keyFor(f.rel)) && remote.get(keyFor(f.rel)) !== f.size)
    const localKeys = new Set(sel.map((f) => keyFor(f.rel)))
    const extra = [...remote.keys()].filter((k) => !localKeys.has(k))
    if (missing.length) console.log(`      missing remotely: ${missing.length} (e.g. ${missing.slice(0, 3).map((f) => f.rel).join(', ')})`)
    if (wrongSize.length) console.log(`      size differs: ${wrongSize.length} (e.g. ${wrongSize.slice(0, 3).map((f) => f.rel).join(', ')})`)
    if (extra.length) console.log(`      only remote: ${extra.length} (e.g. ${extra.slice(0, 3).join(', ')})`)
  } catch (err) {
    c.check(false, `ListObjectsV2 ${keyPrefix}: ${describeErr(err)}`)
  }
  await verifyPublic(c, false)
  return finishVerify(c)
}

async function verifyCli() {
  console.log(`\n# verify ${keyPrefix} (ranged GET of every selected object via ${cfg.R2_PUBLIC_BASE})`)
  const c = makeChecker()
  const manifest = loadManifest()
  const inManifest = sel.filter((f) => { const e = manifest.get(keyFor(f.rel)); return e && e.bucket === cfg.R2_BUCKET && e.size === f.size })
  c.warn(inManifest.length === sel.length, `manifest covers ${inManifest.length}/${sel.length} selected files (size match)`)
  const res = { ok: 0, okBytes: 0, missing: [], wrongSize: [], other: [] }
  let n = 0
  const t0 = Date.now()
  const timer = setInterval(() => console.log(`  checked ${n}/${sel.length}`), 10000)
  await pool(sel, 16, async (f) => {
    const url = `${cfg.R2_PUBLIC_BASE}/${keyFor(f.rel).split('/').map(encodeURIComponent).join('/')}`
    const r = await rangedGet(url, 0, 0)
    if (r.ok && r.size === f.size) { res.ok++; res.okBytes += f.size } else if (r.status === 404) res.missing.push(f.rel)
    else if (r.ok) res.wrongSize.push(`${f.rel} (${r.size} vs ${f.size})`)
    else res.other.push(`${f.rel} (${r.status})`)
    n++
  })
  clearInterval(timer)
  c.check(res.ok === localTotal.count, `objects served with the right size: ${res.ok}/${localTotal.count} (${fmtDuration(Date.now() - t0)})`)
  c.check(res.okBytes === localTotal.bytes, `bytes: served ${res.okBytes}, local ${localTotal.bytes}`)
  if (res.missing.length) console.log(`      404: ${res.missing.length} (e.g. ${res.missing.slice(0, 3).join(', ')})`)
  if (res.wrongSize.length) console.log(`      size differs: ${res.wrongSize.length} (e.g. ${res.wrongSize.slice(0, 3).join(', ')})`)
  if (res.other.length) console.log(`      other errors: ${res.other.length} (e.g. ${res.other.slice(0, 3).join(', ')})`)
  await verifyPublic(c, true)
  return finishVerify(c)
}

function finishVerify(c) {
  console.log(c.failed ? `\nverify: ${c.failed} check(s) FAILED${c.warned ? `, ${c.warned} warning(s)` : ''}` : `\nverify: all checks PASSED${c.warned ? ` (${c.warned} warning(s))` : ''}`)
  printBase()
  return c.failed ? 1 : 0
}

/** Ranged GETs with Origin plus CORS preflights against the public custom domain. */
async function verifyPublic(c, cacheControlIsWarning) {
  const base = `${cfg.R2_PUBLIC_BASE}/v/${version}`
  const parquet = sel.find((f) => f.rel.endsWith('.parquet')) ?? all.find((f) => f.rel.endsWith('.parquet'))
  const targets = ['meta.json', ...(parquet ? [parquet.rel] : [])]
  for (const rel of targets) {
    const url = `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-1023', Origin: APP_ORIGIN }, redirect: 'manual' })
      await r.arrayBuffer()
      const h = (n) => r.headers.get(n) ?? ''
      const acao = h('access-control-allow-origin')
      const aceh = h('access-control-expose-headers').toLowerCase()
      c.check(r.status === 206, `GET ${rel} Range bytes=0-1023 -> ${r.status} (want 206)`)
      if (r.status !== 206 && r.status !== 200) continue
      c.check(/^bytes 0-\d+\/\d+$/.test(h('content-range')), `  Content-Range: ${h('content-range') || '(none)'}`)
      c.check(acao === APP_ORIGIN || acao === '*', `  Access-Control-Allow-Origin: ${acao || '(none)'}`)
      c.check(aceh === '*' || aceh.split(',').map((s) => s.trim()).includes('content-range'), `  Access-Control-Expose-Headers: ${h('access-control-expose-headers') || '(none)'}`)
      const ccOk = h('cache-control').includes('immutable')
      const ccMsg = `  Cache-Control: ${h('cache-control') || '(none)'}${!ccOk && cacheControlIsWarning ? '  (add a Response Header Transform Rule on the custom domain)' : ''}`
      if (cacheControlIsWarning) c.warn(ccOk, ccMsg)
      else c.check(ccOk, ccMsg)
      c.check(h('content-type').startsWith(contentTypeFor(rel).split(';')[0]), `  Content-Type: ${h('content-type') || '(none)'}`)
    } catch (err) {
      c.check(false, `GET ${rel}: ${describeErr(err)}`)
    }
  }
  const preflight = async (origin, expectAllowed) => {
    const url = `${base}/meta.json`
    try {
      const r = await fetch(url, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
        redirect: 'manual',
      })
      await r.arrayBuffer()
      const acao = r.headers.get('access-control-allow-origin') ?? ''
      const acah = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase()
      const allowed = r.status >= 200 && r.status < 300 && (acao === origin || acao === '*') &&
        (acah === '*' || acah.split(',').map((s) => s.trim()).includes('range'))
      if (expectAllowed) c.check(allowed, `OPTIONS preflight from ${origin} (range) -> ${r.status}, allow-origin ${acao || '(none)'}, allow-headers ${acah || '(none)'}`)
      else c.check(!allowed, `OPTIONS preflight from ${origin} is refused -> ${r.status}, allow-origin ${acao || '(none)'}`)
    } catch (err) {
      c.check(false, `OPTIONS preflight from ${origin}: ${describeErr(err)}`)
    }
  }
  await preflight(APP_ORIGIN, true)
  await preflight(PREVIEW_ORIGIN_SAMPLE, true)
  await preflight(FOREIGN_ORIGIN_SAMPLE, false)
}
