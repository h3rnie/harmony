<script lang="ts">
  import { onMount } from 'svelte'
  import { session } from '../session.svelte'
  import { validation, f2, signedPct } from '../validation.svelte'
  import { DATA_BASE } from '../config'
  import { GLOSSARY } from './glossary'

  /** Inside the "How we know" chapter the title is a subsection (h3); on the landing page it stands alone (h2). */
  let { chapter = false }: { chapter?: boolean } = $props()

  let open = $state(false)

  onMount(() => {
    const openIt = () => (open = true)
    addEventListener('harmony:open-method', openIt)
    validation.load()
    return () => removeEventListener('harmony:open-method', openIt)
  })

  // A curated view of validation.json: a few labelled tables with the key numbers (the whole file is linked).
  const v = $derived(validation.data)
  const skill = $derived.by(() => {
    const L = v?.loyo, N = v?.loyo_naive_global_ratio
    if (!L) return []
    return [
      { label: '1° cell-months', o: L.cell1deg_month?.overall, naive: N?.cell1deg_month?.overall },
      { label: 'Stratum-months', o: L.stratum_month?.overall, naive: N?.stratum_month?.overall },
    ].filter((r) => r.o)
  })
  const pett = $derived.by(() => {
    const p = v?.pettitt
    if (!p) return []
    return [
      { label: 'VIIRS starts, 2012', h: p.at_viirs_start?.harmonized, n: p.at_viirs_start?.naive_viirs_from_2012 ?? p.at_viirs_start?.naive },
      { label: 'Old switch to VIIRS, 2023', h: p.harmonized, n: p.naive_switch_2023 ?? p.naive },
    ].filter((r) => r.h && r.n)
  })
  const fmtP = (p: number) => (p < 0.0001 ? '< 0.0001' : p.toFixed(2))
  const pct = (x: number | undefined) => (x == null ? '—' : `${Math.round(x * 100)} %`)
  const ratios = $derived(v?.ratio_by_year ?? [])
  const oot = $derived(v?.out_of_time?.by_year ?? [])
  const validationUrl = `${DATA_BASE}/validation.json`
  const defaultSwitch = $derived(session.meta ? Math.floor(session.meta.default_switch_m / 12) + 2000 : 2023)
</script>

<section class="method" id="method" aria-labelledby="method-h">
  <svelte:element this={chapter ? 'h3' : 'h2'} id="method-h" class="sub-title">
    <button class="disclosure" aria-expanded={open} aria-controls="method-body" onclick={() => (open = !open)}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class:open><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
      How the record is built, validation and glossary
    </button>
  </svelte:element>
  {#if open}
    <div id="method-body" class="body">
      <p class="unit"><strong>The unit — AFCD-M.</strong> One <em>active-fire cell-day</em> is a distinct 0.0125° sub-cell, local-solar day and overpass (day or night) with at least one accepted detection. Counting cell-days rather than pixels collapses the many 375 m VIIRS pixels of one fire toward MODIS-like units; VIIRS cell-days are then scaled to <em>MODIS-equivalent</em> (the “-M”).</p>
      <ol class="steps">
        <li><strong>Filter.</strong> MODIS confidence ≥ 30, VIIRS nominal/high, vegetation fires only; a static-source mask removes gas flares, volcanoes and industry. Science-quality rows supersede near-real-time; NRT months are flagged provisional.</li>
        <li><strong>Common support.</strong> Detections become active-fire cell-days and are summed monthly into 0.05° cells aligned with the MODIS climate grid.</li>
        <li><strong>Streams.</strong> MODIS Terra + Aqua; a Terra-only bridge for Nov 2000 – Jun 2002; VIIRS as the per-day mean over operating satellites (NOAA-20/21 first scaled to S-NPP; S-NPP ended on 2 Nov 2026). Satellite outages are handled from a daily availability table.</li>
        <li><strong>Strata.</strong> Biome × realm (RESOLVE Ecoregions 2017), so calibration respects how differently fires look in savanna, grassland, tropical forest and boreal forest.</li>
        <li><strong>Calibrate once, then freeze.</strong> A multiplicative VIIRS→MODIS ratio per stratum × day/night × month-of-year, fit on 2012–2021, with per-cell empirical-Bayes shrinkage.</li>
        <li><strong>Measure each sensor’s noise.</strong> Triple collocation of Terra, Aqua and VIIRS gives every stream an error model per landscape, day and night, including the part of the error Aqua and VIIRS share because they pass at the same hour.</li>
        <li><strong>Correct MODIS for its drifting orbit.</strong> From 2020, MODIS is divided by how far it has moved from a fixed-overpass VIIRS reference, by biome and year. Half of that correction counts as uncertain, because a real change in the hour fires burn looks the same.</li>
        <li><strong>Fuse.</strong> Each month is a weighted average of every stream flying, each weighted by its measured reliability: MODIS alone before 2012, a blend while both fly (MODIS counting for less as it drifts), VIIRS alone after MODIS ends. The old hard switch (default {defaultSwitch}) stays available as a comparison.</li>
        <li><strong>Calibrated ranges.</strong> Every month gets an 80 % and a 95 % range, sized by conformal calibration on held-out years for each landscape and amount of fire, and checked on later years it never saw.</li>
        <li><strong>Choose the unit.</strong> The record reads in MODIS-equivalent cell-days (AFCD-M) by default, or in VIIRS-equivalent (AFCD-V) under “Years and normal”; ratios, percentiles and ranks within a month do not change.</li>
      </ol>

      <h3>Validation</h3>
      {#if v}
        <p class="small muted">The fusion, orbit-drift and range tests are shown with charts above. Key numbers of the calibration itself:</p>
        {#if skill.length}
          <div class="vt-wrap"><table class="vt">
            <caption>Calibration skill, leave-one-year-out 2012–2021: each year predicted from VIIRS with factors fitted without it, scored against MODIS</caption>
            <thead><tr><th scope="col">Scale</th><th scope="col">r (log)</th><th scope="col">log error</th><th scope="col">log error, one global ratio</th><th scope="col">peak month ±1</th><th scope="col">anomaly sign agrees</th></tr></thead>
            <tbody>
              {#each skill as r (r.label)}
                <tr><th scope="row">{r.label}</th><td class="num">{r.o?.r_log1p?.toFixed(3) ?? '—'}</td><td class="num">{r.o?.log_rmse?.toFixed(3) ?? '—'}</td><td class="num">{r.naive?.log_rmse?.toFixed(3) ?? '—'}</td><td class="num">{pct(r.o?.peak_within1)}</td><td class="num">{pct(r.o?.anomaly_sign_agree)}</td></tr>
              {/each}
            </tbody>
          </table></div>
        {/if}
        {#if pett.length}
          <div class="vt-wrap"><table class="vt">
            <caption>Is there a step at the sensor change? Pettitt change-point test on the monthly global total; a small p at the event month means a seam</caption>
            <thead><tr><th scope="col">Event</th><th scope="col">Raw counts: p, step (month found)</th><th scope="col">Harmonized: p, step (month found)</th></tr></thead>
            <tbody>
              {#each pett as r (r.label)}
                <tr><th scope="row">{r.label}</th><td class="num">{fmtP(r.n!.p)}, ×{Math.exp(r.n!.step_log).toFixed(2)} ({r.n!.change_month})</td><td class="num">{fmtP(r.h!.p)}, ×{Math.exp(r.h!.step_log).toFixed(2)} ({r.h!.change_month})</td></tr>
              {/each}
            </tbody>
          </table></div>
        {/if}
        {#if ratios.length}
          <div class="vt-wrap"><table class="vt">
            <caption>VIIRS ÷ MODIS by year, globally: raw detection counts against the harmonized record (1 = seamless; the first and last years are partial)</caption>
            <thead><tr><th scope="col">Year</th>{#each ratios as r (r.year)}<th scope="col">{r.year}</th>{/each}</tr></thead>
            <tbody>
              <tr><th scope="row">Raw counts</th>{#each ratios as r (r.year)}<td class="num">{r.count_ratio.toFixed(1)}</td>{/each}</tr>
              <tr><th scope="row">Harmonized</th>{#each ratios as r (r.year)}<td class="num">{f2(r.harmonized_ratio)}</td>{/each}</tr>
            </tbody>
          </table></div>
        {/if}
        {#if oot.length}
          <div class="vt-wrap"><table class="vt">
            <caption>Frozen calibration after its fit window, against MODIS: the bias grows from 2025 as MODIS drifts (see “Has MODIS itself changed?”); * partial year</caption>
            <thead><tr><th scope="col">Year</th>{#each oot as r (r.year)}<th scope="col">{r.year}{r.months && r.months < 12 ? '*' : ''}</th>{/each}</tr></thead>
            <tbody><tr><th scope="row">Bias</th>{#each oot as r (r.year)}<td class="num">{signedPct(r.bias_pct)}</td>{/each}</tr></tbody>
          </table></div>
        {/if}
        <p class="small"><a href={validationUrl} download="harmony-validation.json">Download the full validation file</a> <span class="muted">(validation.json: every test in the method document)</span></p>
      {:else}
        <p class="muted small">Validation results appear here once the pipeline publishes <code>validation.json</code>{validation.error ? ` (${validation.error})` : ''}.</p>
      {/if}

      <h3>Glossary</h3>
      <dl class="gloss">
        {#each Object.values(GLOSSARY) as g (g.term)}<div><dt>{g.term}</dt><dd>{g.text}</dd></div>{/each}
      </dl>

      <h3>Caveats</h3>
      <ul class="caveats">
        <li>Counts measure <strong>fire detections, not burned area</strong> or emissions.</li>
        <li>Cloud cover and overpass sampling are not corrected; smoke and cloud can hide fires.</li>
        <li>MODIS orbits have drifted since about 2021. Harmony measures and corrects the drift against VIIRS, but cannot tell it apart from a real change in the hour fires burn.</li>
        <li>Suomi NPP data ended on 2 Nov 2026; NOAA-20 and NOAA-21 carry VIIRS from then on.</li>
        <li>Recent months are <strong>provisional</strong> (near-real-time) and may change when science-quality data arrive.</li>
        <li>Areas with no MODIS fire history are shrunk toward their stratum’s calibration.</li>
      </ul>
      <p class="small muted">
        {#if session.isMock}This session runs on synthetic demo data.{:else}Every number on the page is computed in your browser by Harmony’s Rust kernel (compiled to WebAssembly) from the published data tiles.{/if}
      </p>
      {#if session.meta?.sources?.length}
        <h3>Sources</h3>
        <ul class="caveats">
          {#each session.meta.sources as s (s.name)}<li>{s.name} — {s.years} ({s.quality})</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .method { padding: 22px 0 24px; border-bottom: 1px solid var(--rule); }
  .disclosure { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: var(--ink); cursor: pointer; }
  .disclosure svg { transition: transform 0.2s; }
  .disclosure svg.open { transform: rotate(90deg); }
  .body { margin-top: 12px; max-width: var(--measure); }
  .gloss { display: grid; gap: 8px; margin: 0; }
  .gloss dt { font-weight: 600; color: var(--ink); }
  .gloss dd { margin: 0; color: var(--ink-2); }
  .unit { color: var(--ink-2); }
  .steps { padding-left: 1.3em; display: grid; gap: 8px; color: var(--ink-2); }
  .steps strong, .unit strong { color: var(--ink); }
  .body h3 { margin: 18px 0 8px; font-size: var(--fs-base); }
  .vt-wrap { overflow-x: auto; margin: 12px 0 4px; }
  .vt { border-collapse: collapse; font-size: var(--fs-sm); }
  .vt caption { text-align: left; color: var(--ink-2); padding-bottom: 4px; caption-side: top; }
  .vt th, .vt td { text-align: right; padding: 3px 8px; border-bottom: 1px solid var(--rule); font-weight: 400; white-space: nowrap; }
  .vt th[scope='row'], .vt thead th:first-child { text-align: left; color: var(--ink-2); }
  .vt thead th { color: var(--ink-3); }
  .caveats { color: var(--ink-2); padding-left: 1.2em; display: grid; gap: 4px; }
</style>
