<script lang="ts">
  // "How are the satellites combined?" — the sensor error model and the fusion test (docs/METHOD.md sections 9, 11, 13;
  // Tables M7, M10, M11b). Global evidence from validation.json; every number is read from the file.
  import { onMount } from 'svelte'
  import { validation, f2, pct0, type FusionTest, type Pair } from '../validation.svelte'
  import { linear } from '../charts/scale'
  import Term from './Term.svelte'

  onMount(() => { validation.load() })

  const v = $derived(validation.data)
  const em = $derived(v?.error_model ?? null)
  const fu = $derived(v?.fusion ?? null)
  const closure = $derived(v?.closure ?? null)
  let width = $state(640)
  let showTable = $state(false)

  // ---- reliability by biome group: cell-scale noise relative to Poisson (1 = pure counting noise) ----
  const groups = $derived.by(() => {
    if (!em) return []
    const m = em.phi.terra_aqua, vi = em.phi.viirs_1sat
    if (!m || !vi) return []
    const names = Object.keys(m).filter((g) => g !== 'all' && vi[g])
    return [...names, 'all'].map((g) => ({ name: g === 'all' ? 'All land' : g, modis: m[g] as Pair, viirs: vi[g] as Pair }))
  })
  const stacked = $derived(width < 620)
  const labelW = $derived(stacked ? 128 : 190)
  /** Short landscape names for narrow screens (full names stay in the table and tooltips). */
  const SHORT: Record<string, string> = {
    'Tropical savannas and grasslands': 'Tropical savannas', 'Flooded and montane grasslands': 'Flooded, montane',
    'Deserts and xeric shrublands': 'Deserts', 'Mangroves and unclassified': 'Mangroves, other',
    'Boreal forest and tundra': 'Boreal, tundra', 'Temperate grasslands': 'Temperate grass.',
  }
  const short = (n: string) => (stacked ? SHORT[n] ?? n : n)
  /** Plot width of one panel (the label column sits left of the first panel, or of each panel when stacked). */
  const panelW = $derived(stacked ? width - labelW : (width - labelW - 24) / 2)
  const rowH = 22
  const PM = { t: 22, b: 22, r: 12, l: 8 }
  const xMax = $derived(Math.max(2, Math.ceil(Math.max(0, ...groups.flatMap((g) => [...g.modis, ...g.viirs])) * 2) / 2))
  const x = $derived(linear([0, xMax], [PM.l, panelW - PM.r]))
  const ticks = $derived(Array.from({ length: Math.floor(xMax / 0.5) + 1 }, (_, i) => i * 0.5).filter((t) => xMax <= 3 || t % 1 === 0))
  const ph = $derived(PM.t + groups.length * rowH + PM.b)
  const DN = [{ i: 0, label: 'Day' }, { i: 1, label: 'Night' }] as const

  // ---- the non-circular test: log error against Terra, which no candidate contains ----
  const CANDS: [keyof FusionTest, string][] = [
    ['switch_aqua_only', 'Aqua alone (the old switch)'], ['viirs_only', 'VIIRS alone'], ['fused', 'Fused'], ['equal_weights', 'Plain average'],
  ]
  const err = (t: FusionTest, k: keyof FusionTest) => (t[k] as { log_rmse: number }).log_rmse
  const testRows = $derived(fu ? [
    { label: '1° cells', t: fu.non_circular_terra_reference.cell1deg_month },
    { label: 'Whole strata', t: fu.non_circular_terra_reference.stratum_month },
  ] : [])
  const best = (t: FusionTest) => Math.min(...CANDS.map(([k]) => err(t, k)))
  const cell = $derived(fu?.non_circular_terra_reference.cell1deg_month ?? null)
  const strat = $derived(fu?.non_circular_terra_reference.stratum_month ?? null)
  const testYears = $derived(fu?.non_circular_terra_reference.years ?? [2012, 2019])
  const verdict = $derived.by(() => {
    if (!cell || !strat) return ''
    const f = err(cell, 'fused'), aq = err(cell, 'switch_aqua_only'), vi = err(cell, 'viirs_only'), eq = err(cell, 'equal_weights')
    const beatsBoth = f < aq && f < vi
    const first = beatsBoth
      ? `At 1° scale the fused record (${f.toFixed(3)}) beats Aqua alone (${aq.toFixed(3)}) and VIIRS alone (${vi.toFixed(3)})`
      : `At 1° scale the fused record (${f.toFixed(3)}) does not beat both single streams (Aqua ${aq.toFixed(3)}, VIIRS ${vi.toFixed(3)})`
    const avg = eq <= f
      ? `, but a plain average does as well (${eq.toFixed(3)}): a gain of the measured weights over a simple average is not demonstrated.`
      : `, and a plain average is slightly worse (${eq.toFixed(3)}).`
    const sBest = CANDS.reduce((b, c) => (err(strat, c[0]) < err(strat, b[0]) ? c : b))
    const second = sBest[0] === 'fused' ? '' : ` For whole strata, ${sBest[1].toLowerCase().replace(' (the old switch)', '')} is best (${err(strat, sBest[0]).toFixed(3)}).`
    return first + avg + second
  })
  const era = $derived(fu?.modis_weight_by_era ?? null)
  const eraKeys = $derived(era ? Object.keys(era).filter((k) => k !== 'global_by_year' && /^\d{4}/.test(k)).sort() : [])
  const eraFirst = $derived(eraKeys.length ? { k: eraKeys[0], w: era![eraKeys[0]].cell1deg_median } : null)
  const eraLast = $derived(eraKeys.length > 1 ? { k: eraKeys[eraKeys.length - 1], w: era![eraKeys[eraKeys.length - 1]].cell1deg_median } : null)
  const kappaDay = $derived(em?.common_mode?.day?.kappa_aqua_viirs ?? null)
  const allV = $derived(em ? [em.phi.viirs_1sat?.all?.[0], em.phi.viirs_2sat?.all?.[0], em.phi.viirs_3sat?.all?.[0]] : [])
</script>

{#if em && fu && groups.length && cell && strat}
  <section class="ev" aria-labelledby="fusion-h">
    <h3 id="fusion-h" class="sub-title">How are the satellites combined?</h3>
    <p class="scope small muted">Global evidence, the same for every area you select.</p>
    <p class="take">
      Where both fly, each month is a weighted average of MODIS and calibrated VIIRS: <Term id="fusion">sensor fusion</Term>.
      {#if eraFirst && eraLast}Across 1° cells MODIS typically gets <span class="num">{f2(eraFirst.w)}</span> of the weight in {eraFirst.k.replace('-', '–')}, falling to <span class="num">{f2(eraLast.w)}</span> in {eraLast.k.replace('-', '–')} as its orbit drifts.{/if}
    </p>
    <p class="body">
      The weights come from each stream’s measured noise. It is estimated by <Term id="triplecoll">triple collocation</Term>: Terra, Aqua and VIIRS watch the same fires, and how much each disagrees with the other two reveals its own error.
      Aqua and VIIRS pass at the same early-afternoon hour and so share part of their error (<Term id="commonmode">common-mode error</Term>{#if kappaDay != null}; correlation <span class="num">{f2(kappaDay)}</span> by day{/if}), which the fused range allows for.
    </p>

    <figure class="rel" bind:clientWidth={width}>
      <figcaption class="pt"><strong>Noise of each stream, by landscape</strong> <span class="muted">relative to pure counting noise (1 = Poisson); lower is more reliable</span></figcaption>
      <div class="rel-grid" class:stacked>
        {#each DN as dn (dn.i)}
          {@const ox = stacked || dn.i === 0 ? labelW : 0}
          {@const showLabels = stacked || dn.i === 0}
          <svg width={stacked ? width : panelW + (dn.i === 0 ? labelW : 0)} height={ph} role="img"
            aria-label={`${dn.label}: noise relative to Poisson. ${groups.map((g) => `${g.name}: MODIS ${f2(g.modis[dn.i])}, VIIRS ${f2(g.viirs[dn.i])}`).join('; ')}.`}>
            <text class="ptitle" x={ox + PM.l} y={12}>{dn.label}</text>
            {#each ticks as t (t)}
              <line class="grid" class:one={t === 1} x1={ox + x(t)} x2={ox + x(t)} y1={PM.t - 4} y2={ph - PM.b} />
              <text class="tk" x={ox + x(t)} y={ph - 6} text-anchor="middle">{t}</text>
            {/each}
            {#each groups as g, i (g.name)}
              {@const cy = PM.t + i * rowH + rowH / 2}
              {@const a = g.modis[dn.i]}
              {@const b = g.viirs[dn.i]}
              {#if showLabels}<text class="gl" class:all={g.name === 'All land'} x={labelW - 8} y={cy} dy="0.32em" text-anchor="end">{short(g.name)}</text>{/if}
              <line class="conn" x1={ox + x(Math.min(a, b))} x2={ox + x(Math.max(a, b))} y1={cy} y2={cy} />
              <circle class="dot modis" cx={ox + x(a)} cy={cy} r="4.5"><title>{g.name}, {dn.label.toLowerCase()}: MODIS {f2(a)}</title></circle>
              <circle class="dot viirs" cx={ox + x(b)} cy={cy} r="4.5"><title>{g.name}, {dn.label.toLowerCase()}: VIIRS {f2(b)}</title></circle>
            {/each}
          </svg>
        {/each}
      </div>
      <div class="foot">
        <ul class="keys" aria-label="Legend">
          <li><span class="dot-k modis"></span>MODIS (Terra + Aqua)</li>
          <li><span class="dot-k viirs"></span>VIIRS, one satellite{#if allV[1] != null && allV[2] != null}&nbsp;(with two or three satellites lower still: all land, day {allV.map((x) => (x == null ? '—' : f2(x))).join(' → ')}){/if}</li>
        </ul>
        <button class="btn small" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Hide table' : 'View as table'}</button>
      </div>
      {#if showTable}
        <div class="tw">
          <table class="dt">
            <caption class="small muted">Cell-scale noise relative to Poisson, day / night (2012–2019 estimates).</caption>
            <thead><tr><th scope="col">Landscape</th><th scope="col">MODIS day</th><th scope="col">VIIRS day</th><th scope="col">MODIS night</th><th scope="col">VIIRS night</th></tr></thead>
            <tbody>
              {#each groups as g (g.name)}
                <tr><th scope="row">{g.name}</th><td class="num">{f2(g.modis[0])}</td><td class="num">{f2(g.viirs[0])}</td><td class="num">{f2(g.modis[1])}</td><td class="num">{f2(g.viirs[1])}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </figure>

    <h4 class="tt-h">Does fusion help? A test against a satellite it never saw</h4>
    <p class="body">Aqua is fused with VIIRS and every candidate is scored against Terra, which none of them contains ({testYears[0]}–{testYears[1]}; log error, lower is better).</p>
    <div class="tw">
      <table class="dt test">
        <thead><tr><th scope="col">Scale</th>{#each CANDS as [k, l] (k)}<th scope="col">{l}</th>{/each}</tr></thead>
        <tbody>
          {#each testRows as r (r.label)}
            <tr>
              <th scope="row">{r.label}</th>
              {#each CANDS as [k] (k)}
                {@const e = err(r.t, k)}
                <td class="num" class:best={e === best(r.t)}>{e.toFixed(3)}{#if e === best(r.t)}<span class="sr-only"> (best)</span>{/if}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="body verdict">{verdict}</p>
    <p class="limit"><strong>Limitation.</strong> The weights are only as good as the error model, and taken at face value its ranges are too narrow: its nominal 80 % range caught Terra <span class="num">{pct0(cell.model_cov80_vs_terra_H5)}</span> of the time at 1° scale. That is why every range on this page is recalibrated (below). The model also understates how uncertain the VIIRS conversion is where there is little fire.</p>
    {#if closure}
      <p class="evidence"><strong>Calibration closes.</strong> Converting NOAA-20 to MODIS units through S-NPP, or fitting it to MODIS directly, gives factors that differ by <span class="num">{((Math.exp(closure.weighted_rms_log) - 1) * 100).toFixed(1)} %</span> (RMS), and both predict 2020–2021 equally well (log error <span class="num">{closure.oos_2020_2021.chain.log_rmse.toFixed(3)}</span> and <span class="num">{closure.oos_2020_2021.direct.log_rmse.toFixed(3)}</span>).</p>
    {/if}
  </section>
{/if}

<style>
  .ev { padding: 22px 0 24px; }
  .scope { margin: 4px 0 0; }
  .take { font-size: var(--fs-lg); line-height: 1.45; max-width: var(--measure); margin: 10px 0 6px; }
  .body, .limit, .evidence { color: var(--ink-2); max-width: var(--measure); margin: 8px 0 0; }
  .limit strong, .evidence strong { color: var(--ink); }
  figure { margin: 14px 0 0; }
  .pt { font-size: var(--fs-sm); margin-bottom: 4px; }
  .rel-grid { display: flex; gap: 24px; }
  .rel-grid.stacked { flex-direction: column; gap: 6px; }
  svg { display: block; overflow: visible; }
  .ptitle { font-size: var(--fs-sm); fill: var(--ink-2); font-weight: 600; }
  .gl { font-size: var(--fs-xs); fill: var(--ink-2); }
  .gl.all { fill: var(--ink); font-weight: 600; }
  .tk { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .grid.one { stroke: var(--ink-3); stroke-dasharray: 3 3; }
  .conn { stroke: var(--rule-strong); stroke-width: 2; }
  .dot { stroke: var(--surface); stroke-width: 2; }
  .dot.modis { fill: var(--s-modis); }
  .dot.viirs { fill: var(--s-viirs); }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .dot-k { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot-k.modis { background: var(--s-modis); }
  .dot-k.viirs { background: var(--s-viirs); }
  .tt-h { font-size: var(--fs-base); margin: 22px 0 0; }
  .tw { overflow-x: auto; margin-top: 8px; }
  .dt { border-collapse: collapse; font-size: var(--fs-sm); }
  .dt th, .dt td { padding: 4px 10px; border-bottom: 1px solid var(--rule); text-align: right; font-weight: 400; }
  .dt th[scope='row'], .dt thead th:first-child { text-align: left; }
  .dt thead th { color: var(--ink-3); vertical-align: bottom; }
  .test thead th { max-width: 9em; }
  .best { font-weight: 600; color: var(--ink); background: var(--surface-2); }
  .verdict { color: var(--ink); }
  .small { font-size: var(--fs-sm); }
</style>
