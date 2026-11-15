<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { linear, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, fmtP, ordinal, yearOf } from '../format'
  import { isSparse, trendLine, trendSuppressed } from '../analysisUtil'
  import { session } from '../session.svelte'
  import Term from './Term.svelte'

  let { a }: { a: Analysis } = $props()

  let width = $state(600)
  const H = 220
  const M = { t: 14, r: 12, b: 24, l: 44 }
  // Bars for the years shown ("Years shown" in the calendar settings); the trend itself uses every complete year.
  const shown = $derived.by(() => {
    const r = session.options.range
    const y0 = yearOf(r[0]), y1 = yearOf(r[1])
    return a.annual.years.map((yr, i) => ({ yr, i })).filter((o) => o.yr >= y0 && o.yr <= y1)
  })
  const yrs = $derived(shown.map((o) => o.yr))
  const n = $derived(yrs.length)
  const band = $derived((width - M.l - M.r) / Math.max(1, n))
  const bw = $derived(Math.max(2, Math.min(24, band - 2)))
  const x = (i: number) => M.l + band * i + band / 2
  const yMax = $derived(niceMax(Math.max(1, ...shown.map((o) => a.annual.total[o.i] ?? 0))))
  const y = $derived(linear([0, yMax], [H - M.b, M.t]))
  const suppressed = $derived(trendSuppressed(a))
  /** The trend line, clipped to the years shown. */
  const line = $derived.by(() => {
    const l = suppressed ? null : trendLine(a)
    if (!l || !yrs.length) return null
    const x0 = Math.max(l.x0, yrs[0]), x1 = Math.min(l.x1, yrs[yrs.length - 1])
    if (!(x1 > x0)) return null
    const at = (yr: number) => l.y0 + ((l.y1 - l.y0) * (yr - l.x0)) / (l.x1 - l.x0 || 1)
    return { x0, x1, y0: at(x0), y1: at(x1) }
  })
  const xOfYear = (yr: number) => x(yrs.indexOf(yr))
  const t = $derived(a.trend)
  const pct = $derived(Math.abs(t.slopePctPerYear))
  const pctText = $derived(pct < 1 ? pct.toFixed(1) : String(Math.round(pct)))
  const sentence = $derived(
    suppressed ? `Too little fire here to measure a trend${isSparse(a) ? '' : ' with any confidence'}.` : t.direction === 'none' || !Number.isFinite(t.slopePctPerYear)
      ? `No clear trend since ${t.years[0]}: the ups and downs from year to year are larger than any steady change.`
      : `Burning has ${t.direction === 'up' ? 'risen' : 'fallen'} about ${pctText} % a year since ${t.years[0]} (${t.pValue < 0.05 ? 'likely a real trend' : 'could be chance'}).`,
  )
  const answer = $derived(
    suppressed ? '' : t.direction === 'none' ? 'Not clearly.' : t.direction === 'up' ? (t.pValue < 0.05 ? 'Yes.' : 'Possibly.') : 'No.',
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

<section class="trend" id="trend" aria-labelledby="trend-h">
  <h2 id="trend-h" class="q-title">Is it getting worse?</h2>
  <p class="lead">{#if answer}<strong>{answer}</strong> {/if}{sentence}</p>

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
      {#each shown as o, i (o.yr)}
        {@const yr = o.yr}
        {@const v = a.annual.total[o.i]}
        {#if v != null}
          <path d={roundTop(x(i), y(v), bw, y(0))} class="bar" class:partial={!a.annual.complete[o.i]} class:top={!isSparse(a) && a.annual.rank[o.i] === 1}
            fill={a.annual.complete[o.i] ? undefined : 'url(#hatch-trend)'} />
        {/if}
        <rect x={x(i) - band / 2} y={M.t} width={band} height={H - M.t - M.b} fill="transparent" role="presentation" onpointerenter={() => (hover = i)} />
        {#if i % (width < 480 ? 6 : 4) === 0}<text class="tk" x={x(i)} y={H - 6} text-anchor="middle">{yr}</text>{/if}
      {/each}
      {#if line}
        <line class="tl" x1={xOfYear(line.x0)} x2={xOfYear(line.x1)} y1={y(Math.max(0, line.y0))} y2={y(Math.max(0, line.y1))} />
      {/if}
    </svg>
    {#if hover != null && shown[hover]}
      {@const k = shown[hover].i}
      <div class="tip" style:left={`${Math.min(width - 160, Math.max(0, x(hover) + 10))}px`}>
        <p class="tt">{shown[hover].yr}{a.annual.complete[k] ? '' : ' · partial'}</p>
        <p>Total <span class="num">{fmtNum(a.annual.total[k])}</span></p>
        {#if a.annual.rank[k] != null && !isSparse(a)}<p class="muted">Rank <span class="num">{ordinal(a.annual.rank[k]!)}</span></p>{/if}
      </div>
    {/if}
  </div>
  <ul class="keys">
    <li><span class="sw bar-sw"></span><span>Total for the year (<Term id="afcdm" />)</span></li>
    <li><span class="sw partial-sw"></span>Year not finished</li>
    {#if line}<li><span class="sw tl-sw"></span>Trend line</li>{/if}
  </ul>
  <details class="more">
    <summary>Details</summary>
    <div class="more-body">
      <p>
        {#if Number.isFinite(t.slopePctPerYear)}<Term id="theilsen" /> <span class="num">{t.slopePctPerYear >= 0 ? '+' : '−'}{Math.abs(t.slopePctPerYear).toFixed(1)} %</span> a year
          (95 % confidence <span class="num">{ciPct[0].toFixed(1)} to {ciPct[1].toFixed(1)}</span>), {t.years[0]}–{t.years[1]}, complete years only.{/if}
        <Term id="mannkendall" /> τ = <span class="num">{t.tau.toFixed(2)}</span>, <Term id="pvalue">{fmtP(t.pValue)}</Term>.
      </p>
    </div>
  </details>
</section>

<style>
  .trend { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .chart { position: relative; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--rule); }
  .tk { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .bar { fill: var(--ink-3); }
  .bar.top { fill: var(--ink-2); }
  .bar.partial { stroke: var(--ink-3); stroke-width: 1; }
  .tl { stroke: var(--ink); stroke-width: 2; stroke-linecap: round; stroke-dasharray: 6 4; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 12px; height: 10px; }
  .bar-sw { background: var(--ink-3); border-radius: 2px 2px 0 0; }
  .partial-sw { background: repeating-linear-gradient(135deg, var(--ink-3) 0 1.5px, transparent 1.5px 4px); box-shadow: inset 0 0 0 1px var(--ink-3); }
  .tl-sw { height: 2px; width: 14px; background: repeating-linear-gradient(90deg, var(--ink) 0 5px, transparent 5px 8px); }
  .tip {
    position: absolute; top: 4px; pointer-events: none; z-index: 5; min-width: 140px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: var(--fs-sm);
  }
  .tip p { margin: 0; display: flex; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; }
</style>
