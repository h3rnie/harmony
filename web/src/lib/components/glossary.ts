// Plain-language explanations for the words Harmony cannot avoid (WCAG 3.1.3, technique G62: a glossary).
// Shown in place by <Term id="…"> at the first use of the word in each section, and listed in the Method chapter.

export type TermId =
  | 'afcdm' | 'normal' | 'ratio' | 'percentile' | 'anomaly' | 'overpass' | 'theilsen' | 'mannkendall'
  | 'iqr' | 'likely' | 'provisional' | 'modiseq' | 'sensors' | 'seam' | 'pvalue' | 'hearing' | 'confidence'
  | 'fusion' | 'triplecoll' | 'commonmode' | 'overpasstime' | 'drift' | 'placebo' | 'conformal' | 'coverage'
  | 'afcdv' | 'analogs'

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
    text: 'The range the value should fall in about eight times in ten. Its width is calibrated on past years that were held out; tested on later years it held about three times in four, so treat it as a guide, not a guarantee.',
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
    text: 'In 2012 the finer VIIRS sensor joined. Raw detection counts jump because it sees more small fires, not because more burned: about 4 times the MODIS count with one VIIRS satellite (2012–2017), about 8 times with two (2018–2022) and 12 to 14 times with three (from 2023).',
  },
  hearing: {
    term: 'Hearing the record',
    text: 'One note per month. Higher pitch means more fire: the quietest month of this area sounds at the bottom, the busiest about two and a half octaves up, and equal steps in pitch are equal ratios. A soft tick starts each year. Silence is a month outside the record; a soft low tone is a month with no detections. The sound is an aid and a demonstration, not a measurement: read the numbers in the calendar or the text version.',
  },
  confidence: {
    term: 'Confidence',
    text: 'How narrow the likely range (80 %) of a month is, compared with its value. The record is less certain where the satellites saw only part of the month, where the older Terra-only years are bridged, and in recent provisional months. Less certain months are drawn with fewer, greyer colours and a dot pattern, so they cannot be over-read.',
  },
  fusion: {
    term: 'Sensor fusion',
    text: 'Where MODIS and VIIRS both fly, Harmony does not pick one: it averages them, giving each a weight from how noisy it has been measured to be. The less reliable stream counts for less. Before 2012 the record is MODIS alone; when MODIS ends it is VIIRS alone.',
  },
  triplecoll: {
    term: 'Triple collocation',
    text: 'A way to measure how noisy each of three instruments is without knowing the truth: if three independent sensors watch the same fires, how much each disagrees with the other two reveals its own error. Here the three are Terra, Aqua and VIIRS.',
  },
  commonmode: {
    term: 'Common-mode error',
    text: 'An error that two sensors share, so comparing them cannot reveal it. Aqua and the VIIRS satellites all pass in the early afternoon, so clouds or burning habits at that hour affect both alike. Harmony estimates this shared part and widens the range for it.',
  },
  overpasstime: {
    term: 'Overpass time',
    text: 'The local time at which a satellite crosses a place. Fires burn more in the afternoon than in the morning, so a satellite that passes earlier sees fewer of them, even if nothing changed on the ground.',
  },
  drift: {
    term: 'Orbit drift',
    text: 'Terra and Aqua no longer hold their orbits: since about 2021 Terra crosses the equator earlier and Aqua later each year. Their fire counts change with the clock, not with the fires. VIIRS keeps its time and serves as the fixed reference.',
  },
  placebo: {
    term: 'Placebo years',
    text: '2012 to 2019, before the orbits drifted. The same test run on these years should find no change; how far it strays from 1 is the test’s own noise.',
  },
  conformal: {
    term: 'Conformal calibration',
    text: 'Instead of trusting a formula for how wide a range should be, Harmony checks past predictions against what MODIS actually saw in years that were held out, and widens or narrows the range until it caught the right share. It is done separately for each kind of landscape and size of fire activity.',
  },
  coverage: {
    term: 'Coverage',
    text: 'The share of months whose actual value fell inside the stated range. An 80 % range should cover 80 % of months. Measured on years the method never saw, it is a fact about the past, not a promise.',
  },
  afcdv: {
    term: 'AFCD-V',
    text: 'Active-fire cell-days, VIIRS-equivalent: the same record re-expressed in the units VIIRS counts, the sensor that carries fire monitoring after MODIS ends. Each month is divided by this area’s own VIIRS-to-MODIS factor for that calendar month. Ratios to normal, percentiles and ranks within a month do not change; only totals do.',
  },
  analogs: {
    term: 'Analog years',
    text: 'Past years whose months so far most resemble this year’s, month by month. What those years did next is a hint about the rest of this year, not a forecast. Harmony checks, by testing the method on every past year, whether such hints have worked here, and shows them only if they have.',
  },
}
