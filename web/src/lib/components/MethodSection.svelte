<script lang="ts">
  import { onMount } from 'svelte'
  import { loadValidation } from '../data/tileReader'
  import { session } from '../session.svelte'

  let validation = $state<unknown>(null)
  let vError = $state<string | null>(null)
  let open = $state(false)

  onMount(() => {
    const openIt = () => (open = true)
    addEventListener('harmony:open-method', openIt)
    loadValidation().then((v) => (validation = v)).catch((e) => (vError = (e as Error).message))
    return () => removeEventListener('harmony:open-method', openIt)
  })

  // Render unknown JSON defensively: scalars as key/value rows, nested objects as sub-tables (depth-limited).
  type Row = { key: string; value: string; depth: number }
  function flatten(v: unknown, depth = 0, prefix = '', out: Row[] = []): Row[] {
    if (out.length > 400) return out
    if (v == null || typeof v !== 'object') {
      out.push({ key: prefix, value: fmt(v), depth })
      return out
    }
    if (Array.isArray(v)) {
      if (v.every((x) => x == null || typeof x !== 'object')) {
        out.push({ key: prefix, value: v.slice(0, 24).map(fmt).join(', ') + (v.length > 24 ? ` … (${v.length})` : ''), depth })
        return out
      }
      if (prefix) out.push({ key: prefix, value: `${v.length} items`, depth })
      v.slice(0, 40).forEach((x, i) => flatten(x, depth + 1, `${i + 1}`, out))
      return out
    }
    if (prefix) out.push({ key: prefix, value: '', depth })
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? depth + 1 : depth, k, out)
    return out
  }
  function fmt(v: unknown): string {
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : Math.abs(v) < 0.01 || Math.abs(v) >= 1e5 ? v.toExponential(2) : v.toFixed(3)
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    return v == null ? '—' : String(v)
  }
  // Known headline fields, if the pipeline provides them (any of several plausible names).
  function pick(obj: unknown, paths: string[]): unknown {
    for (const p of paths) {
      let cur: unknown = obj
      for (const k of p.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined
      if (typeof cur === 'number') return cur
    }
    return undefined
  }
  const headline = $derived(validation ? [
    ['Leave-one-year-out r (log, 1° cell-month)', pick(validation, ['loyo.cell1deg_month.overall.r_log1p', 'loyo.overall.r', 'loyo.r'])],
    ['LOYO log-RMSE', pick(validation, ['loyo.cell1deg_month.overall.log_rmse', 'loyo.overall.log_rmse', 'loyo.log_rmse'])],
    ['Peak month within ±1', pick(validation, ['loyo.cell1deg_month.overall.peak_within1'])],
    ['Anomaly sign agreement', pick(validation, ['loyo.cell1deg_month.overall.anomaly_sign_agree'])],
    ['80 % interval coverage', pick(validation, ['interval_coverage_loyo_1deg.H_5_inf.cov80', 'coverage.80'])],
    ['95 % interval coverage', pick(validation, ['interval_coverage_loyo_1deg.H_5_inf.cov95', 'coverage.95'])],
    ['Step at switch, p (harmonized)', pick(validation, ['pettitt.harmonized.p'])],
    ['Step at switch, p (naive)', pick(validation, ['pettitt.naive.p'])],
  ].filter(([, v]) => v !== undefined) as [string, number][] : [])
  const rows = $derived(validation ? flatten(validation) : [])
</script>

<section class="method" id="method" aria-labelledby="method-h">
  <p class="eyebrow">09 · Method</p>
  <h2 id="method-h">
    <button class="disclosure" aria-expanded={open} aria-controls="method-body" onclick={() => (open = !open)}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class:open><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
      How the record is harmonized
    </button>
  </h2>
  {#if open}
    <div id="method-body" class="body">
      <p class="unit"><strong>The unit — AFCD-M.</strong> One <em>active-fire cell-day</em> is a distinct 0.0125° sub-cell, local-solar day and overpass (day or night) with at least one accepted detection. Counting cell-days rather than pixels collapses the many 375 m VIIRS pixels of one fire toward MODIS-like units; VIIRS cell-days are then scaled to <em>MODIS-equivalent</em> (the “-M”).</p>
      <ol class="steps">
        <li><strong>Filter.</strong> MODIS confidence ≥ 30, VIIRS nominal/high, vegetation fires only; a static-source mask removes gas flares, volcanoes and industry. Science-quality rows supersede near-real-time; NRT months are flagged provisional.</li>
        <li><strong>Common support.</strong> Detections become active-fire cell-days and are summed monthly into 0.05° cells aligned with the MODIS climate grid.</li>
        <li><strong>Streams.</strong> MODIS Terra + Aqua; a Terra-only bridge for Nov 2000 – Jun 2002; VIIRS as the per-day mean over operating satellites (NOAA-20/21 first scaled to S-NPP). Satellite outages are handled from a daily availability table.</li>
        <li><strong>Strata.</strong> Biome × realm (RESOLVE Ecoregions 2017), so calibration respects how differently fires look in savanna, forest and cropland.</li>
        <li><strong>Calibrate once, then freeze.</strong> A multiplicative VIIRS→MODIS ratio per stratum × day/night × month-of-year, fit on 2012–2021 (before MODIS orbit drift), with per-cell empirical-Bayes shrinkage.</li>
        <li><strong>One series with honest uncertainty.</strong> Bridged Terra → native MODIS → calibrated VIIRS from the switch year (default {session.meta ? Math.floor(session.meta.default_switch_m / 12) + 2000 : 2023}). Intervals combine calibration-factor variance and count noise, tuned to leave-one-year-out coverage.</li>
      </ol>

      <h3>Validation</h3>
      {#if validation}
        {#if headline.length}
          <dl class="head-nums">
            {#each headline as [k, v] (k)}<div><dt class="eyebrow">{k}</dt><dd class="num">{fmt(v)}</dd></div>{/each}
          </dl>
        {/if}
        <details>
          <summary>All validation figures ({rows.length})</summary>
          <div class="vt-wrap">
            <table class="vt">
              <tbody>
                {#each rows as r, i (i)}
                  <tr><th scope="row" style:padding-left={`${r.depth * 14 + 4}px`}>{r.key}</th><td class="num">{r.value}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {:else}
        <p class="muted small">Validation results (leave-one-year-out 2012–2021 and the 2023–2026 out-of-time test) appear here once the pipeline publishes <code>validation.json</code>{vError ? ` (${vError})` : ''}.</p>
      {/if}

      <h3>Caveats</h3>
      <ul class="caveats">
        <li>Counts measure <strong>fire detections, not burned area</strong> or emissions.</li>
        <li>Cloud cover and overpass sampling are not corrected; smoke and cloud can hide fires.</li>
        <li>MODIS orbits have drifted since 2021, which affects the 2023+ MODIS comparison.</li>
        <li>Suomi NPP data ended on 2 Nov 2026; NOAA-20 and NOAA-21 carry VIIRS from then on.</li>
        <li>Recent months are <strong>provisional</strong> (near-real-time) and may change when science-quality data arrive.</li>
        <li>Areas with no MODIS fire history are shrunk toward their stratum’s calibration.</li>
      </ul>
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
  .method { padding: 26px 0 22px; border-bottom: 1px solid var(--rule); scroll-margin-top: calc(var(--header-h) + 80px); }
  .disclosure { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: var(--ink); cursor: pointer; }
  .disclosure svg { transition: transform 0.2s; }
  .disclosure svg.open { transform: rotate(90deg); }
  .body { margin-top: 12px; max-width: 74ch; }
  .unit { color: var(--ink-2); }
  .steps { padding-left: 1.3em; display: grid; gap: 8px; color: var(--ink-2); }
  .steps strong, .unit strong { color: var(--ink); }
  h3 { margin: 18px 0 8px; font-size: 0.95rem; }
  .head-nums { display: flex; flex-wrap: wrap; gap: 10px 26px; margin: 0 0 10px; }
  .head-nums dd { margin: 0; font-size: 1.3rem; font-weight: 600; }
  .vt-wrap { max-height: 360px; overflow: auto; margin-top: 8px; }
  .vt { width: 100%; font-size: 0.76rem; }
  .vt th, .vt td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--rule); font-weight: 400; }
  .vt th { color: var(--ink-3); }
  summary { cursor: pointer; color: var(--ink-2); font-size: 0.86rem; }
  .caveats { color: var(--ink-2); padding-left: 1.2em; display: grid; gap: 4px; }
</style>
