<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { linear, linePath, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, fmtRatio, monthShort, MONTHS_SHORT } from '../format'
  import { seriesIndex } from '../analysisUtil'

  let { a }: { a: Analysis } = $props()

  let width = $state(600)
  const H = 210
  const M = { t: 14, r: 12, b: 24, l: 44 }
  const o = $derived(a.outlook)
  const noSkill = $derived(o.method === 'climatology' || o.skill <= 0)
  // Context: the last 9 months of the record, then the outlook.
  const past = $derived.by(() => {
    const out: { m: number; v: number | null }[] = []
    for (let m = a.current.m - 8; m <= a.current.m; m++) {
      const i = seriesIndex(a, m)
      out.push({ m, v: i >= 0 ? a.series.harmonized[i] : null })
    }
    return out
  })
  const allM = $derived([...past.map((p) => p.m), ...o.months])
  const x = $derived(linear([allM[0], allM[allM.length - 1]], [M.l + 10, width - M.r - 10]))
  const yMax = $derived(niceMax(Math.max(1, ...past.map((p) => p.v ?? 0), ...o.hi80.filter(Number.isFinite), ...allM.map((m) => a.climatology.median[m % 12]))))
  const y = $derived(linear([0, yMax], [H - M.b, M.t]))
  const pastPath = $derived(linePath(past.map((p) => (p.v == null ? null : [x(p.m), y(p.v)]))))
  const climPath = $derived(linePath(allM.map((m) => [x(m), y(a.climatology.median[m % 12])])))
  const statement = $derived(
    noSkill
      ? `No skill beyond climatology for this area (hindcast skill ${o.skill.toFixed(2)}): the outlook is the seasonal normal.`
      : `Persistence of the current anomaly adds modest skill over climatology (hindcast skill ${o.skill.toFixed(2)}, lag-1 ρ = ${o.rho.toFixed(2)}).`,
  )
</script>

<section class="outlook" aria-labelledby="outlook-h">
  <p class="eyebrow">06 · Outlook</p>
  <h2 id="outlook-h">Next {o.months.length} months</h2>
  <p class="lede">{statement}</p>

  <div class="cards">
    {#each o.months as m, i (m)}
      <div class="card">
        <span class="eyebrow">{monthShort(m)}</span>
        <strong class="num">{fmtNum(o.median[i])}</strong>
        <span class="small muted">80 %: <span class="num">{fmtNum(o.lo80[i])}–{fmtNum(o.hi80[i])}</span></span>
        <span class="small">{fmtRatio(o.climatology[i] > 0 ? o.median[i] / o.climatology[i] : null)} the normal of <span class="num">{fmtNum(o.climatology[i])}</span></span>
      </div>
    {/each}
  </div>

  <div class="chart" bind:clientWidth={width}>
    <svg {width} height={H} role="img" aria-label={`Outlook chart. ${statement} ${o.months.map((m, i) => `${monthShort(m)}: ${fmtNum(o.median[i])} (80 % ${fmtNum(o.lo80[i])} to ${fmtNum(o.hi80[i])}) vs normal ${fmtNum(o.climatology[i])}`).join('; ')}.`}>
      {#each niceTicks(0, yMax, 4) as v (v)}
        <line class="grid" x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} />
        <text class="tk" x={M.l - 6} y={y(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
      {/each}
      <rect class="future" x={(x(a.current.m) + x(o.months[0])) / 2} y={M.t} width={width - M.r - (x(a.current.m) + x(o.months[0])) / 2} height={H - M.t - M.b} />
      <text class="tk now" x={(x(a.current.m) + x(o.months[0])) / 2 + 6} y={M.t + 10}>outlook</text>
      <path class="clim" d={climPath} />
      <path class="past" d={pastPath} />
      {#each past as p (p.m)}{#if p.v != null}<circle class="pdot" cx={x(p.m)} cy={y(p.v)} r="3" />{/if}{/each}
      {#each o.months as m, i (m)}
        <line class="whisk" x1={x(m)} x2={x(m)} y1={y(o.lo80[i])} y2={y(o.hi80[i])} />
        <line class="cap" x1={x(m) - 6} x2={x(m) + 6} y1={y(o.lo80[i])} y2={y(o.lo80[i])} />
        <line class="cap" x1={x(m) - 6} x2={x(m) + 6} y1={y(o.hi80[i])} y2={y(o.hi80[i])} />
        <circle class="odot" cx={x(m)} cy={y(o.median[i])} r="5" />
      {/each}
      {#each allM as m (m)}<text class="tk" x={x(m)} y={H - 6} text-anchor="middle">{MONTHS_SHORT[m % 12]}</text>{/each}
    </svg>
  </div>
  <ul class="keys">
    <li><span class="sw past-sw"></span>Recent months</li>
    <li><span class="sw o-sw"></span>Outlook median, 80 % range</li>
    <li><span class="sw clim-sw"></span>Climatological median</li>
  </ul>
</section>

<style>
  .outlook { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); }
  .lede { color: var(--ink-2); max-width: 68ch; margin: 8px 0 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0; margin-bottom: 12px; }
  .card { display: grid; gap: 1px; padding: 0 14px; border-left: 1px solid var(--rule); }
  .card:first-child { border-left: 0; padding-left: 0; }
  .card strong { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.03em; }
  svg { display: block; overflow: hidden; }
  .grid { stroke: var(--rule); }
  .tk { font-family: var(--font-num); font-size: 10px; fill: var(--ink-3); }
  .future { fill: var(--surface-2); opacity: 0.6; }
  .clim { fill: none; stroke: var(--ink-3); stroke-width: 1.5; }
  .past { fill: none; stroke: var(--ink); stroke-width: 2; }
  .pdot { fill: var(--ink); stroke: var(--bg); stroke-width: 2; }
  .whisk, .cap { stroke: var(--accent); stroke-width: 2; stroke-linecap: round; }
  .odot { fill: var(--bg); stroke: var(--accent); stroke-width: 2.5; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; padding: 0; font-size: 0.74rem; color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 14px; height: 2px; }
  .past-sw { background: var(--ink); }
  .o-sw { background: var(--accent); height: 8px; width: 8px; border-radius: 50%; box-shadow: inset 0 0 0 2px var(--accent); background: var(--bg); }
  .clim-sw { background: var(--ink-3); }
</style>
