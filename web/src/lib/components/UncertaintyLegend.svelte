<script lang="ts">
  // Arc (wedge) legend for the value-suppressing uncertainty palette, after Correll, Moritz & Heer (CHI 2018):
  // angle = activity (less fire left, more fire right), rings = confidence (outer = more certain, 8 colours;
  // centre = less certain, 1 colour). Each ring also carries the calendar's dot pattern, so the key never relies on colour.
  import { inkOn, vsupBinColor, UNC_BINS, UNC_RANGE, UNC_WORD, type ActDomain, type Theme, type UncClass } from '../color'
  import { fmtNum } from '../format'
  import Term from './Term.svelte'

  let { dom, theme }: { dom: ActDomain; theme: Theme } = $props()

  const W = 344, H = 150, CX = 190, CY = 140, A = (60 * Math.PI) / 180
  const RINGS: [number, number][] = [[100, 124], [76, 100], [52, 76], [28, 52]]
  const DOT: Record<number, { s: number; o: number }> = { 1: { s: 7, o: 0.45 }, 2: { s: 4.5, o: 0.55 }, 3: { s: 3, o: 0.6 } }
  const pt = (r: number, th: number): [number, number] => [CX + r * Math.sin(th), CY - r * Math.cos(th)]
  const f = (n: number) => n.toFixed(2)

  function seg(r0: number, r1: number, t0: number, t1: number): string {
    const [ax, ay] = pt(r1, t0), [bx, by] = pt(r1, t1), [cx, cy] = pt(r0, t1), [dx, dy] = pt(r0, t0)
    return `M${f(ax)},${f(ay)}A${r1},${r1} 0 0 1 ${f(bx)},${f(by)}L${f(cx)},${f(cy)}A${r0},${r0} 0 0 0 ${f(dx)},${f(dy)}Z`
  }
  const segs = $derived(
    RINGS.flatMap(([r0, r1], u) => {
      const n = UNC_BINS[u]
      return Array.from({ length: n }, (_, b) => {
        const fill = vsupBinColor(b, u as UncClass, theme)
        const dark = inkOn(fill) !== '#101114'
        return { d: seg(r0, r1, -A + (2 * A * b) / n, -A + (2 * A * (b + 1)) / n), fill, u, pat: u > 0 ? `url(#unc-dots-${u}-${dark ? 'l' : 'd'})` : null }
      })
    }),
  )
  // Ring labels on the right edge; "more certain → less certain" along the left edge.
  const ringLabels = RINGS.map(([r0, r1], u) => {
    const [x, y] = pt((r0 + r1) / 2, A)
    return { x: x + 10, y: y + 4, t: UNC_WORD[u] }
  })
  const nx = -Math.cos(A), ny = Math.sin(A) // outward normal of the left edge
  const edge = (r: number, off: number): [number, number] => { const [x, y] = pt(r, -A); return [x + nx * off, y + ny * off] }
  const arrowA = edge(102, 12), arrowB = edge(38, 12)
  const moreC = edge(122, 12), lessC = edge(28, 14)
  // Key swatches: an upper-middle bin of each class (where suppression is easiest to see).
  const keySw = $derived(UNC_BINS.map((n, u) => vsupBinColor(Math.floor(n * 0.65), u as UncClass, theme)))
</script>

<div class="ulegend">
  <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby="ulg-t">
    <title id="ulg-t">Legend: colour shows activity, from less fire on the left to more fire on the right. Outer rings are more certain and use 8 colours; towards the centre months are less certain, drawn with fewer, greyer colours and denser dots.</title>
    <defs>
      {#each [1, 2, 3] as u (u)}
        {#each [['d', '#101114'], ['l', '#f6f4ef']] as [k, ink] (k)}
          <pattern id={`unc-dots-${u}-${k}`} width={DOT[u].s} height={DOT[u].s} patternUnits="userSpaceOnUse">
            <circle cx={DOT[u].s / 2} cy={DOT[u].s / 2} r="0.95" fill={ink} fill-opacity={DOT[u].o} />
          </pattern>
        {/each}
      {/each}
    </defs>
    {#each segs as s, i (i)}
      <path d={s.d} fill={s.fill} stroke="var(--bg)" stroke-width="1" />
      {#if s.pat}<path d={s.d} fill={s.pat} stroke="none" />{/if}
    {/each}
    <text x={CX} y="10" text-anchor="middle" class="lab">less fire <tspan class="tick">(0)</tspan> <tspan class="arr">→</tspan> more fire <tspan class="tick">({fmtNum(dom[1])})</tspan></text>
    {#each ringLabels as l (l.t)}<text x={l.x} y={l.y} class="ring">{l.t}</text>{/each}
    <line x1={arrowA[0]} y1={arrowA[1]} x2={arrowB[0]} y2={arrowB[1]} class="axis" marker-end="url(#ulg-arrow)" />
    <defs><marker id="ulg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8z" class="head" /></marker></defs>
    <text x={moreC[0] - 2} y={moreC[1] + 4} text-anchor="end" class="lab">more certain</text>
    <text x={lessC[0] - 2} y={lessC[1] + 4} text-anchor="end" class="lab">less certain</text>
  </svg>
  <div class="txt">
    <p class="cap">Colour shows activity (<Term id="afcdm" /> per month, log scale); fading and dots show <Term id="confidence">how sure</Term> the value is.</p>
    <ul class="ukeys">
      {#each UNC_WORD as w, u (w)}
        <li><span class="sw" class:d1={u === 1} class:d2={u === 2} class:d3={u === 3} style:background={keySw[u]} style:color={inkOn(keySw[u])}></span><span><strong>{w[0].toUpperCase() + w.slice(1)}</strong>: likely range {UNC_RANGE[u]}</span></li>
      {/each}
    </ul>
    <p class="help">Values in faded, dotted cells cannot be read precisely — that is the point. Switch to <em>Activity</em> to read them.</p>
  </div>
</div>

<style>
  .ulegend { display: flex; flex-wrap: wrap; gap: 6px 20px; align-items: flex-start; }
  svg { max-width: 100%; height: auto; flex: none; overflow: visible; }
  .lab { font-size: 12px; fill: var(--ink-2); font-family: var(--font-ui); }
  .arr { fill: var(--ink-3); }
  .tick { font-size: 11px; fill: var(--ink-3); font-family: var(--font-num); }
  .ring { font-size: 12px; fill: var(--ink-2); font-family: var(--font-ui); }
  .axis { stroke: var(--ink-3); stroke-width: 1.2; }
  .head { fill: var(--ink-3); }
  .txt { flex: 1 1 220px; min-width: 0; max-width: var(--measure); }
  .cap { font-size: var(--fs-sm); color: var(--ink-2); margin: 0 0 6px; }
  .ukeys { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; font-size: var(--fs-sm); color: var(--ink-2); }
  .ukeys li { display: flex; align-items: center; gap: 8px; }
  .ukeys strong { font-weight: 600; color: var(--ink); }
  .sw { position: relative; width: 22px; height: 14px; border-radius: 2px; flex: none; overflow: hidden; }
  .sw.d1::before, .sw.d2::before, .sw.d3::before {
    content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle, currentColor 0.9px, transparent 1.3px);
  }
  .sw.d1::before { background-size: 7px 7px; opacity: 0.45; }
  .sw.d2::before { background-size: 4.5px 4.5px; opacity: 0.55; }
  .sw.d3::before { background-size: 3px 3px; opacity: 0.6; }
  .help { font-size: var(--fs-sm); color: var(--ink-3); margin: 6px 0 0; }
</style>
