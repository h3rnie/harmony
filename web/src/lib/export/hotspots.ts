// Hotspot CSV export over the points archive (points/{px}_{py}/{year}.parquet), browser wiring.
// The reading, pruning and filtering logic lives in hotspotsCore.ts (no Svelte/DOM/Vite dependencies) so
// scripts/hotspots-export-test.mjs can run it under Node. This file adds DATA_BASE, the FIRMS acknowledgement
// and the points/index.json lookup.
import { DATA_BASE, FIRMS_ACK } from '../config'
import type { Rings } from '../geo'
import {
  DEFAULT_MAX_ROWS, exportHotspots, planHotspotExport, runHotspotExport,
  type HotspotExportOk, type HotspotPlan, type HotspotProgress, type HotspotTooLarge, type PointsIndex,
} from './hotspotsCore'

export { DEFAULT_MAX_ROWS, MAX_DOWNLOAD_BYTES, fmtBytes, isAbort, planTooLarge } from './hotspotsCore'
export type { HotspotExportOk, HotspotPlan, HotspotProgress, HotspotTooLarge, PointsIndex } from './hotspotsCore'

export class HotspotsUnavailable extends Error {}

let indexPromise: Promise<PointsIndex> | null = null

/** points/index.json, cached for the session. Throws HotspotsUnavailable when the archive is absent. */
export function loadPointsIndex(signal?: AbortSignal): Promise<PointsIndex> {
  if (!indexPromise) {
    const p = (async () => {
      let res: Response
      try {
        res = await fetch(`${DATA_BASE}/points/index.json`, { signal, cache: 'no-cache' })
      } catch {
        throw new HotspotsUnavailable('Hotspot export is not available (the points archive could not be reached).')
      }
      // A dev/static server answers unknown paths with index.html, so check the content type as well as the status.
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
        throw new HotspotsUnavailable('Hotspot export is not available: this data release has no points archive (points/index.json).')
      }
      try {
        return (await res.json()) as PointsIndex
      } catch {
        throw new HotspotsUnavailable('Hotspot export is not available: points/index.json is unreadable.')
      }
    })()
    p.catch(() => { if (indexPromise === p) indexPromise = null })
    indexPromise = p
  }
  return indexPromise
}

export interface HotspotRequestUi {
  rings: Rings
  mFrom: number
  mTo: number
  label?: string
  /** Monthly accepted detections of the area (analysis.months with rawModisCount + rawViirsCount), for the estimate. */
  activity?: { months: number[]; counts: number[] }
  onProgress?: (p: HotspotProgress) => void
  signal?: AbortSignal
}

const baseOptions = async (r: HotspotRequestUi) => ({
  index: await loadPointsIndex(r.signal),
  baseUrl: DATA_BASE,
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  signal: r.signal,
  onProgress: r.onProgress,
})

/** Step 1 of the UI flow: read Parquet footers, prune row groups, estimate rows and download size. No row data is downloaded. */
export async function planHotspots(r: HotspotRequestUi): Promise<HotspotPlan> {
  return planHotspotExport({ rings: r.rings, mFrom: r.mFrom, mTo: r.mTo, label: r.label, activity: r.activity }, await baseOptions(r))
}

/** Step 2: download the surviving row groups and build the CSV. rowLimit caps the rows (first N in file order). */
export function runHotspots(
  plan: HotspotPlan, o: { signal?: AbortSignal; onProgress?: (p: HotspotProgress) => void; rowLimit?: number },
): Promise<HotspotExportOk> {
  return runHotspotExport(plan, { ...o, ack: FIRMS_ACK })
}

/**
 * One-shot export. Resolves to a CSV blob, or to a structured "too-large" result (estimated rows above maxRows)
 * before any row data is downloaded; call again with force: true to export the first maxRows rows.
 */
export async function exportHotspotsCsv(
  r: HotspotRequestUi & { maxRows?: number; force?: boolean },
): Promise<HotspotExportOk | HotspotTooLarge> {
  return exportHotspots(
    { rings: r.rings, mFrom: r.mFrom, mTo: r.mTo, activity: r.activity },
    { ...(await baseOptions(r)), ack: FIRMS_ACK, label: r.label, maxRows: r.maxRows ?? DEFAULT_MAX_ROWS, force: r.force },
  )
}
