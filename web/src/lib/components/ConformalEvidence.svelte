<script lang="ts">
  // "How sure are the ranges?" — conformal intervals checked out of time (docs/METHOD.md section 12, Table M9).
  // Global evidence from validation.json `conformal`; every number is read from the file.
  import { onMount } from 'svelte'
  import { validation, pct0, SIZE_CLASSES } from '../validation.svelte'
  import { linear } from '../charts/scale'
  import Term from './Term.svelte'

  onMount(() => { validation.load() })

  const c = $derived(validation.data?.conformal ?? null)
  let width = $state(640)
  let showTable = $state(false)

  const oot = $derived(c?.out_of_time ?? null)
  const rows = $derived(
    oot ? SIZE_CLASSES.filter(([k]) => oot.vs_modis_raw.all[k]).map(([k, label]) => ({ k, label, cov: oot.vs_modis_raw.all[k], dc: oot.vs_modis_drift_corrected?.all[k] ?? null })) : [],
  )
  const newCov = $derived(rows.map((r) => r.cov.cov80))
  const oldCov = $derived(rows.map((r) => r.cov.legacy_cov80))
  const rng = (v: number[]) => `${Math.round(Math.min(...v) * 100)}–${Math.round(Math.max(...v) * 100)} %`
  // "about three quarters" when the activity-weighted coverage of the classes with fire (5 or more) is near 0.75.
  const typical = $derived.by(() => {
    const act = rows.filter((r) => r.k !== 'H<5')
    const n = act.reduce((s, r) => s + r.cov.n, 0)
    const v = n ? act.reduce((s, r) => s + r.cov.n * r.cov.cov80, 0) / n : null
    if (v == null) return null
    return v >= 0.72 && v <= 0.78 ? 'about three quarters' : `about ${Math.round(v * 100)} %`
  })
  const slip = $derived.by(() => {
    const act = rows.filter((r) => r.k !== 'H<5').map((r) => (0.8 - r.cov.cov80) * 100)
    return act.length ? [Math.max(0, Math.round(Math.min(...act))), Math.round(Math.max(...act))] : null
  })

  const M = { t: 26, r: 16, b: 26, l: 104 }
  const rowH = 30
  const H = $derived(M.t + rows.length * rowH + M.b)
  const xLo = $derived(Math.max(0, Math.floor(Math.min(0.7, ...newCov, ...oldCov) * 10) / 10))
  const x = $derived(linear([xLo, 1], [M.l, width - M.r]))
  const ticks = $derived(Array.from({ length: Math.round((1 - xLo) * 10) + 1 }, (_, i) => +(xLo + i * 0.1).toFixed(1)))
  /** Label every tick on wide screens; on narrow ones only the even tenths (always including 80 and 100). */
  const labelled = (t: number) => width > 480 || Math.round(t * 10) % 2 === 0
</script>

{#if c && oot && rows.length}
  <section class="ev" aria-labelledby="conformal-h">
    <h3 id="conformal-h" class="sub-title">How sure are the ranges?</h3>
    <p class="scope small muted">Global evidence, the same for every area you select.</p>
    <p class="take">
      Ranges are calibrated on held-out years; out of sample they cover {typical} of months at a nominal 80 %.
    </p>
    <p class="body">
      Every month’s likely range is sized by <Term id="conformal">conformal calibration</Term>: past predictions were checked against what MODIS actually saw in years left out of the fit, separately for each landscape and amount of fire.
      Tested on {oot.years[0]}–{oot.years[1]}, years the calibration never saw, the new ranges’ <Term id="coverage">coverage</Term> was <span class="num">{rng(newCov)}</span> by size class; the old ranges ranged <span class="num">{rng(oldCov)}</span>.
    </p>

    <figure bind:clientWidth={width}>
      <figcaption class="pt"><strong>Share of months inside the 80 % range</strong> <span class="muted">{oot.years[0]}–{oot.years[1]}, by activity in the month (cell-days)</span></figcaption>
      <svg {width} height={H} role="img" aria-label={`Out-of-time coverage of the 80 % range by activity size. ${rows.map((r) => `${r.label}: new ${pct0(r.cov.cov80)}, old ${pct0(r.cov.legacy_cov80)}`).join('; ')}. Nominal 80 %.`}>
        {#each ticks as t (t)}
          <line class="grid" x1={x(t)} x2={x(t)} y1={M.t - 4} y2={H - M.b} />
          {#if labelled(t)}<text class="tk" x={x(t)} y={H - 8} text-anchor="middle">{Math.round(t * 100)} %</text>{/if}
        {/each}
        <line class="nominal" x1={x(0.8)} x2={x(0.8)} y1={M.t - 14} y2={H - M.b} />
        <text class="nl" x={x(0.8)} y={M.t - 17} text-anchor="middle">nominal 80 %</text>
        {#each rows as r, i (r.k)}
          {@const cy = M.t + i * rowH + rowH / 2}
          <text class="rl" x={M.l - 10} y={cy} dy="0.32em" text-anchor="end">{r.label}</text>
          <line class="conn" x1={x(Math.min(r.cov.cov80, r.cov.legacy_cov80))} x2={x(Math.max(r.cov.cov80, r.cov.legacy_cov80))} y1={cy} y2={cy} />
          <circle class="old" cx={x(r.cov.legacy_cov80)} cy={cy} r="4.5"><title>{r.label}: old ranges {pct0(r.cov.legacy_cov80)}</title></circle>
          <circle class="new" cx={x(r.cov.cov80)} cy={cy} r="5"><title>{r.label}: new ranges {pct0(r.cov.cov80)}</title></circle>
        {/each}
      </svg>
      <div class="foot">
        <ul class="keys" aria-label="Legend">
          <li><span class="k new"></span>new, calibrated ranges</li>
          <li><span class="k old"></span>old ranges (one inflation factor)</li>
        </ul>
        <button class="btn small" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Hide table' : 'View as table'}</button>
      </div>
      {#if showTable}
        <div class="tw">
          <table class="dt">
            <caption class="small muted">Coverage of observed MODIS (Terra + Aqua) by the 80 % and 95 % ranges, {oot.years[0]}–{oot.years[1]}, all supports pooled.</caption>
            <thead><tr><th scope="col">Cell-days in the month</th><th scope="col">Unit-months</th><th scope="col">New 80 %</th><th scope="col">New 95 %</th><th scope="col">New 80 %, drift-corrected MODIS</th><th scope="col">Old 80 %</th><th scope="col">Old 95 %</th></tr></thead>
            <tbody>
              {#each rows as r (r.k)}
                <tr><th scope="row">{r.label}</th><td class="num">{r.cov.n.toLocaleString('en-US')}</td><td class="num">{pct0(r.cov.cov80)}</td><td class="num">{pct0(r.cov.cov95)}</td><td class="num">{r.dc ? pct0(r.dc.cov80) : '—'}</td><td class="num">{pct0(r.cov.legacy_cov80)}</td><td class="num">{pct0(r.cov.legacy_cov95)}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </figure>

    <p class="limit"><strong>Measured, not guaranteed.</strong> In the calibration years the ranges hold at 80 % by construction; later they {#if slip}fall short by {slip[0]}–{slip[1]} points where there is fire, more for busier months,{/if} because fire months are not independent and the test years contain MODIS drift. The ranges say where MODIS would have landed, so they include MODIS’s own noise.</p>
  </section>
{/if}

<style>
  .ev { padding: 22px 0 24px; }
  .scope { margin: 4px 0 0; }
  .take { font-size: var(--fs-lg); line-height: 1.45; max-width: var(--measure); margin: 10px 0 6px; }
  .body, .limit { color: var(--ink-2); max-width: var(--measure); margin: 8px 0 0; }
  .limit strong { color: var(--ink); }
  figure { margin: 14px 0 0; }
  .pt { font-size: var(--fs-sm); margin-bottom: 4px; }
  svg { display: block; overflow: visible; }
  .tk { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .rl, .nl { font-size: var(--fs-xs); fill: var(--ink-2); }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .nominal { stroke: var(--ink-3); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .conn { stroke: var(--rule-strong); stroke-width: 2; }
  .new { fill: var(--s-harm); stroke: var(--surface); stroke-width: 2; }
  .old { fill: var(--surface); stroke: var(--ink-3); stroke-width: 1.5; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .k { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .k.new { background: var(--s-harm); }
  .k.old { border: 1.5px solid var(--ink-3); }
  .tw { overflow-x: auto; margin-top: 8px; }
  .dt { border-collapse: collapse; font-size: var(--fs-sm); }
  .dt th, .dt td { padding: 4px 10px; border-bottom: 1px solid var(--rule); text-align: right; font-weight: 400; }
  .dt th[scope='row'], .dt thead th:first-child { text-align: left; }
  .dt thead th { color: var(--ink-3); vertical-align: bottom; }
  .small { font-size: var(--fs-sm); }
</style>
