// Reads pipeline output: meta.json, tiles/index.json and Parquet tiles -> TileColumns typed arrays.
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetRead } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { Meta, TileColumns } from '../kernel/types'
import { DATA_BASE, FETCH_CONCURRENCY } from '../config'

/** { "L0": { "tx_ty": [bytes, rows] } } */
export type TileIndex = Record<string, Record<string, [number, number]>>

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${DATA_BASE}/${path}`, { signal, cache: 'no-cache' })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) throw new Error(`${path}: not JSON (${type || 'no content type'})`)
  return (await res.json()) as T
}

export const loadMeta = (signal?: AbortSignal) => getJson<Meta>('meta.json', signal)
export const loadTileIndex = (signal?: AbortSignal) => getJson<TileIndex>('tiles/index.json', signal)
/** Optional; schema still evolving, so callers must render defensively. */
export const loadValidation = (signal?: AbortSignal) => getJson<unknown>('validation.json', signal)

export function tileUrl(level: number, key: string) {
  return `${DATA_BASE}/tiles/L${level}/${key}.parquet`
}

/** Bytes and rows from the index, or null when the tile does not exist (= no fire data). */
export function tileInfo(index: TileIndex | null, level: number, key: string): [number, number] | null {
  return index?.[`L${level}`]?.[key] ?? null
}

const COLUMNS = ['cell', 'stratum', 'm', 'dn', 'meq', 'kv', 'kvsq', 'v', 'nmod', 'nvii'] as const
type Col = (typeof COLUMNS)[number]
const CTORS: Record<Col, Uint32ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor | Float32ArrayConstructor> = {
  cell: Uint32Array, stratum: Uint16Array, m: Uint16Array, dn: Uint8Array,
  meq: Uint32Array, kv: Uint32Array, kvsq: Float32Array, v: Uint32Array, nmod: Uint32Array, nvii: Uint32Array,
}

// Whole-file reads below this size (one request); larger tiles use HTTP range requests.
const WHOLE_FILE_LIMIT = 2 * 1024 * 1024
const cache = new Map<string, Promise<TileColumns>>()
const CACHE_MAX = 400

export function readTile(level: number, key: string, byteLength?: number, signal?: AbortSignal): Promise<TileColumns> {
  const url = tileUrl(level, key)
  let p = cache.get(url)
  if (!p) {
    p = readTileUncached(url, byteLength, signal)
    p.catch(() => cache.delete(url))
    cache.set(url, p)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  }
  return p
}

async function readTileUncached(url: string, byteLength?: number, signal?: AbortSignal): Promise<TileColumns> {
  let file: ArrayBuffer | Awaited<ReturnType<typeof asyncBufferFromUrl>>
  if (byteLength != null && byteLength <= WHOLE_FILE_LIMIT) {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    file = await res.arrayBuffer()
  } else {
    file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, byteLength, requestInit: { signal } }))
  }
  const metadata = await parquetMetadataAsync(file)
  const n = Number(metadata.num_rows)
  const out = Object.fromEntries(COLUMNS.map((c) => [c, new CTORS[c](n)])) as unknown as TileColumns
  await parquetRead({
    file,
    metadata,
    columns: [...COLUMNS],
    compressors,
    onChunk({ columnName, columnData, rowStart }) {
      const target = (out as unknown as Record<string, Uint32Array | Uint16Array | Uint8Array | Float32Array>)[columnName]
      if (!target) return
      const len = Math.min(columnData.length, n - rowStart)
      if (len <= 0) return
      if (typeof columnData[0] === 'bigint') {
        for (let i = 0; i < len; i++) target[rowStart + i] = Number(columnData[i] as bigint)
      } else {
        const src = columnData.length === len ? columnData : (columnData as ArrayLike<number> & { slice(a: number, b: number): ArrayLike<number> }).slice(0, len)
        target.set(src as ArrayLike<number>, rowStart)
      }
    },
  })
  return out
}

/** Run async tasks with a concurrency cap; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export { FETCH_CONCURRENCY }
