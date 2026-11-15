// Hotspot CSV export over the points archive (points/{px}_{py}/{year}.parquet).
// STUB: the polygon-exact reader is implemented separately. This keeps the UI contract stable.
import { DATA_BASE } from '../config'
import type { MonthIndex } from '../kernel/types'

export interface HotspotExportRequest {
  rings: number[][][]
  bbox: [number, number, number, number]
  /** Inclusive month range. */
  range: [MonthIndex, MonthIndex]
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export class HotspotsUnavailable extends Error {}

/** Resolves to a CSV blob (with the FIRMS acknowledgement), or throws HotspotsUnavailable. */
export async function exportHotspotsCsv(req: HotspotExportRequest): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(`${DATA_BASE}/points/index.json`, { signal: req.signal })
  } catch {
    throw new HotspotsUnavailable('Hotspot export is not available yet (points archive unreachable).')
  }
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new HotspotsUnavailable('Hotspot export is not available yet (points archive not built).')
  }
  throw new HotspotsUnavailable('Hotspot export is not available yet.')
}
