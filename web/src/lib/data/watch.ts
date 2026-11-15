// Watchlist for the landing page: the latest month's most unusual fire clusters (data/dist/watch.json,
// schema/watch.md). Shares the loader and types with the Global pulse; loads once per page.
import { loadWatch, rankWords, type WatchCluster, type WatchDoc } from '../pulse/watch'
import { normalizeRings, ringsAreaKm2, type Aoi } from '../geo'
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
  /** "about 15× normal", or "normally almost none" when the normal is near zero. */
  ratio: string
  /** "highest of 26 Octobers". */
  rank: string
}

/** Top clusters of the one-month window, best first, with the words the list shows. */
/** The watch month is still in progress (under 90 % of its days observed): its pace is shown, never a rank. */
export const watchInProgress = (doc: WatchDoc): boolean => (doc.windows.month.coverage ?? []).some((c) => c < 0.9)

export function watchItems(doc: WatchDoc, n = 6): WatchItem[] {
  const m = parseMonthIso(doc.month)
  const name = m == null ? 'month' : MONTHS_LONG[monthOf(m) - 1]
  const ip = watchInProgress(doc)
  return doc.windows.month.clusters.slice(0, n).map((c) => ({
    c,
    ratio: c.normal_near_zero ? 'normally almost none' : `about ${c.ratio >= 10 ? Math.round(c.ratio) : c.ratio.toFixed(1)}× ${ip ? 'the normal pace' : 'normal'}`,
    rank: ip ? 'month in progress, not ranked' : rankWords(c.record_rank, c.record_years, name),
  }))
}

/**
 * The cluster as an area of interest. watch.json carries no cell list, so the tightest geometry available is the
 * cluster's outline (the convex hull of its cells); its circle encloses even more (schema/watch.md). The outline
 * also takes in quieter land between and around the unusual cells, so the analysed ratio is lower than the listed
 * one. The label says so: it is the area AROUND the cluster, not the cluster.
 */
export function clusterAoi(c: WatchCluster, m: number): Aoi {
  return {
    rings: normalizeRings([c.polygon.map(([x, y]) => [x, y])]),
    shape: { kind: 'polygon' },
    label: `Around ${c.label} cluster — unusual fire, ${MONTHS_LONG[monthOf(m) - 1]} ${yearOf(m)}`,
  }
}

/** Area of the outline that clusterAoi opens, in km² (larger than the cluster's own `area_km2`). */
export function outlineAreaKm2(c: WatchCluster): number {
  return ringsAreaKm2([c.polygon.map(([x, y]) => [x, y])])
}
