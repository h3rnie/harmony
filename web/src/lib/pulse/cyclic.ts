// Cyclic colour map for the fire clock: Crameri's "romaO" (Scientific colour maps v8, perceptually uniform,
// colour-vision-deficiency friendly, cyclic). Data: Fabio Crameri, Scientific colour maps, Zenodo,
// doi:10.5281/zenodo.1243862, MIT licence (Copyright (c) 2020 Fabio Crameri; as packaged in cmcrameri,
// https://github.com/callumrollo/cmcrameri). 256 sRGB entries, embedded below as hex.
//
// Month m (0 = January) sits at position fract(m / 12 + OFFSET) of the map, so that January is blue, April wine,
// July ochre and October pale green-teal; NH winter and NH summer read as opposite hues (blue vs orange).
// On the light theme the map's lightness is rescaled in OKLab (hue and chroma kept) so the pale end stays visible
// on a light ground; on the dark theme it is used as published.
import type { Theme } from '../color'

const ROMAO =
  '73395774395675395475385376385177385077384f78384d79384c79384b7a38497b38487c38477c39467d39457e39437e39' +
  '427f3a41803a40813b3f813b3e823c3d833c3c843d3b843d3a853e39863f388740378740378841368942358a43348b44338c' +
  '45338c46328d47318e48318f4930904a30914c2f924d2f934e2e94502e94512d95522d96542d97552c98572c99582c9a5a2c' +
  '9b5b2c9c5d2b9d5f2b9e602b9f622ba0642ca2662ca3672ca4692ca56b2da66d2da76f2da8712ea9732eaa752fab7730ad79' +
  '30ae7b31af7d32b07f33b18134b28335b48636b58837b68a39b78c3ab88e3bb9913dbb933fbc9540bd9842be9a44bf9c46c1' +
  '9f47c2a149c3a34bc4a54ec5a850c6aa52c8ac54c9af57cab159cbb35cccb55ecdb861ceba63cfbc66cfbe68d0c06bd1c26e' +
  'd2c470d2c673d3c876d4c978d4cb7bd4cd7ed5ce81d5d083d5d186d6d388d6d48bd6d58ed6d790d6d893d5d995d5da98d5db' +
  '9ad4dc9cd4dd9fd3dda1d3dea3d2dfa5d1dfa7d0e0a9cfe0abcee0adcde1afcce1b1cbe1b3cae1b5c8e1b6c7e1b8c5e1b9c4' +
  'e1bbc2e1bcc1e1bebfe1bfbde0c0bbe0c2b9dfc3b8dfc4b6dec5b4dec6b1ddc7afdcc8addcc8abdbc9a9dacaa7d9cba4d8cb' +
  'a2d7cca0d6cc9dd5cd9bd4cd99d3ce96d1ce94d0ce92cfce8fcecf8dcccf8bcbcf88c9cf86c8cf84c6cf81c5cf7fc3cf7dc2' +
  'ce7bc0ce78bece76bdce74bbcd72b9cd70b8cd6eb6cc6cb4cc6ab2cb68b1cb67afca65adca63abc962a9c960a8c85fa6c75d' +
  'a4c75ca2c65aa0c5599ec4589cc4579bc35699c25597c15495c05393bf5291be528fbd518dbc508bbb508aba4f88b94f86b8' +
  '4f84b74f82b64e80b44e7eb34e7cb24e7ab04f78af4f76ae4f75ac4f73ab5071a9506fa8516da6516ba45269a35267a15366' +
  '9f54649e54629c55609a565f98575d96575b945859935958915a568f5b558d5c538b5c52895d50875e4f855f4d83604c8161' +
  '4b7f62497d63487b63477964467765457666447467437268427068416e69406c6a3f6b6b3f696c3e676c3d656d3d646e3c62' +
  '6f3b606f3b5f703a5d713a5c723a5a723959'
/** Map position of January; months advance by 1/12. */
export const CLOCK_OFFSET = 0.8

type RGB = [number, number, number]
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const gam = (c: number) => Math.max(0, Math.min(255, Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))))
function toLab([r8, g8, b8]: RGB): RGB {
  const r = lin(r8), g = lin(g8), b = lin(b8)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function fromLab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)]
}

const BASE: RGB[] = Array.from({ length: 256 }, (_, i) => [0, 2, 4].map((k) => parseInt(ROMAO.slice(i * 6 + k, i * 6 + k + 2), 16)) as RGB)
const LUTS: Record<Theme, RGB[]> = {
  dark: BASE,
  // romaO spans OKLab L 0.43..0.88; on light grounds compress to 0.36..0.68 (darker, still ordered the same way)
  light: BASE.map((c) => { const [L, a, b] = toLab(c); return fromLab([0.36 + (L - 0.43) * 0.71, a * 1.05, b * 1.05]) }),
}

/** 256-entry cyclic LUT for a theme, already rotated so that index = round(255 * month / 12) (January = 0). */
export function clockLut(theme: Theme): RGB[] {
  const src = LUTS[theme]
  return Array.from({ length: 256 }, (_, i) => src[Math.round((((i / 256 + CLOCK_OFFSET) % 1) * 256)) % 256])
}

/** Colour of calendar month k (0..11) as CSS. */
export function monthColor(k: number, theme: Theme): string {
  const [r, g, b] = clockLut(theme)[Math.round((k / 12) * 256) % 256]
  return `rgb(${r}, ${g}, ${b})`
}
