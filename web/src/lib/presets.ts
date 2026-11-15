import type { Rings } from './geo'
import { normalizeRings } from './geo'

export interface Preset {
  id: string
  title: string
  subtitle: string
  /** Suggested focus month; year omitted = latest year in the record. */
  focus: { year?: number; month: number }
  rings: Rings
}

const P = (coords: number[][]): Rings => normalizeRings([coords])

// Hand-drawn outlines; deliberately generous so they capture the regional fire regime.
export const PRESETS: Preset[] = [
  {
    id: 'amazon-2019',
    title: 'Amazon arc of deforestation',
    subtitle: 'Rondônia · Mato Grosso · Pará — August 2019',
    focus: { year: 2019, month: 8 },
    rings: P([[-66.5, -10.2], [-63.5, -13.3], [-60, -14.6], [-55.5, -13.6], [-51, -11.2], [-47.6, -7.6], [-48.4, -3.8], [-51.8, -4.9], [-55, -6.6], [-58.6, -7.4], [-62.4, -7.7], [-65.6, -8.6]]),
  },
  {
    id: 'se-australia-2019',
    title: 'SE Australia — Black Summer',
    subtitle: 'NSW & East Gippsland — December 2019',
    focus: { year: 2019, month: 12 },
    rings: P([[145.6, -37.9], [148.2, -38.1], [150.2, -37.6], [151.2, -34.4], [152.6, -32.2], [153.6, -29.0], [152.6, -28.2], [150.8, -29.2], [149.6, -31.6], [148.6, -34.6], [147.0, -36.2]]),
  },
  {
    id: 'canada-2023',
    title: 'British Columbia & NW Territories',
    subtitle: 'Canada’s record season — August 2023',
    focus: { year: 2023, month: 8 },
    rings: P([[-128.5, 50.2], [-122.5, 49.1], [-117.5, 50.2], [-112.5, 55.5], [-108.5, 60.2], [-110.5, 63.4], [-117.5, 64.2], [-124.5, 62.6], [-129.6, 58.6], [-130.6, 54.4]]),
  },
  {
    id: 'gran-chaco',
    title: 'Gran Chaco',
    subtitle: 'Paraguay · Bolivia · Argentina — September 2020',
    focus: { year: 2020, month: 9 },
    rings: P([[-64.6, -18.6], [-60.8, -18.0], [-57.8, -20.4], [-57.6, -23.8], [-59.2, -26.8], [-62.2, -28.4], [-64.6, -26.4], [-65.2, -22.2]]),
  },
  {
    id: 'miombo',
    title: 'Miombo woodlands',
    subtitle: 'Zambia–Angola fire belt — dry-season peak, July',
    focus: { month: 7 },
    rings: P([[15.2, -10.4], [19.8, -9.2], [24.6, -9.6], [28.6, -10.2], [31.2, -12.6], [30.4, -15.6], [26.6, -17.2], [21.4, -16.8], [17.0, -16.2], [14.8, -13.4]]),
  },
  {
    id: 'norcal',
    title: 'Northern California',
    subtitle: 'August Complex & North Bay — September 2020',
    focus: { year: 2020, month: 9 },
    rings: P([[-124.4, 42.0], [-120.0, 42.0], [-120.0, 39.6], [-120.8, 38.4], [-122.4, 37.8], [-123.4, 38.2], [-124.0, 39.6], [-124.6, 40.8]]),
  },
]

export const presetById = (id: string | null | undefined) => PRESETS.find((p) => p.id === id)
