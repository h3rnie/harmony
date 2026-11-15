import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, type Connect, type Plugin } from 'vite'
import sirv from 'sirv'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aiPlugin } from './server/ai/plugin.ts'
import { livePlugin } from './server/livePlugin.ts'

// Pipeline output, served at /data/ during `vite` and `vite preview` (HTTP Range supported by sirv).
// Production builds are a static SPA that reads VITE_DATA_BASE (default "/data").
const DATA_DIR = fileURLToPath(new URL('../data/dist', import.meta.url))

const EXTRA_TYPES: Record<string, string> = {
  '.parquet': 'application/vnd.apache.parquet',
  '.f32': 'application/octet-stream',
  '.u16': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function dataMiddleware(): Connect.NextHandleFunction {
  const serve = sirv(DATA_DIR, {
    dev: true, // re-stat on every request: the pipeline rewrites files while we run
    etag: true,
    dotfiles: false,
    setHeaders(res, pathname) {
      const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
      const type = EXTRA_TYPES[ext]
      if (type) res.setHeader('Content-Type', type)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Access-Control-Allow-Origin', '*')
    },
  })
  return (req, res, next) => {
    if (!existsSync(DATA_DIR)) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('data/dist not built yet')
      return
    }
    serve(req, res, () => {
      // Never fall through to the SPA index for data paths.
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('not found')
      void next
    })
  }
}

function harmonyData(): Plugin {
  return {
    name: 'harmony-data',
    configureServer(server) {
      server.middlewares.use('/data', dataMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use('/data', dataMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // /api/brief + /api/ask (AI situation brief, Ask Harmony) read ANTHROPIC_API_KEY / OPENROUTER_API_KEY and AI_* server-side
  // from <repo root>/.env.local | .env | process env.
  // /api/live proxies FIRMS NRT with FIRMS_MAP_KEY read the same way (never sent to the browser).
  plugins: [harmonyData(), aiPlugin({ envDir: fileURLToPath(new URL('..', import.meta.url)) }), livePlugin({ envDir: fileURLToPath(new URL('..', import.meta.url)) }), svelte()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
})
