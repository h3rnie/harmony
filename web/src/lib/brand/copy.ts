// Brand copy lines (direction A). The interface stays plain; the motto appears only on the patch.
export const TAGLINE = 'Two satellites. One fire record.'
export const MISSION =
  'Harmony joins two generations of fire-detecting satellites into one consistent record, so anyone responsible for a landscape can see when it burns, which years were extreme, and how this month compares with normal.'
export const DEDICATION = 'For everyone who works the fire line, the dispatch desk and the long night after.'
export const AUTHOR = { name: 'Toh Yu Heng', url: 'https://hello.hernie.me', place: 'Singapore' } as const
export const EVENT = 'NASA Space Apps 2026'
export const CHALLENGE = 'Harmonization of MODIS and VIIRS Hot Spots'
export const COPYRIGHT_YEAR = 2026

/** Open the About panel from anywhere (header, footer). */
export const openAbout = () => dispatchEvent(new CustomEvent('harmony:open-about'))

/** Open the Method section and scroll to it. */
export function openMethod(smooth = true) {
  dispatchEvent(new CustomEvent('harmony:open-method'))
  requestAnimationFrame(() => document.getElementById('method')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' }))
}
