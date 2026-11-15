// Small statistics used by the mock kernel and by a few UI derivations.

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const p = (sorted.length - 1) * q
  const lo = Math.floor(p), hi = Math.ceil(p)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo)
}
export const sortNum = (a: number[]) => [...a].sort((x, y) => x - y)
export const median = (a: number[]) => quantile(sortNum(a), 0.5)
export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1)

/** Percent of reference values below x, ties counted half (0..100). */
export function percentileOf(x: number, ref: number[]): number {
  if (!ref.length) return NaN
  let below = 0, eq = 0
  for (const r of ref) { if (r < x) below++; else if (r === x) eq++ }
  return (100 * (below + 0.5 * eq)) / ref.length
}

export function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number; lo: number; hi: number } {
  const slopes: number[] = []
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]))
  slopes.sort((a, b) => a - b)
  const slope = quantile(slopes, 0.5)
  const intercept = median(xs.map((x, i) => ys[i] - slope * x))
  // Sen's confidence interval from the Mann-Kendall variance.
  const n = xs.length
  const varS = (n * (n - 1) * (2 * n + 5)) / 18
  const c = 1.96 * Math.sqrt(varS)
  const m1 = Math.max(0, Math.floor((slopes.length - c) / 2))
  const m2 = Math.min(slopes.length - 1, Math.ceil((slopes.length + c) / 2))
  return { slope, intercept, lo: slopes[m1] ?? slope, hi: slopes[m2] ?? slope }
}

export function mannKendall(ys: number[]): { tau: number; p: number } {
  const n = ys.length
  let s = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += Math.sign(ys[j] - ys[i])
  const varS = (n * (n - 1) * (2 * n + 5)) / 18
  const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0
  const p = 2 * (1 - normCdf(Math.abs(z)))
  return { tau: n > 1 ? s / ((n * (n - 1)) / 2) : 0, p }
}

export function normCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return NaN
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n))
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb
    sab += da * db; saa += da * da; sbb += db * db
  }
  return sab / Math.sqrt(saa * sbb)
}

/** Deterministic PRNG. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function gaussian(rng: () => number) {
  const u = Math.max(1e-12, rng()), v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
