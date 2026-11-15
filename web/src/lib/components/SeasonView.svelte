<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { linear, linePath, bandPath, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { MONTHS_INITIAL, MONTHS_SHORT, fmtNum, fmtRatio, ordinal } from '../format'

  let { a }: { a: Analysis } = $props()

  let w1 = $state(320)
  let w2 = $state(320)
  const H = 220
  const M = { t: 14, r: 12, b: 22, l: 40 }

  const curYear = $derived(a.current.year)
  const yearsDesc = $derived([...a.calendar.years].reverse().filter((y) => y !== curYear))
  const defaultCompare = $derived.by(() => {
    const f = session.focus
    const fy = f == null ? null : Math.floor(f / 12) + 2000
    if (fy != null && fy !== curYear) return fy
    return a.records.topYears.find((t) => t.year !== curYear)?.year ?? yearsDesc[0]
  })
  let compare = $state<number | null>(null)
  const cmpYear = $derived(compare ?? defaultCompare)

  const row = (y: number) => {
    const i = a.calendar.years.indexOf(y)
    return i < 0 ? Array(12).fill(null) : a.calendar.value[i]
  }
  const cur = $derived(row(curYear))
  const cmp = $derived(row(cmpYear))
  const c = $derived(a.climatology)

  // ---- seasonal curve ----
  const sMax = $derived(niceMax(Math.max(1, ...c.q90, ...cur.map((v) => v ?? 0), ...cmp.map((v) => v ?? 0))))
  const sx = $derived(linear([1, 12], [M.l, w1 - M.r]))
  const sy = $derived(linear([0, sMax], [H - M.b, M.t]))
  const mx = $derived(Array.from({ length: 12 }, (_, i) => sx(i + 1)))
  const pathOf = (vals: (number | null)[], x: number[], y: (v: number) => number) =>
    linePath(vals.map((v, i) => (v == null ? null : [x[i], y(v)])))

  // ---- YTD ----
  const yt = $derived(a.ytd)
  const yMax = $derived(niceMax(Math.max(1, ...yt.max, ...yt.current)))
  const yx = $derived(linear([1, 12], [M.l, w2 - M.r]))
  const yy = $derived(linear([0, yMax], [H - M.b, M.t]))
  const yxs = $derived(Array.from({ length: 12 }, (_, i) => yx(i + 1)))

  let hs = $state<number | null>(null)
  let hy = $state<number | null>(null)
  const pick = (e: PointerEvent, width: number, x: (v: number) => number) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * width
    let best = 0
    for (let i = 1; i < 12; i++) if (Math.abs(x(i + 1) - px) < Math.abs(x(best + 1) - px)) best = i
    return best
  }
</script>

<section class="season" aria-labelledby="season-h">
  <p class="eyebrow">04 · Season & year to date</p>
  <h2 id="season-h">How {curYear} is unfolding</h2>

  <div class="pair">
    <figure>
      <figcaption>
        <span>Monthly activity vs the {session.effectiveBaseline.join('–')} envelope</span>
        <label class="cmp">Compare with
          <select name="compare-year" bind:value={() => cmpYear, (v) => (compare = v)} aria-label="Comparison year">
            {#each yearsDesc as y (y)}<option value={y}>{y}</option>{/each}
          </select>
        </label>
      </figcaption>
      <div class="chart" bind:clientWidth={w1}>
        <svg width={w1} height={H} role="img" onpointermove={(e) => (hs = pick(e, w1, sx))} onpointerleave={() => (hs = null)}
          aria-label={`Seasonal curve: median peaks in ${MONTHS_SHORT[a.season.peakMonth - 1]}. ${curYear} so far and ${cmpYear} shown against the 10–90 and 25–75 percentile envelopes.`}>
          {#each niceTicks(0, sMax, 4) as v (v)}
            <line class="grid" x1={M.l} x2={w1 - M.r} y1={sy(v)} y2={sy(v)} />
            <text class="tk" x={M.l - 6} y={sy(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
          {/each}
          {#each MONTHS_INITIAL as l, i (i)}<text class="tk" x={mx[i]} y={H - 6} text-anchor="middle">{l}</text>{/each}
          <path class="env-o" d={bandPath(mx, c.q10.map(sy), c.q90.map(sy))} />
          <path class="env-i" d={bandPath(mx, c.q25.map(sy), c.q75.map(sy))} />
          <path class="ln med" d={pathOf(c.median, mx, sy)} />
          <path class="ln cmp" d={pathOf(cmp, mx, sy)} />
          <path class="ln cur" d={pathOf(cur, mx, sy)} />
          {#each cur as v, i (i)}{#if v != null}<circle class="dot cur" cx={mx[i]} cy={sy(v)} r="3.5" />{/if}{/each}
          {#if hs != null}<line class="cross" x1={mx[hs]} x2={mx[hs]} y1={M.t} y2={H - M.b} />{/if}
        </svg>
        {#if hs != null}
          <div class="tip" style:left={`${Math.min(w1 - 170, Math.max(0, mx[hs] + 8))}px`}>
            <p class="tt">{MONTHS_SHORT[hs]}</p>
            <p><span class="sw cur"></span>{curYear}<span class="num">{fmtNum(cur[hs])}</span></p>
            <p><span class="sw cmp"></span>{cmpYear}<span class="num">{fmtNum(cmp[hs])}</span></p>
            <p><span class="sw med"></span>Median<span class="num">{fmtNum(c.median[hs])}</span></p>
            <p class="muted">IQR<span class="num">{fmtNum(c.q25[hs])}–{fmtNum(c.q75[hs])}</span></p>
          </div>
        {/if}
      </div>
      <ul class="keys">
        <li><span class="sw cur"></span>{curYear}</li>
        <li><span class="sw cmp"></span>{cmpYear}</li>
        <li><span class="sw med"></span>Median</li>
        <li><span class="sw env"></span>25–75 % / 10–90 %</li>
      </ul>
    </figure>

    <figure>
      <figcaption>
        <span>Cumulative activity, {yt.year} through {MONTHS_SHORT[yt.throughMonth - 1]}</span>
        <span class="num ytd-k">{fmtRatio(yt.ratio)} median · {ordinal(yt.rank)} of {yt.of}</span>
      </figcaption>
      <div class="chart" bind:clientWidth={w2}>
        <svg width={w2} height={H} role="img" onpointermove={(e) => (hy = pick(e, w2, yx))} onpointerleave={() => (hy = null)}
          aria-label={`Year to date: ${fmtNum(yt.current[yt.current.length - 1])} AFCD-M through ${MONTHS_SHORT[yt.throughMonth - 1]}, ${fmtRatio(yt.ratio)} the median, rank ${yt.rank} of ${yt.of}.`}>
          {#each niceTicks(0, yMax, 4) as v (v)}
            <line class="grid" x1={M.l} x2={w2 - M.r} y1={yy(v)} y2={yy(v)} />
            <text class="tk" x={M.l - 6} y={yy(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
          {/each}
          {#each MONTHS_INITIAL as l, i (i)}<text class="tk" x={yxs[i]} y={H - 6} text-anchor="middle">{l}</text>{/each}
          <path class="env-o" d={bandPath(yxs, yt.min.map(yy), yt.max.map(yy))} />
          <path class="env-i" d={bandPath(yxs, yt.q25.map(yy), yt.q75.map(yy))} />
          <path class="ln med" d={pathOf(yt.median, yxs, yy)} />
          <path class="ln cur" d={pathOf(yt.current, yxs, yy)} />
          {#if yt.current.length}
            <circle class="dot cur" cx={yxs[yt.current.length - 1]} cy={yy(yt.current[yt.current.length - 1])} r="4" />
          {/if}
          {#if hy != null}<line class="cross" x1={yxs[hy]} x2={yxs[hy]} y1={M.t} y2={H - M.b} />{/if}
        </svg>
        {#if hy != null}
          <div class="tip" style:left={`${Math.min(w2 - 170, Math.max(0, yxs[hy] + 8))}px`}>
            <p class="tt">Through {MONTHS_SHORT[hy]}</p>
            {#if yt.current[hy] != null}<p><span class="sw cur"></span>{yt.year}<span class="num">{fmtNum(yt.current[hy])}</span></p>{/if}
            <p><span class="sw med"></span>Median<span class="num">{fmtNum(yt.median[hy])}</span></p>
            <p class="muted">Range<span class="num">{fmtNum(yt.min[hy])}–{fmtNum(yt.max[hy])}</span></p>
          </div>
        {/if}
      </div>
      <ul class="keys">
        <li><span class="sw cur"></span>{yt.year}</li>
        <li><span class="sw med"></span>Median</li>
        <li><span class="sw env"></span>25–75 % / min–max</li>
      </ul>
    </figure>
  </div>
</section>

<style>
  .season { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  h2 { margin-bottom: 12px; }
  .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 22px 28px; }
  figure { margin: 0; min-width: 0; }
  figcaption { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: var(--fs-md); color: var(--ink-2); margin-bottom: 6px; min-height: 32px; }
  .cmp { display: inline-flex; gap: 6px; align-items: center; font-size: var(--fs-sm); color: var(--ink-3); }
  .cmp select { min-height: 26px; font-family: var(--font-num); font-size: var(--fs-sm); }
  .ytd-k { color: var(--ink); font-size: var(--fs-sm); }
  .chart { position: relative; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--rule); }
  .tk { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .env-o { fill: var(--env-outer); }
  .env-i { fill: var(--env-inner); }
  .ln { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .ln.med { stroke: var(--ink-3); stroke-width: 1.5; }
  .ln.cmp { stroke: var(--ink); stroke-width: 1.5; opacity: 0.85; }
  .ln.cur { stroke: var(--accent); }
  .dot.cur { fill: var(--accent); stroke: var(--bg); stroke-width: 2; }
  .cross { stroke: var(--ink-3); }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 14px; height: 2px; flex: none; }
  .sw.cur { background: var(--accent); }
  .sw.cmp { background: var(--ink); }
  .sw.med { background: var(--ink-3); }
  .sw.env { height: 9px; background: linear-gradient(var(--env-inner), var(--env-inner)) center / 100% 5px no-repeat, var(--env-outer); }
  .tip {
    position: absolute; top: 4px; pointer-events: none; z-index: 5; min-width: 160px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: var(--fs-sm);
  }
  .tip p { margin: 0; display: flex; align-items: center; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; }
</style>
