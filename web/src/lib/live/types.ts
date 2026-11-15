// Contract of GET /api/live and GET /api/live/status (web/server/liveCore.ts <-> web/src/lib/live/*).
// Plain types only (no runtime imports), so both the server core and Node test scripts can import it.

/** FIRMS NRT sources the proxy queries (S-NPP ended 2026-11-02 and is not queried). */
export const LIVE_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'] as const
export type LiveSource = (typeof LIVE_SOURCES)[number]

/** `sat` enum index -> name. */
export const LIVE_SATS = ['NOAA-20', 'NOAA-21', 'Terra', 'Aqua'] as const
export const SAT_N20 = 0
export const SAT_N21 = 1
export const SAT_TERRA = 2
export const SAT_AQUA = 3

/** `conf`: 0 low, 1 nominal, 2 high. MODIS 0-100 maps to <30 / 30-79 / >=80. */
export const LIVE_CONF = ['low', 'nominal', 'high'] as const

export interface LiveLimits {
  /** Largest snapped bbox the proxy accepts, in square degrees. */
  maxAreaDeg2: number
  maxDays: number
  /** bbox is snapped outward to this grid (degrees) so nearby requests share cache entries. */
  snapDeg: number
  /** Server cache lifetime; the client refreshes on the same period. */
  ttlSec: number
}

export interface LiveSourceInfo {
  rows: number
  /** Present when this source failed; the other sources may still have data. Never contains the key. */
  error?: string
}

export interface LiveResponse {
  v: 1
  /** Snapped bbox actually queried: west, south, east, north. */
  bbox: [number, number, number, number]
  days: number
  /** Epoch seconds (UTC) when the upstream data was fetched. */
  fetched_at: number
  /** Epoch seconds of the newest acquisition in the response, null when empty. */
  latest_t: number | null
  /** UTC start of the queried window (00:00 of the first day), epoch seconds. */
  window_start: number
  sources: Record<LiveSource, LiveSourceInfo>
  /** Served from the proxy cache (no upstream request for this response). */
  cached: boolean
  /** Served from an expired cache entry because FIRMS was busy or failing. */
  stale: boolean
  n: number
  // Columnar rows, all of length n.
  lat: number[]
  lon: number[]
  /** Acquisition time, epoch seconds UTC. */
  t: number[]
  /** Index into LIVE_SATS. */
  sat: number[]
  /** 0 low, 1 nominal, 2 high. */
  conf: number[]
  /** Fire radiative power, MW. */
  frp: number[]
  /** 0 day, 1 night. */
  dn: number[]
}

export interface LiveStatus {
  available: boolean
  sources: readonly LiveSource[]
  /** Newest acquisition known from the proxy cache (no upstream call), epoch seconds. */
  latest_t: number | null
  limits: LiveLimits
  /** Upstream FIRMS requests made by this server process (cache hits do not count). */
  upstream_requests: number
}

export interface LiveErrorBody {
  error: 'bad_request' | 'too_large' | 'rate_limited' | 'busy' | 'no_key' | 'upstream_error' | 'method_not_allowed' | 'internal_error'
  detail?: string
  limit?: number
  area?: number
  retryAfter?: number
}
