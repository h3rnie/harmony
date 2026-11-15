// Live (near-real-time) state shared by the map layer, the Now card and the header badge.
// One request per AOI: the last 7 days for the AOI's bbox; the map filters by age client-side.
import { untrack } from 'svelte'
import { session } from '../session.svelte'
import { pointInRings, ringsBbox, ringsCentroid, type Aoi } from '../geo'
import { fetchLive, fetchLiveStatus, LiveFetchError } from './client'
import type { LiveResponse, LiveStatus } from './types'

export type LiveWindow = 'off' | '24h' | '48h' | '7d'
export const WINDOW_HOURS: Record<Exclude<LiveWindow, 'off'>, number> = { '24h': 24, '48h': 48, '7d': 168 }
export const FETCH_DAYS = 7
const DEFAULT_TTL_SEC = 600

type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'too-large'

function snapArea([w, s, e, n]: [number, number, number, number], g: number): number {
  return (Math.ceil(e / g - 1e-9) * g - Math.floor(w / g + 1e-9) * g) * (Math.ceil(n / g - 1e-9) * g - Math.floor(s / g + 1e-9) * g)
}

class LiveStore {
  status = $state.raw<LiveStatus | null>(null)
  /** True once /api/live/status has answered (or failed). */
  checked = $state(false)
  window = $state<LiveWindow>('off')
  data = $state.raw<LiveResponse | null>(null)
  /** inside[i] = 1 when row i lies in the AOI polygon. */
  inside = $state.raw<Uint8Array | null>(null)
  phase = $state<Phase>('idle')
  error = $state<string | null>(null)
  tooLarge = $state<{ area: number; limit: number } | null>(null)
  /** Ticks every 30 s so relative ages stay current. */
  now = $state(Date.now())
  /** Centroid longitude of the AOI the data was fetched for (local-solar day boundaries). */
  refLon = $state(0)

  private userWindow: LiveWindow | null = null
  private started = false
  private ctrl: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private due = false
  private forAoi: Aoi | null = null

  get available(): boolean { return this.status?.available === true }
  get limitDeg2(): number { return this.status?.limits.maxAreaDeg2 ?? 900 }
  /** Newest acquisition known: from our data, else from the proxy cache. */
  get latestT(): number | null { return this.data?.latest_t ?? this.status?.latest_t ?? null }

  init() {
    if (this.started) return
    this.started = true
    fetchLiveStatus().then((s) => {
      this.status = s
      this.checked = true
      if (s?.available) this.onAoi(session.aoi)
    })
    $effect.root(() => {
      $effect(() => {
        const aoi = session.aoi
        untrack(() => { if (this.checked) this.onAoi(aoi) })
      })
    })
    setInterval(() => (this.now = Date.now()), 30_000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.due) this.load()
    })
  }

  setWindow(w: LiveWindow) {
    this.userWindow = w
    this.window = w
  }

  retry() { this.load() }

  private onAoi(aoi: Aoi | null) {
    if (aoi === this.forAoi) return
    this.forAoi = aoi
    this.ctrl?.abort()
    clearTimeout(this.timer)
    this.data = null
    this.inside = null
    this.error = null
    this.tooLarge = null
    if (!aoi || !this.available) {
      this.window = 'off'
      this.phase = 'idle'
      return
    }
    this.window = this.userWindow ?? '24h'
    this.load()
  }

  async load() {
    const aoi = this.forAoi
    if (!aoi || !this.available) return
    this.due = false
    clearTimeout(this.timer)
    const bbox = ringsBbox(aoi.rings)
    const snap = this.status?.limits.snapDeg ?? 0.5
    const area = snapArea(bbox, snap)
    if (area > this.limitDeg2) {
      this.tooLarge = { area: Math.round(area), limit: this.limitDeg2 }
      this.phase = 'too-large'
      return
    }
    this.ctrl?.abort()
    const ctrl = new AbortController()
    this.ctrl = ctrl
    this.phase = 'loading'
    try {
      const d = await fetchLive(bbox, FETCH_DAYS, ctrl.signal)
      if (ctrl.signal.aborted || aoi !== this.forAoi) return
      const inside = new Uint8Array(d.n)
      for (let i = 0; i < d.n; i++) inside[i] = pointInRings(d.lon[i], d.lat[i], aoi.rings) ? 1 : 0
      this.refLon = ringsCentroid(aoi.rings)[0]
      this.inside = inside
      this.data = d
      this.error = null
      this.tooLarge = null
      this.phase = 'ready'
      this.now = Date.now()
    } catch (e) {
      if (ctrl.signal.aborted) return
      if (e instanceof LiveFetchError && e.code === 'too_large') {
        this.tooLarge = { area: e.body.area ?? Math.round(area), limit: e.body.limit ?? this.limitDeg2 }
        this.phase = 'too-large'
        return
      }
      this.error = e instanceof LiveFetchError
        ? e.code === 'busy' ? 'FIRMS is busy right now (shared request budget nearly used). Retrying automatically.'
          : e.code === 'rate_limited' ? 'Too many live requests; retrying shortly.'
          : e.code === 'upstream_error' ? 'FIRMS did not answer. Retrying automatically.'
          : e.message
        : 'Live data could not be loaded (network error).'
      this.phase = 'error'
    } finally {
      if (this.ctrl === ctrl && !ctrl.signal.aborted) this.schedule(this.phase === 'error' ? 120 : (this.status?.limits.ttlSec ?? DEFAULT_TTL_SEC))
    }
  }

  /** Auto-refresh while the tab is visible; a hidden tab refreshes when it becomes visible again. */
  private schedule(sec: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (document.visibilityState === 'visible') this.load()
      else this.due = true
    }, sec * 1000)
  }
}

export const live = new LiveStore()

/** "just now" · "12 min" · "3 h" · "2 d" */
export function fmtAge(sec: number): string {
  if (!Number.isFinite(sec) || sec < 90) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)} min`
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86400)} d`
}
