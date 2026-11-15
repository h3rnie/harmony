// Minimal scales and path helpers for hand-built SVG charts (no runtime chart dependency).

export interface Linear {
  (v: number): number
  domain: [number, number]
  range: [number, number]
  invert(px: number): number
  ticks(n?: number): number[]
}

export function linear(domain: [number, number], range: [number, number]): Linear {
  const [d0, d1] = domain, [r0, r1] = range
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0)
  const f = ((v: number) => r0 + (v - d0) * k) as Linear
  f.domain = domain
  f.range = range
  f.invert = (px) => (k === 0 ? d0 : d0 + (px - r0) / k)
  f.ticks = (n = 5) => niceTicks(d0, d1, n)
  return f
}

export function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n)
  const p = 10 ** Math.floor(Math.log10(raw))
  const e = raw / p
  return (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * p
}
export function niceTicks(a: number, b: number, n = 5): number[] {
  if (!(b > a)) return [a]
  const step = niceStep(b - a, n)
  const out: number[] = []
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(+v.toFixed(10))
  return out
}
/** Upper bound rounded up to a nice value. */
export function niceMax(v: number, n = 4): number {
  if (!(v > 0)) return 1
  const step = niceStep(v, n)
  return Math.ceil(v / step) * step
}

type Pt = [number, number]

/** Polyline path with gaps where y is null. */
export function linePath(pts: (Pt | null)[]): string {
  let d = '', pen = false
  for (const p of pts) {
    if (!p) { pen = false; continue }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`
    pen = true
  }
  return d
}

/** Closed band between lower and upper series, split at gaps. */
export function bandPath(xs: number[], lo: (number | null)[], hi: (number | null)[]): string {
  let d = ''
  let seg: number[] = []
  const flush = () => {
    if (seg.length > 1) {
      d += 'M' + seg.map((i) => `${xs[i].toFixed(1)},${hi[i]!.toFixed(1)}`).join('L')
      d += 'L' + [...seg].reverse().map((i) => `${xs[i].toFixed(1)},${lo[i]!.toFixed(1)}`).join('L') + 'Z'
    }
    seg = []
  }
  for (let i = 0; i < xs.length; i++) {
    if (lo[i] == null || hi[i] == null) flush()
    else seg.push(i)
  }
  flush()
  return d
}

/** Short axis label: 0 · 500 · 1.5K · 20K · 3M */
export function tickLabel(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${+(v / 1e3).toFixed(0)}K`
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`
  return `${+v.toFixed(2)}`
}
