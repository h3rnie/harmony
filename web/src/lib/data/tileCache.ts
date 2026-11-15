// Byte-bounded, least-recently-used cache of decoded tiles (kept as promises so concurrent reads share one decode).
// Pure: no I/O, no Vite or DOM imports, so it is unit-tested in Node (scripts/kernel-smoke.mjs).
//
// - The budget is the sum of the decoded sizes (typed-array byteLengths); a tile counts once its decode finishes.
// - Reads still in flight are never evicted, and neither is any tile read or reused since the last beginRun(): the run
//   in progress keeps everything it needs, even when that alone exceeds the budget. Older tiles go first, LRU order.
// - A failed read is dropped, so the next request retries it.

interface Entry<T> { p: Promise<T>; bytes: number; settled: boolean; run: number }

export class TileCache<T> {
  readonly maxBytes: number
  private readonly sizeOf: (v: T) => number
  private readonly entries = new Map<string, Entry<T>>()
  private total = 0
  private run = 0

  constructor(maxBytes: number, sizeOf: (v: T) => number) {
    this.maxBytes = maxBytes
    this.sizeOf = sizeOf
  }

  /** Decoded bytes currently held. */
  get bytes(): number { return this.total }
  get size(): number { return this.entries.size }
  has(key: string): boolean { return this.entries.has(key) }

  /** A new run starts: tiles of earlier runs become evictable. */
  beginRun(): void {
    this.run++
    this.evict()
  }

  /** The cached value for `key`, or `load()` once (shared by concurrent callers). */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key) // most recently used goes last
      this.entries.set(key, hit)
      hit.run = this.run
      return hit.p
    }
    const e: Entry<T> = { p: load(), bytes: 0, settled: false, run: this.run }
    this.entries.set(key, e)
    e.p.then(
      (v) => {
        if (this.entries.get(key) !== e) return
        e.bytes = this.sizeOf(v)
        e.settled = true
        this.total += e.bytes
        this.evict()
      },
      () => { if (this.entries.get(key) === e) this.entries.delete(key) },
    )
    return e.p
  }

  private evict(): void {
    for (const [k, e] of this.entries) {
      if (this.total <= this.maxBytes) return
      if (!e.settled || e.run === this.run) continue
      this.entries.delete(k)
      this.total -= e.bytes
    }
  }
}
