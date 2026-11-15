// Optional "now" summary for Ask Harmony, derived from the live layer when it has data for the current area.
// Consumed defensively: if the live module is absent, empty or still loading, this returns null and the dossier
// simply has no `now` field. Depends only on the stable LiveResponse contract (live/types.ts).
import { live } from '../live/store.svelte'
import type { LiveNow } from './dossierTypes'

export function liveNowSummary(): LiveNow | null {
  try {
    const d = live.data
    const inside = live.inside
    if (!d || !inside || live.phase !== 'ready' || !Array.isArray(d.t) || d.t.length !== d.n) return null
    const nowSec = Math.floor(Date.now() / 1000)
    let h24 = 0, h48 = 0, d7 = 0, hi24 = 0
    let newest: number | null = null
    for (let k = 0; k < d.n; k++) {
      if (!inside[k]) continue
      const age = nowSec - d.t[k]
      if (age < 0 || age > 7 * 86400) continue
      d7++
      if (age <= 48 * 3600) h48++
      if (age <= 24 * 3600) { h24++; if (d.conf[k] === 2) hi24++ }
      if (newest == null || d.t[k] > newest) newest = d.t[k]
    }
    return {
      last24h: h24, last48h: h48, last7d: d7, highConfidence24h: hi24,
      newestAgeHours: newest == null ? null : Math.round(((nowSec - newest) / 3600) * 10) / 10,
    }
  } catch {
    return null
  }
}
