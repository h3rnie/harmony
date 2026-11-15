<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { linear, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, fmtP, ordinal } from '../format'
  import { trendLine, trendWords } from '../analysisUtil'

  let { a }: { a: Analysis } = $props()

  let width = $state(600)
  const H = 220
  const M = { t: 14, r: 12, b: 24, l: 44 }
  const yrs = $derived(a.annual.years)
  const n = $derived(yrs.length)
  const band = $derived((width - M.l - M.r) / Math.max(1, n))
  const bw = $derived(Math.max(2, Math.min(24, band - 2)))
  const x = (i: number) => M.l + band * i + band / 2
  const yMax = $derived(niceMax(Math.max(1, ...a.annual.total.map((v) => v ?? 0))))
  const y = $derived(linear([0, yMax], [H - M.b, M.t]))
  const line = $derived(trendLine(a))
  const xOfYear = (yr: number) => x(yrs.indexOf(yr))
  const t = $derived(a.trend)
  const sentence = $derived(
    t.direction === 'none'
      ? `No significant trend over ${t.years[0]}–${t.years[1]} (${fmtP(t.pValue)}). Year-to-year variability dominates.`
      : `Activity is ${trendWords(a)} over ${t.years[0]}–${t.years[1]} (${fmtP(t.pValue)}, Mann–Kendall τ = ${t.tau.toFixed(2)}).`,
  )
  const ciPct = $derived.by(() => {
    const med = a.trend.slopePerYear !== 0 ? a.trend.slopePctPerYear / a.trend.slopePerYear : 0
    return [t.lo * med, t.hi * med]
  })
  let hover = $state<number | null>(null)
  const roundTop = (cx: number, top: number, w: number, base: number) => {
    const r = Math.min(4, w / 2, Math.max(0, base - top))
    const x0 = cx - w / 2, x1 = cx + w / 2
    return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`
  }
</script>

<section class="trend" aria-labelledby="trend-h">
  <p class="eyebrow">05 · Trend</p>
  <h2 id="trend-h">{t.direction === 'none' ? 'No significant trend' : t.direction === 'up' ? 'Rising' : 'Falling'}</h2>
  <p class="lede">{sentence}
    {#if Number.isFinite(t.slopePctPerYear)}Theil–Sen slope <span class="num">{t.slopePctPerYear >= 0 ? '+' : '−'}{Math.abs(t.slopePctPerYear).toFixed(1)} %/yr</span>
      (95 % CI <span class="num">{ciPct[0].toFixed(1)} to {ciPct[1].toFixed(1)}</span>).{/if}
  </p>

  <div class="chart" bind:clientWidth={width}>
    <svg {width} height={H} role="img" aria-label={`Annual totals ${yrs[0]}–${yrs[n - 1]} with Theil–Sen trend line. ${sentence}`} onpointerleave={() => (hover = null)}>
      <defs>
        <pattern id="hatch-trend" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" fill="transparent" /><line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-3)" stroke-width="1.5" />
        </pattern>
      </defs>
      {#each niceTicks(0, yMax, 4) as v (v)}
        <line class="grid" x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} />
        <text class="tk" x={M.l - 6} y={y(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
      {/each}
      {#each yrs as yr, i (yr)}
        {@const v = a.annual.total[i]}
        {#if v != null}
          <path d={roundTop(x(i), y(v), bw, y(0))} class="bar" class:partial={!a.annual.complete[i]} class:top={a.annual.rank[i] === 1}
            fill={a.annual.complete[i] ? undefined : 'url(#hatch-trend)'} />
        {/if}
        <rect x={x(i) - band / 2} y={M.t} width={band} height={H - M.t - M.b} fill="transparent" role="presentation" onpointerenter={() => (hover = i)} />
        {#if i % (width < 480 ? 6 : 4) === 0}<text class="tk" x={x(i)} y={H - 6} text-anchor="middle">{yr}</text>{/if}
      {/each}
      {#if line}
        <line class="tl" x1={xOfYear(line.x0)} x2={xOfYear(line.x1)} y1={y(Math.max(0, line.y0))} y2={y(Math.max(0, line.y1))} />
      {/if}
    </svg>
    {#if hover != null}
      <div class="tip" style:left={`${Math.min(width - 160, Math.max(0, x(hover) + 10))}px`}>
        <p class="tt">{yrs[hover]}{a.annual.complete[hover] ? '' : ' · partial'}</p>
        <p>Total <span class="num">{fmtNum(a.annual.total[hover])}</span></p>
        {#if a.annual.rank[hover] != null}<p class="muted">Rank <span class="num">{ordinal(a.annual.rank[hover]!)}</span></p>{/if}
      </div>
    {/if}
  </div>
  <ul class="keys">
    <li><span class="sw bar-sw"></span>Annual total (AFCD-M)</li>
    <li><span class="sw partial-sw"></span>Incomplete year</li>
    <li><span class="sw tl-sw"></span>Theil–Sen trend</li>
  </ul>
</section>

<style>
  .trend { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .lede { color: var(--ink-2); max-width: 68ch; margin: 8px 0 12px; }
  .chart { position: relative; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--rule); }
  .tk { font-family: var(--font-num); font-size: 10px; fill: var(--ink-3); }
  .bar { fill: var(--ink-3); }
  .bar.top { fill: var(--ink-2); }
  .bar.partial { stroke: var(--ink-3); stroke-width: 1; }
  .tl { stroke: var(--accent); stroke-width: 2; stroke-linecap: round; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; padding: 0; font-size: 0.74rem; color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 12px; height: 10px; }
  .bar-sw { background: var(--ink-3); border-radius: 2px 2px 0 0; }
  .partial-sw { background: repeating-linear-gradient(135deg, var(--ink-3) 0 1.5px, transparent 1.5px 4px); box-shadow: inset 0 0 0 1px var(--ink-3); }
  .tl-sw { height: 2px; width: 14px; background: var(--accent); }
  .tip {
    position: absolute; top: 4px; pointer-events: none; z-index: 5; min-width: 140px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: 0.76rem;
  }
  .tip p { margin: 0; display: flex; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; }
</style>
