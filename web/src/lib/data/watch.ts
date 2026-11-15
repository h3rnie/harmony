// Watchlist for the landing page: the latest month's most unusual fire clusters (data/dist/watch.json,
// schema/watch.md). Shares the loader and types with the Global pulse; loads once per page.
import { loadWatch, rankWords, type WatchCluster, type WatchDoc } from '../pulse/watch'
import { normalizeRings, type Aoi } from '../geo'
import { MONTHS_LONG, monthOf, parseMonthIso, yearOf } from '../format'

export type { WatchCluster, WatchDoc }
export { rankWords }

let cached: Promise<WatchDoc | null> | null = null
/** The watch file, fetched at most once (null when absent or malformed). */
export function watchDoc(): Promise<WatchDoc | null> {
  cached ??= loadWatch().then((d) => {
    if (!d) cached = null // let a later visit retry after a rebuild
    return d
  })
  return cached
}

export interface WatchItem {
  c: WatchCluster
  /** "15× normal", or "normally almost none" when the normal is near zero. */
  ratio: string
  /** "highest of 26 Octobers". */
  rank: string
}

/** Top clusters of the one-month window, best first, with the words the list shows. */
export function watchItems(doc: WatchDoc, n = 6): WatchItem[] {
  const m = parseMonthIso(doc.month)
  const name = m == null ? 'month' : MONTHS_LONG[monthOf(m) - 1]
  return doc.windows.month.clusters.slice(0, n).map((c) => ({
    c,
    ratio: c.normal_near_zero ? 'normally almost none' : `${c.ratio >= 10 ? Math.round(c.ratio) : c.ratio.toFixed(1)}× normal`,
    rank: rankWords(c.record_rank, c.record_years, name),
  }))
}

/** The cluster as an area of interest: its outline polygon (convex hull of its cells), labelled with the month. */
export function clusterAoi(c: WatchCluster, m: number): Aoi {
  return {
    rings: normalizeRings([c.polygon.map(([x, y]) => [x, y])]),
    shape: { kind: 'polygon' },
    label: `${c.label} — unusual fire, ${MONTHS_LONG[monthOf(m) - 1]} ${yearOf(m)}`,
  }
}
