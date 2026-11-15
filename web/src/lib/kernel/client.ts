// Main-thread KernelClient backed by the WASM kernel in a module Web Worker (see worker.ts).
import type { KernelOp, KernelRequest, KernelResponse } from './protocol'
import type { Analysis, AnalyzeOptions, AoiInfo, CellLayer, CellLayerOptions, KernelClient, Meta, TileColumns } from './types'

export interface KernelClientOptions {
  /**
   * Transfer (detach) tile column buffers to the worker instead of copying them. Only safe when
   * the caller never reuses the TileColumns afterwards; data/tileReader.ts caches tiles, so the
   * default is to copy (a memcpy per tile, cheap next to the Parquet decode).
   */
  transferTiles?: boolean
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export function createKernelClient(options: KernelClientOptions = {}): KernelClient & { terminate(): void } {
  const pending = new Map<number, Pending>()
  let nextId = 1
  let lastMeta: Meta | null = null
  let worker = spawn()

  function failAll(message: string) {
    for (const p of pending.values()) p.reject(new Error(message))
    pending.clear()
  }

  function spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'harmony-kernel' })
    w.onmessage = (ev: MessageEvent<KernelResponse>) => {
      const res = ev.data
      const p = pending.get(res.id)
      if (!p) return
      pending.delete(res.id)
      if (res.ok) {
        p.resolve(res.result)
        return
      }
      p.reject(new Error(res.error))
      if (res.fatal) restart()
    }
    w.onerror = (ev) => {
      ev.preventDefault()
      failAll(`kernel worker failed: ${ev.message || 'could not load the worker or its WASM module'}`)
    }
    w.onmessageerror = () => failAll('kernel worker sent an unreadable message')
    return w
  }

  /** Replaces a trapped worker; the AOI and ingested tiles are lost, meta is restored. */
  function restart() {
    worker.terminate()
    failAll('kernel restarted after a crash; set the area again')
    worker = spawn()
    if (lastMeta) call('init', lastMeta).catch(() => {})
  }

  function call<T>(op: KernelOp, arg?: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        worker.postMessage({ id, op, arg } satisfies KernelRequest, transfer)
      } catch (e) {
        pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  function tileBuffers(cols: TileColumns): Transferable[] {
    const all = [cols.cell, cols.stratum, cols.m, cols.dn, cols.meq, cols.kv, cols.kvsq, cols.v, cols.nmod, cols.nvii]
    return [...new Set(all.map((a) => a.buffer))].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer)
  }

  return {
    async init(meta: Meta) {
      lastMeta = meta
      await call<string>('init', meta)
    },
    setAoi: (rings: number[][][]) => call<AoiInfo>('setAoi', rings),
    tilesFor: (level: number) => call<string[]>('tilesFor', level),
    begin: (level: number) => call<void>('begin', level),
    ingestTile: (cols: TileColumns) => call<number>('ingestTile', cols, options.transferTiles ? tileBuffers(cols) : []),
    analyze: async (opts: AnalyzeOptions) => JSON.parse(await call<string>('analyze', opts)) as Analysis,
    cellLayer: (opts: CellLayerOptions) => call<CellLayer>('cellLayer', opts),
    terminate() {
      worker.terminate()
      failAll('kernel client terminated')
    },
  }
}

export default createKernelClient
