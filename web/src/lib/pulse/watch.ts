// Watchlist (data/dist/watch.json, schema/watch.md): clusters where fire is unusual in the latest month.
// Optional: a build without it simply shows no rings on the globe.
import { DATA_BASE } from '../config'

export interface WatchCluster {
  id: string
  rank: number
  label: string
  centroid: [number, number]
  bbox: [number, number, number, number]
  circle: { lon: number; lat: number; km: number }
  polygon: [number, number][]
  cells: number
  area_km2: number
  afcd: number
  normal_afcd: number
  excess_afcd: number
  ratio: number
  normal_near_zero: boolean
  percentile: number
  baseline_years_exceeded: number
  record_rank: number
  record_years: number
  record_max_year: number
  biome: string | null
}
export interface WatchWindow {
  months: [string, string]
  provisional: boolean
  /** Share of each month's days observed; under 0.9 = the month is still in progress (never ranked in the UI). */
  coverage?: number[]
  baseline_years: number
  record_years: [number, number]
  clusters: WatchCluster[]
}
export interface WatchDoc {
  version: number
  generated: string
  data_through: string
  month: string
  caveat: string
  windows: { month: WatchWindow; three_months: WatchWindow }
}

export async function loadWatch(signal?: AbortSignal): Promise<WatchDoc | null> {
  try {
    const r = await fetch(`${DATA_BASE}/watch.json`, { signal })
    if (!r.ok) return null
    const d = (await r.json()) as WatchDoc
    return d?.version === 1 && typeof d.month === 'string' && Array.isArray(d.windows?.month?.clusters) ? d : null
  } catch {
    return null
  }
}

/** "1st" / "2nd" / "highest" wording for a record rank. */
export function rankWords(rank: number, of: number, monthName: string): string {
  if (rank === 1) return `highest of ${of} ${monthName}s`
  const sfx = rank % 10 === 1 && rank % 100 !== 11 ? 'st' : rank % 10 === 2 && rank % 100 !== 12 ? 'nd' : rank % 10 === 3 && rank % 100 !== 13 ? 'rd' : 'th'
  return `${rank}${sfx} highest of ${of} ${monthName}s`
}
