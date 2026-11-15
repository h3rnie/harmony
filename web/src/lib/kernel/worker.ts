// Module Web Worker hosting the Rust/WASM analysis kernel (crates/harmony-wasm).
// Requests are handled strictly in arrival order; results go back by request id.
import init, { Kernel } from './pkg/harmony_wasm.js'
import wasmUrl from './pkg/harmony_wasm_bg.wasm?url'
import type { KernelRequest, KernelResponse } from './protocol'
import type { AnalyzeOptions, CellLayer, Meta, TileColumns } from './types'

// Typed narrowly so this file also checks under the DOM lib used by the app tsconfig.
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<KernelRequest>) => void) | null
  postMessage(message: KernelResponse, options?: { transfer?: Transferable[] }): void
}

let ready: Promise<unknown> | null = null
let kernel: Kernel | null = null
let queue: Promise<void> = Promise.resolve()

function current(): Kernel {
  if (!kernel) throw new Error('kernel not initialised: call init(meta) first')
  return kernel
}

/** GeoJSON polygon rings -> interleaved lon/lat + ring start offsets (with a trailing total). */
function flatten(rings: number[][][]): { coords: Float64Array; offsets: Uint32Array } {
  const total = rings.reduce((n, r) => n + r.length, 0)
  const coords = new Float64Array(total * 2)
  const offsets = new Uint32Array(rings.length + 1)
  let v = 0
  rings.forEach((ring, k) => {
    offsets[k] = v
    for (const p of ring) {
      coords[2 * v] = Number(p[0])
      coords[2 * v + 1] = Number(p[1])
      v++
    }
  })
  offsets[rings.length] = v
  return { coords, offsets }
}

async function run(req: KernelRequest): Promise<[unknown, Transferable[]]> {
  switch (req.op) {
    case 'init': {
      ready ??= init({ module_or_path: wasmUrl })
      await ready
      kernel?.free()
      kernel = null
      kernel = new Kernel(JSON.stringify(req.arg as Meta))
      return [Kernel.version(), []]
    }
    case 'setAoi': {
      const { coords, offsets } = flatten(req.arg as number[][][])
      return [JSON.parse(current().set_aoi(coords, offsets)), []]
    }
    case 'tilesFor':
      return [current().tiles_for(req.arg as number), []]
    case 'begin':
      current().begin(req.arg as number)
      return [undefined, []]
    case 'ingestTile': {
      const c = req.arg as TileColumns
      return [current().ingest_tile(c.cell, c.stratum, c.m, c.dn, c.meq, c.kv, c.kvsq, c.v, c.nmod, c.nvii), []]
    }
    case 'analyze':
      // Returned as the JSON string; the client parses it.
      return [current().analyze(JSON.stringify(req.arg as AnalyzeOptions)), []]
    case 'cellLayer': {
      const r = current().cell_layer(JSON.stringify(req.arg))
      try {
        const layer: CellLayer = { level: r.level, cells: r.take_cells(), weights: r.take_weights(), values: r.take_values() }
        return [layer, [layer.cells.buffer, layer.weights.buffer, layer.values.buffer] as Transferable[]]
      } finally {
        r.free()
      }
    }
    default:
      throw new Error(`unknown kernel operation: ${String(req.op)}`)
  }
}

async function handle(req: KernelRequest): Promise<void> {
  try {
    const [result, transfer] = await run(req)
    scope.postMessage({ id: req.id, ok: true, result }, { transfer })
  } catch (e) {
    // A trap (RuntimeError) leaves the instance unusable; the client replaces this worker.
    const fatal = e instanceof WebAssembly.RuntimeError
    if (fatal) kernel = null
    const error = e instanceof Error ? e.message : String(e)
    scope.postMessage({ id: req.id, ok: false, error: fatal ? `kernel crashed: ${error}` : error, fatal })
  }
}

scope.onmessage = (ev) => {
  const req = ev.data
  queue = queue.then(() => handle(req))
}
