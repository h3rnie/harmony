// Lazy onnxruntime-web session for the ML challenger. Loaded only when the Method lab opens.
// WebGPU execution provider when navigator.gpu yields an adapter, else single-threaded WASM.
// The .wasm binary is imported with ?url so Vite serves it in dev and fingerprints it in the build;
// no COOP/COEP headers are needed because numThreads = 1 (no SharedArrayBuffer).
import type * as Ort from 'onnxruntime-web'
import { DATA_BASE } from '../config'

export type Provider = 'WebGPU' | 'WASM'

export interface MlSession {
  provider: Provider
  /** Why WebGPU was not used (no API, no adapter, or the error it threw). */
  fallbackReason: string | null
  adapter: string | null
  loadMs: number
  /** Runs mu = v · exp(f(x)) for n rows; x is [n, nf] row-major. */
  run(x: Float32Array, v: Float32Array, n: number, nf: number): Promise<Float32Array>
}

let pending: Promise<MlSession> | null = null

export function loadSession(): Promise<MlSession> {
  pending ??= create().catch((e) => { pending = null; throw e })
  return pending
}

async function fetchModel(): Promise<Uint8Array> {
  const res = await fetch(`${DATA_BASE}/ml/model.onnx`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`model.onnx: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function hasAdapter(): Promise<string | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu
  if (!gpu) return null
  const a = await gpu.requestAdapter()
  if (!a) return null
  const i = a.info ?? {}
  return [i.vendor, i.architecture || i.description].filter(Boolean).join(' ') || 'adapter'
}

async function create(): Promise<MlSession> {
  const t0 = performance.now()
  const modelP = fetchModel()
  let adapter: string | null = null
  let reason: string | null = null
  try {
    adapter = await hasAdapter()
    if (!adapter) reason = 'navigator.gpu' in navigator ? 'no WebGPU adapter' : 'WebGPU not available in this browser'
  } catch (e) {
    reason = `WebGPU adapter request failed: ${e instanceof Error ? e.message : String(e)}`
  }
  const model = await modelP

  if (adapter) {
    const ort = (await import('onnxruntime-web/webgpu')) as unknown as typeof Ort
    const wasm = (await import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')).default
    configure(ort, wasm)
    try {
      const s = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' })
      return wrap(ort, s, 'WebGPU', null, adapter, t0)
    } catch (e) {
      reason = `WebGPU session failed: ${e instanceof Error ? e.message : String(e)}`
      // Same module also carries the CPU (wasm) provider.
      const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      return wrap(ort, s, 'WASM', reason, adapter, t0)
    }
  }
  const ort = (await import('onnxruntime-web/wasm')) as unknown as typeof Ort
  const wasm = (await import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')).default
  configure(ort, wasm)
  const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  return wrap(ort, s, 'WASM', reason, null, t0)
}

function configure(ort: typeof Ort, wasmUrl: string) {
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { wasm: wasmUrl }
  ort.env.logLevel = 'error'
}

function wrap(ort: typeof Ort, s: Ort.InferenceSession, provider: Provider, fallbackReason: string | null,
  adapter: string | null, t0: number): MlSession {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    provider, fallbackReason, adapter: provider === 'WebGPU' ? adapter : null, loadMs: performance.now() - t0,
    run(x, v, n, nf) {
      // One run at a time: an ORT session must not be entered concurrently.
      const p = queue.then(async () => {
        const out = await s.run({
          x: new ort.Tensor('float32', x.subarray(0, n * nf), [n, nf]),
          v: new ort.Tensor('float32', v.subarray(0, n), [n, 1]),
        }, ['mu'])
        const mu = out.mu
        const data = (await mu.getData()) as Float32Array
        mu.dispose()
        return data
      })
      queue = p.catch(() => undefined)
      return p
    },
  }
}
