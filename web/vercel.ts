// Vercel project configuration (compiled by the Vercel CLI / build). The Vercel project's Root Directory is `web/`.
//
// - Static SPA from `vite build` (dist/), plus the Node.js functions in api/ (Fluid Compute; no Edge runtime).
// - SPA fallback to index.html only for extension-less paths outside /api/ and /assets/, so a missing asset, data
//   file or API route stays a 404 instead of turning into HTML.
// - Hashed build assets are cached for a year (immutable); index.html and other unhashed files revalidate.
// - Security headers, CSP included. No COOP/COEP: the app does not use SharedArrayBuffer (onnxruntime-web runs
//   single-threaded) and cross-origin isolation would block the basemap tiles.
import type { VercelConfig } from '@vercel/config/v1'

/** Public data origin (Cloudflare R2 custom domain); VITE_DATA_BASE adds its own origin when it is set at build time. */
const DATA_ORIGINS = new Set(['https://data.harmony.hernie.me'])
try {
  const base = process.env.VITE_DATA_BASE?.trim()
  if (base && /^https:\/\//.test(base)) DATA_ORIGINS.add(new URL(base).origin)
} catch { /* relative or invalid base: same-origin data, nothing to add */ }

/** Basemap: OpenFreeMap serves the style JSON, vector tiles, glyphs and sprites from this one host. */
const BASEMAP = 'https://tiles.openfreemap.org'

const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval': WebAssembly compilation (analysis kernel, onnxruntime-web). No inline or eval'd JS.
  "script-src 'self' 'wasm-unsafe-eval'",
  // Svelte and MapLibre set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${BASEMAP}`,
  "font-src 'self' data:",
  `connect-src 'self' ${BASEMAP} ${[...DATA_ORIGINS].join(' ')}`,
  // MapLibre and the kernel run in workers (MapLibre's from a blob: URL).
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "media-src 'self' blob: data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()',
  },
]

export const config: VercelConfig = {
  framework: 'vite',
  installCommand: 'pnpm install --frozen-lockfile',
  buildCommand: 'pnpm run build',
  outputDirectory: 'dist',
  functions: {
    // The model call can run for a minute or two with one retry or a fallback; a client that leaves aborts it.
    'api/brief.ts': { maxDuration: 300, supportsCancellation: true },
    'api/ask.ts': { maxDuration: 300, supportsCancellation: true },
    // Up to two FIRMS calls per source (30 s timeout each) plus the usage probe.
    'api/live.ts': { maxDuration: 120 },
    'api/live/status.ts': { maxDuration: 10 },
  },
  rewrites: [
    // Client-side routes only: no file extension, not under /api/ or /assets/.
    { source: '/((?!api/|api$|assets/)[^.]*)', destination: '/index.html' },
  ],
  headers: [
    { source: '/(.*)', headers: SECURITY_HEADERS },
    // Vite content-hashes everything under /assets/: safe to cache forever.
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    // The HTML shell and the unhashed public files must pick up a new deployment at once.
    { source: '/', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
    { source: '/theme-init.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
    { source: '/(favicon.svg|favicon-32.png|apple-touch-icon.png|og.png|robots.txt|sitemap.xml)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
  ],
}
