// Plain-language explanations for the words Harmony cannot avoid (WCAG 3.1.3, technique G62: a glossary).
// Shown in place by <Term id="…"> at the first use of the word in each section, and listed in the Method chapter.

export type TermId =
  | 'afcdm' | 'normal' | 'ratio' | 'percentile' | 'anomaly' | 'overpass' | 'theilsen' | 'mannkendall'
  | 'iqr' | 'likely' | 'provisional' | 'modiseq' | 'sensors' | 'seam' | 'pvalue'

export interface GlossaryEntry { term: string; text: string }

export const GLOSSARY: Record<TermId, GlossaryEntry> = {
  afcdm: {
    term: 'AFCD-M',
    text: 'Active-fire cell-days, MODIS-equivalent: Harmony’s unit. Each 1.4 km square that had at least one satellite fire detection on a given day or night counts once, counted the way MODIS counts them, so 2000 and 2026 are comparable. It measures fire activity, not burned area.',
  },
  normal: {
    term: 'Normal (baseline)',
    text: 'The median, or middle value, of the same calendar month across the baseline years. Change the years under “Years and normal” in the calendar.',
  },
  ratio: {
    term: '× normal',
    text: '2× means twice the usual activity for this month; 0.5× means half.',
  },
  percentile: {
    term: 'Percentile',
    text: 'The 83rd percentile means more active than 83 of every 100 baseline years for the same month.',
  },
  anomaly: {
    term: 'vs normal (anomaly)',
    text: 'How far a month is from its normal, as a ratio: 1× is normal, 2× is twice the usual, ½× half.',
  },
  overpass: {
    term: 'Satellite pass (overpass)',
    text: 'Each satellite crosses a place about once by day and once by night. Day-only or night-only keeps the detections from those passes alone; night passes see fewer but more persistent fires.',
  },
  theilsen: {
    term: 'Theil–Sen slope',
    text: 'A trend line that resists outliers: the median of the slopes between every pair of years.',
  },
  mannkendall: {
    term: 'Mann–Kendall test',
    text: 'Asks whether later years tend to be higher (or lower) than earlier ones. A p-value below 0.05 means the trend is unlikely to be chance.',
  },
  pvalue: {
    term: 'p-value',
    text: 'The chance of seeing a trend this strong if there were really none. Below 0.05: likely a real trend. Above: could be chance.',
  },
  iqr: {
    term: 'Interquartile range',
    text: 'The middle half of past values, from the 25th to the 75th percentile (q25–q75). Half of past years fall inside it.',
  },
  likely: {
    term: 'Likely range (80 %)',
    text: 'Eight times in ten the true value falls inside this range.',
  },
  provisional: {
    term: 'Provisional',
    text: 'Recent near-real-time data that has not had final quality checks yet. Numbers may change when the science-quality data arrive.',
  },
  modiseq: {
    term: 'MODIS-equivalent',
    text: 'Expressed in the units MODIS would have counted, so the record stays comparable after VIIRS takes over.',
  },
  sensors: {
    term: 'MODIS and VIIRS',
    text: 'Two generations of fire-detecting satellite instruments: MODIS on NASA’s Terra and Aqua (from 2000) and VIIRS on S-NPP, NOAA-20 and NOAA-21 (from 2012). VIIRS sees smaller fires, so its raw counts are higher.',
  },
  seam: {
    term: 'The 2012 seam',
    text: 'In 2012 the finer VIIRS sensor joined. Raw counts jump about fivefold because it sees more small fires, not because more burned.',
  },
}
