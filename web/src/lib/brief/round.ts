// Deterministic rounding shared by the browser (dossier builder) and the server (validator re-rounds), so the
// serialised dossier does not depend on float noise. No imports: plain Node loads this file too.

/** Round to n significant figures; keeps 0 and non-finite handling explicit. */
export function sig(v: number, n = 3): number {
  if (v === 0 || !Number.isFinite(v)) return v === 0 ? 0 : v
  return +v.toPrecision(n)
}

/** Round to d decimals (fixed). */
export function fix(v: number, d: number): number {
  const f = 10 ** d
  return Math.round(v * f) / f
}
