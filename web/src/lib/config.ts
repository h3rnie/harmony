export const DATA_BASE: string = (import.meta.env.VITE_DATA_BASE ?? '/data').replace(/\/+$/, '')

/** Finest pyramid level whose AOI tiles total at most this many bytes is used. */
export const MAX_AOI_BYTES = 8 * 1024 * 1024
/** When tiles/index.json is unavailable (mock mode), cap the cell count instead. */
export const MAX_AOI_CELLS = 60_000
export const FETCH_CONCURRENCY = 4
export const DEBOUNCE_MS = 250
export const DEFAULT_BASELINE: [number, number] = [2003, 2022]

export const FIRMS_ACK =
  "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS)."
