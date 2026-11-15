// The live "pace" (last complete days vs the normal daily pace), shared by the answer card's "This week" line
// and the "What is burning right now?" section so both say the same thing.
import type { Analysis } from '../kernel/types'
import { session } from '../session.svelte'
import { live } from '../live/store.svelte'
import { calibrationFromSeries, computePace, type PaceResult } from '../live/pace'

export function livePace(a: Analysis): PaceResult | null {
  const data = live.data, inside = live.inside
  if (!data || !inside) return null
  return computePace({
    rows: data, inside, dn: session.dn, windowStart: data.window_start,
    // the clock only matters at day boundaries; fetched_at keeps this stable between refreshes
    now: Math.max(data.fetched_at, Math.floor(live.now / 1000)),
    refLon: live.refLon,
    sourceOk: { n20: !data.sources.VIIRS_NOAA20_NRT.error, n21: !data.sources.VIIRS_NOAA21_NRT.error },
    calibration: calibrationFromSeries(a.months, a.series.viirsCal, a.series.viirsRaw),
    normal: a.climatology,
  })
}

/** localStorage key: set once the viewer has clicked a month in the calendar, which retires the first-run tip. */
export const HINT_KEY = 'harmony.hint.calendar'

/** "early", "mid" or "late" part of the month for a date. */
export const partOfMonth = (d: Date) => (d.getUTCDate() <= 10 ? 'early' : d.getUTCDate() <= 20 ? 'mid' : 'late')

/** Scroll a guided-scroll section into view below the sticky header and index, and move focus to its title. */
export function goToSection(id: string, smooth = true) {
  const el = document.getElementById(id)
  if (!el) return
  // scroll-margin-top (app.css) is the one definition of the sticky header + index stack above a jump target.
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  scrollTo({ top: el.getBoundingClientRect().top + scrollY - margin, behavior: smooth ? 'smooth' : 'auto' })
  const h = el.querySelector<HTMLElement>('h2, h3') ?? el
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
  h.focus({ preventScroll: true })
}
