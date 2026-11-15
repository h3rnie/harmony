// Chooses the analysis kernel: the Rust/WASM worker client when it and the pipeline data exist,
// otherwise the mock kernel (synthetic but internally consistent numbers, clearly labelled).
import type { KernelClient, Meta } from './kernel/types'
import { MockKernel, mockMeta } from './mock/mockKernel'
import { loadMeta, loadTileIndex, type TileIndex } from './data/tileReader'

/** ONE-LINE SWITCH: 'auto' = real kernel when available, else mock · 'mock' = always mock · 'real' = never fall back. */
export const KERNEL_MODE: 'auto' | 'mock' | 'real' = 'auto'

// Optional import: resolves to {} while web/src/lib/kernel/client.ts does not exist, so the build never breaks.
const clientModules = import.meta.glob('./kernel/client.ts')

export interface KernelSelection {
  kernel: KernelClient
  meta: Meta
  index: TileIndex | null
  kind: 'wasm' | 'mock'
  /** Why the mock is in use (null for the real kernel). */
  reason: string | null
}

async function loadRealClient(): Promise<KernelClient> {
  const loader = clientModules['./kernel/client.ts']
  if (!loader) throw new Error('WASM kernel client not built yet')
  const mod = (await loader()) as Record<string, unknown>
  const factory = (mod.createKernelClient ?? mod.createClient ?? mod.default ?? mod.KernelWorkerClient) as unknown
  let client: unknown = factory
  if (typeof factory === 'function') {
    const f = factory as { prototype?: { analyze?: unknown }; new (): unknown; (): unknown }
    client = f.prototype?.analyze ? new f() : await (f as () => unknown)()
  }
  if (!client || typeof (client as KernelClient).analyze !== 'function') throw new Error('kernel/client.ts exports no KernelClient')
  return client as KernelClient
}

export async function selectKernel(): Promise<KernelSelection> {
  const forceMock = KERNEL_MODE === 'mock' || new URLSearchParams(location.search).get('mock') === '1'
  const mock = async (reason: string): Promise<KernelSelection> => {
    if (KERNEL_MODE === 'real' && !forceMock) throw new Error(reason)
    const meta = mockMeta()
    const kernel = new MockKernel()
    await kernel.init(meta)
    return { kernel, meta, index: null, kind: 'mock', reason }
  }
  if (forceMock) return mock('Demo mode (?mock=1)')

  let meta: Meta
  try {
    meta = await loadMeta()
  } catch {
    return mock('No pipeline output found at the data URL')
  }
  let kernel: KernelClient
  try {
    kernel = await loadRealClient()
    await kernel.init(meta)
  } catch (e) {
    return mock(`Analysis kernel unavailable: ${(e as Error).message}`)
  }
  let index: TileIndex | null = null
  try {
    index = await loadTileIndex()
  } catch (e) {
    console.warn('tiles/index.json unavailable; tile sizes unknown', e)
  }
  return { kernel, meta, index, kind: 'wasm', reason: null }
}
