// Message protocol between client.ts (main thread) and worker.ts (kernel worker).

export type KernelOp = 'init' | 'setAoi' | 'tilesFor' | 'begin' | 'ingestTile' | 'analyze' | 'cellLayer'

export interface KernelRequest {
  id: number
  op: KernelOp
  arg?: unknown
}

export type KernelResponse =
  | { id: number; ok: true; result: unknown }
  /** `fatal`: the WASM instance trapped and the worker must be replaced. */
  | { id: number; ok: false; error: string; fatal?: boolean }
