<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import type { LabResult, ModelJson, Metric } from '../ml/lab'
  import type { Aoi } from '../geo'
  import { session } from '../session.svelte'
  import { linear, linePath, niceMax, niceTicks, tickLabel } from '../charts/scale'
  import { fmtNum, monthShort, yearOf } from '../format'
  import { validation } from '../validation.svelte'

  let { a }: { a: Analysis } = $props()

  let open = $state(false)
  let phase = $state<'idle' | 'running' | 'done' | 'error'>('idle')
  let errorMsg = $state('')
  let res = $state.raw<LabResult | null>(null)
  let model = $state.raw<ModelJson | null>(null)
  let ranFor: Aoi | null = null

  const meta = $derived(session.meta)
  const level = $derived(a.aoi.level)
  const cellDeg = $derived(meta?.levels.find((l) => l.level === level)?.cell_deg ?? null)
  const atL0 = $derived(level === 0)

  // Run when opened, and again whenever a new area finishes loading at L0 while open.
  $effect(() => {
    if (!open || !atL0 || session.isMock) return
    const aoi = session.aoi, layer = session.layer
    if (!aoi || !layer || session.status !== 'ready') return
    if (layer.level !== 0 || layer.cells.length !== a.aoi.nCells) return
    if (aoi === ranFor) return
    ranFor = aoi
    void run(aoi, layer)
  })

  function toggle() {
    open = !open
    if (open && phase === 'error') ranFor = null   // reopening retries after a failure
  }

  async function run(aoi: Aoi, layer: NonNullable<typeof session.layer>) {
    phase = 'running'
    errorMsg = ''
    try {
      const lab = await import('../ml/lab')
      model = await lab.loadModelJson()
      // Same out-of-time years as the global test in model.json (the latest year may be partial).
      const ootYears = (model.out_of_time.by_year.challenger ?? model.out_of_time.by_year.production)?.map((y) => y.year) ?? []
      const ootLastM = ootYears.length ? (Math.max(...ootYears) - 2000) * 12 + 11 : undefined
      const r = await lab.runLab(session.meta!, session.sel?.index ?? null, layer, () => session.aoi === aoi, ootLastM)
      if (r == null || session.aoi !== aoi) return
      res = r
      phase = 'done'
    } catch (e) {
      console.warn('method lab:', e)
      errorMsg = /model\.(json|onnx): HTTP 404/.test(String(e))
        ? 'The ML challenger has not been built for this data release (run the pipeline’s ml stage).'
        : 'The in-browser model could not run here, so the lab is unavailable in this browser. The rest of the analysis is unaffected.'
      phase = 'error'
    }
  }

  // ---------------------------------------------------------------- chart
  let width = $state(640)
  const height = 260
  const M = { t: 18, r: 112, b: 26, l: 48 }
  const n = $derived(res?.months.length ?? 0)
  const x = $derived(res ? linear([res.months[0], res.months[n - 1]], [M.l, width - M.r]) : null)
  const yMax = $derived(res ? niceMax(Math.max(1, ...res.production, ...res.challenger, ...res.observed.map((v) => v ?? 0)) * 1.05) : 1)
  const y = $derived(linear([0, yMax], [height - M.b, M.t]))
  const yTicks = $derived(niceTicks(0, yMax, 4))
  const xTicks = $derived.by(() => {
    if (!res) return []
    const y0 = yearOf(res.months[0]), y1 = yearOf(res.months[n - 1])
    const step = width < 480 ? 4 : 2
    const out: number[] = []
    for (let yy = Math.ceil(y0 / step) * step; yy <= y1; yy += step) out.push(yy)
    return out
  })
  const path = (vals: (number | null)[]) => (res && x ? linePath(vals.map((v, i) => (v == null ? null : [x(res!.months[i]), y(v)]))) : '')
  const pObs = $derived(res ? path(res.observed) : '')
  const pProd = $derived(res ? path(res.production) : '')
  const pMl = $derived(res ? path(res.challenger) : '')
  const fitEnd = $derived(meta?.fit_window_m[1] ?? 263)

  // Direct labels at each line's last value, nudged apart.
  const SERIES = [
    { key: 'observed', label: 'MODIS observed', cls: 'modis' },
    { key: 'production', label: 'Production', cls: 'viirs' },
    { key: 'challenger', label: 'ML challenger', cls: 'ml' },
  ] as const
  const endLabels = $derived.by(() => {
    if (!res || !x) return []
    const out = SERIES.map((s) => {
      const vals = res![s.key] as (number | null)[]
      let i = vals.length - 1
      while (i > 0 && vals[i] == null) i--
      return { ...s, x: x!(res!.months[i]), y: y(vals[i] ?? 0) }
    }).sort((p, q) => p.y - q.y)
    for (let i = 1; i < out.length; i++) out[i].y = Math.max(out[i].y, out[i - 1].y + 12)
    return out
  })

  let hover = $state<number | null>(null)
  function onMove(e: PointerEvent) {
    if (!res || !x) return
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const m = Math.round(x.invert(((e.clientX - r.left) / r.width) * width))
    const i = m - res.months[0]
    hover = i >= 0 && i < n ? i : null
  }
  function onKey(e: KeyboardEvent) {
    if (!res) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const d = e.key === 'ArrowRight' ? 1 : -1
      hover = Math.max(0, Math.min(n - 1, (hover ?? (d > 0 ? -1 : n)) + d))
    } else if (e.key === 'Escape') hover = null
  }
  const hv = $derived(res && hover != null && x ? {
    m: res.months[hover], x: x(res.months[hover]),
    obs: res.observed[hover], prod: res.production[hover], ml: res.challenger[hover],
  } : null)

  const annual = $derived.by(() => {
    if (!res) return []
    const rows = new Map<number, { year: number; obs: number | null; prod: number; ml: number }>()
    res.months.forEach((m, i) => {
      const yy = yearOf(m)
      const r = rows.get(yy) ?? { year: yy, obs: 0 as number | null, prod: 0, ml: 0 }
      const o = res!.observed[i]
      r.obs = o == null || r.obs == null ? null : r.obs + o
      r.prod += res!.production[i]
      r.ml += res!.challenger[i]
      rows.set(yy, r)
    })
    return [...rows.values()]
  })

  // ---------------------------------------------------------------- formatting
  const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2))
  const f3 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3))
  const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`)
  const ORDER = ['naive', 'ratio_k', 'ratio_kr', 'challenger_raw', 'challenger', 'challenger_r']
  const SHORT: Record<string, string> = {
    naive: 'Naive global ratio', ratio_k: 'Ratio, no cell multiplier', ratio_kr: 'Production ratio method',
    challenger_raw: 'ML challenger, before mass balance', challenger: 'ML challenger', challenger_r: 'ML challenger × cell multiplier',
  }
  const methods = $derived(model ? ORDER.filter((k) => model!.evaluation.table[k]) : [])
  const best = $derived.by(() => {
    const t = model?.evaluation.table
    if (!t) return { c1: '', st: '' }
    const pick = (sc: 'cell1deg_month' | 'stratum_month') => methods.reduce((b, k) => ((t[k][sc].log_rmse ?? 9) < (t[b][sc].log_rmse ?? 9) ? k : b), methods[0])
    return { c1: pick('cell1deg_month'), st: pick('stratum_month') }
  })
  // Years of the global out-of-time test: the challenger's (model.json); the production row comes from validation.json,
  // the single source for the served calibration, so the two tables on the page can never disagree.
  $effect(() => { if (open) void validation.load() })
  const ootYears = $derived((model?.out_of_time.by_year.challenger ?? model?.out_of_time.by_year.production)?.map((r) => r.year) ?? [])
  const prodOot = $derived.by(() => {
    const rows = validation.data?.out_of_time?.by_year
    if (!rows) return model?.out_of_time.by_year.production ?? null
    return ootYears.map((y) => ({ year: y, bias_pct: rows.find((r) => r.year === y)?.bias_pct ?? NaN }))
  })
  const ootRow = (k: string) => (k === 'production' ? prodOot : model?.out_of_time.by_year[k] ?? null)
  const fmtDay = (iso: string | undefined) => {
    if (!iso) return null
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  }
  const trainedOn = $derived(fmtDay(model?.trained_on_build))
  const dataBuild = $derived(fmtDay(session.meta?.generated))
  const OOT_ROWS = ['production', 'challenger', 'challenger_raw', 'naive']
  const ootLabel: Record<string, string> = { production: 'Production ratio method', challenger: 'ML challenger', challenger_raw: 'ML challenger, before mass balance', naive: 'Naive global ratio' }
  const span = (m: [number, number]) => `${monthShort(m[0])} – ${monthShort(m[1])}`
  const metric = (k: string, sc: 'cell1deg_month' | 'stratum_month'): Metric => model?.evaluation.table[k]?.[sc] ?? {}

  const summary = $derived(res
    ? `Monthly totals for this area, ${yearOf(res.months[0])} to ${yearOf(res.months[n - 1])}: observed MODIS, the production calibration and the ML challenger. Over the fit window the production method has r = ${f2(res.fit.production.r)} and bias ${pct(res.fit.production.biasPct)}; the challenger r = ${f2(res.fit.challenger.r)} and bias ${pct(res.fit.challenger.biasPct)}.`
    : '')
</script>

<section class="lab" id="lab" aria-labelledby="lab-h">
  <div class="head">
    <h3 id="lab-h" class="sub-title">Would machine learning do better?</h3>
    <button class="btn" aria-expanded={open} aria-controls="lab-body" onclick={toggle}>
      {open ? 'Close the lab' : 'Open the lab'}
    </button>
  </div>
  <p class="lede">
    A small neural network, trained in the pipeline and run here in your browser, recalibrates VIIRS independently of the production ratio method. If both agree with MODIS, the simple method is not leaving skill on the table.
  </p>

  {#if open}
    <div id="lab-body" class="body">
      {#if session.isMock}
        <p class="quiet small">The lab needs the real pipeline output; it is not available with demo data.</p>
      {:else if !atL0}
        <p class="quiet small">
          The lab runs at full resolution only (0.05° cells). This area is large, so it was loaded at {cellDeg ?? '?'}° cells, where the model’s per-cell inputs no longer exist. Draw a smaller area to run it.
        </p>
      {:else if phase === 'error'}
        <p class="quiet small" role="status">{errorMsg}</p>
      {:else if phase === 'running' || !res}
        <p class="quiet small" role="status" aria-live="polite">Loading the model and ONNX runtime, then scoring this area’s cell-months…</p>
      {:else}
        <div class="nums" class:stale={phase !== 'done'}>
          <div class="grp">
            <span class="gl">Fit years {yearOf(meta!.fit_window_m[0])}–{yearOf(meta!.fit_window_m[1])}, vs MODIS</span>
            <table class="agree">
              <thead><tr><th></th><th scope="col">r</th><th scope="col">Bias</th></tr></thead>
              <tbody>
                <tr><th scope="row"><span class="sw viirs"></span>Production</th><td class="num">{f2(res.fit.production.r)}</td><td class="num">{pct(res.fit.production.biasPct)}</td></tr>
                <tr><th scope="row"><span class="sw ml"></span>ML challenger</th><td class="num">{f2(res.fit.challenger.r)}</td><td class="num">{pct(res.fit.challenger.biasPct)}</td></tr>
              </tbody>
            </table>
          </div>
          {#if res.oot.production.n > 0}
            <div class="grp">
              <span class="gl">Out of time, {yearOf(meta!.fit_window_m[1]) + 1}–{yearOf(res.oot.to)}</span>
              <table class="agree">
                <thead><tr><th class="sr-only">Method</th><th scope="col">r</th><th scope="col">Bias</th></tr></thead>
                <tbody>
                  <tr><th scope="row" class="sr-only">Production</th><td class="num">{f2(res.oot.production.r)}</td><td class="num">{pct(res.oot.production.biasPct)}</td></tr>
                  <tr><th scope="row" class="sr-only">ML challenger</th><td class="num">{f2(res.oot.challenger.r)}</td><td class="num">{pct(res.oot.challenger.biasPct)}</td></tr>
                </tbody>
              </table>
            </div>
          {/if}
        </div>

        <div class="chart" bind:clientWidth={width}>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <svg {width} {height} role="img" aria-label={summary} tabindex="0" onpointermove={onMove} onpointerleave={() => (hover = null)} onkeydown={onKey} onblur={() => (hover = null)}>
            {#each yTicks as v (v)}
              <line x1={M.l} x2={width - M.r} y1={y(v)} y2={y(v)} class="grid" />
              <text class="tk" x={M.l - 6} y={y(v)} dy="0.32em" text-anchor="end">{tickLabel(v)}</text>
            {/each}
            <text class="unit" x={M.l} y={M.t - 6}>AFCD-M / month</text>
            {#each xTicks as yy (yy)}
              <text class="tk" x={x!((yy - 2000) * 12)} y={height - 8} text-anchor="middle">{yy}</text>
            {/each}
            {#if fitEnd < res.months[n - 1]}
              <line class="era" x1={x!(fitEnd + 0.5)} x2={x!(fitEnd + 0.5)} y1={M.t} y2={height - M.b} />
              <text class="tk" x={x!(fitEnd + 0.5) + 4} y={M.t + 8}>fit window ends · out of time →</text>
            {/if}
            <path d={pObs} class="line modis" />
            <path d={pProd} class="line viirs" />
            <path d={pMl} class="line ml" />
            {#each endLabels as l (l.key)}
              <line x1={l.x + 6} x2={l.x + 16} y1={l.y} y2={l.y} class="key {l.cls}" />
              <text class="lab-t" x={l.x + 20} y={l.y} dy="0.32em">{l.label}</text>
            {/each}
            {#if hv}
              <line class="cross" x1={hv.x} x2={hv.x} y1={M.t} y2={height - M.b} />
            {/if}
          </svg>
          {#if hv}
            <div class="tip" style:left={`${Math.min(width - 200, Math.max(0, hv.x + 10))}px`}>
              <p class="tt">{monthShort(hv.m)}</p>
              <p><span class="sw modis"></span>MODIS observed <span class="num">{hv.obs == null ? '—' : fmtNum(hv.obs)}</span></p>
              <p><span class="sw viirs"></span>Production <span class="num">{fmtNum(hv.prod)}</span></p>
              <p><span class="sw ml"></span>ML challenger <span class="num">{fmtNum(hv.ml)}</span></p>
            </div>
          {/if}
        </div>
        <ul class="keys" aria-label="Legend">
          <li><span class="sw modis"></span>MODIS observed (Terra + Aqua)</li>
          <li><span class="sw viirs"></span>Production: calibrated VIIRS (ratio × cell multiplier)</li>
          <li><span class="sw ml dash"></span>ML challenger (dashed)</li>
        </ul>
        <p class="telemetry small num">
          {fmtNum(res.cellMonths, 1e9)} cell-months · {fmtNum(res.rows, 1e9)} rows · {res.provider}{res.adapter ? ` (${res.adapter})` : ''} · {res.inferMs.toFixed(0)} ms inference · runtime + model {(res.loadMs / 1000).toFixed(1)} s
        </p>
        {#if res.fallbackReason}<p class="small muted">WebGPU not used: {res.fallbackReason}.</p>{/if}

        <details class="tbl">
          <summary class="small">Annual totals for this area (table)</summary>
          <div class="tw">
            <table class="small">
              <thead><tr><th scope="col">Year</th><th scope="col">MODIS observed</th><th scope="col">Production</th><th scope="col">ML challenger</th></tr></thead>
              <tbody>
                {#each annual as r (r.year)}
                  <tr><th scope="row" class="num">{r.year}</th><td class="num">{r.obs == null ? '—' : fmtNum(r.obs)}</td><td class="num">{fmtNum(r.prod)}</td><td class="num">{fmtNum(r.ml)}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </details>
      {/if}

      {#if model && (phase === 'done' || phase === 'running')}
        <h3>Global held-out test</h3>
        <p class="small muted">
          Every method fitted on {span(model.evaluation.train_m)}, scored on {span(model.evaluation.test_m)} against observed MODIS at 1° cell-month and stratum-month scale (r of log1p, log-RMSE, bias). Lowest log-RMSE in bold.
        </p>
        <div class="tw">
          <table class="mt small">
            <thead>
              <tr><th rowspan="2" scope="col">Method</th><th colspan="3" scope="colgroup">1° cell-month</th><th colspan="3" scope="colgroup">Stratum-month</th></tr>
              <tr><th scope="col">r</th><th scope="col">log-RMSE</th><th scope="col">Bias</th><th scope="col">r</th><th scope="col">log-RMSE</th><th scope="col">Bias</th></tr>
            </thead>
            <tbody>
              {#each methods as k (k)}
                <tr class:hl={k === 'ratio_kr' || k === 'challenger'}>
                  <th scope="row">{#if k === 'ratio_kr'}<span class="sw viirs"></span>{:else if k === 'challenger'}<span class="sw ml"></span>{/if}{SHORT[k] ?? k}</th>
                  <td class="num">{f3(metric(k, 'cell1deg_month').r_log1p)}</td>
                  <td class="num" class:best={best.c1 === k}>{f3(metric(k, 'cell1deg_month').log_rmse)}</td>
                  <td class="num">{pct(metric(k, 'cell1deg_month').bias_pct)}</td>
                  <td class="num">{f3(metric(k, 'stratum_month').r_log1p)}</td>
                  <td class="num" class:best={best.st === k}>{f3(metric(k, 'stratum_month').log_rmse)}</td>
                  <td class="num">{pct(metric(k, 'stratum_month').bias_pct)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if ootYears.length}
          <p class="small muted">Out of time: models fitted on the full {yearOf(model.training.window_m[0])}–{yearOf(model.training.window_m[1])} window, global bias vs still-observed MODIS (orbit drift affects MODIS itself after ~2021).</p>
          <div class="tw">
            <table class="mt small">
              <thead><tr><th scope="col">Bias by year</th>{#each ootYears as yy (yy)}<th scope="col" class="num">{yy}</th>{/each}</tr></thead>
              <tbody>
                {#each OOT_ROWS.filter((k) => ootRow(k)) as k (k)}
                  <tr class:hl={k === 'production' || k === 'challenger'}><th scope="row">{ootLabel[k]}</th>{#each ootRow(k) ?? [] as r (r.year)}<td class="num">{pct(r.bias_pct)}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <p class="verdict">{model.verdict}</p>
        {#if trainedOn}
          <p class="small muted">Trained on the data build of {trainedOn}{dataBuild && dataBuild !== trainedOn ? `; the record on this page is the build of ${dataBuild}` : ''}.</p>
        {:else if fmtDay(model.generated)}
          <p class="small muted">Model trained {fmtDay(model.generated)}.</p>
        {/if}
        <p class="small muted">{model.architecture} · {fmtNum(model.n_params, 1e9)} parameters · {(model.onnx.bytes / 1024).toFixed(0)} KB ONNX · {model.form}.</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .lab { padding: 22px 0 24px; border-bottom: 1px solid var(--rule); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .lede { color: var(--ink-2); max-width: var(--measure); margin: 10px 0 0; }
  .body { margin-top: 14px; }
  .quiet { color: var(--ink-3); max-width: 62ch; }
  .nums { display: flex; flex-wrap: wrap; gap: 8px 32px; margin-bottom: 10px; }
  .nums.stale { opacity: 0.55; }
  .grp { display: grid; gap: 2px; }
  .gl { font-size: var(--fs-sm); color: var(--ink-3); }
  .agree { font-size: var(--fs-md); }
  .agree th, .agree td { padding: 1px 10px 1px 0; text-align: right; font-weight: 400; }
  .agree tbody th { text-align: left; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
  .agree thead th { color: var(--ink-3); font-size: var(--fs-xs); }
  .agree td { font-size: var(--fs-lg); font-weight: 600; }
  .chart { position: relative; width: 100%; }
  svg { display: block; overflow: visible; touch-action: pan-y; }
  .grid { stroke: var(--rule); stroke-width: 1; }
  .tk { font-family: var(--font-num); font-size: var(--fs-xs); fill: var(--ink-3); }
  .unit { font-size: var(--fs-sm); fill: var(--ink-3); }
  .lab-t { font-size: var(--fs-sm); fill: var(--ink-2); }
  .era { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 2 3; }
  .line { fill: none; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
  .line.modis, .key.modis { stroke: var(--s-modis); }
  .line.viirs, .key.viirs { stroke: var(--s-viirs); }
  .line.ml, .key.ml { stroke: var(--s-ml); stroke-dasharray: 5 3; }
  .key { stroke-width: 2; }
  .cross { stroke: var(--ink-3); stroke-width: 1; }
  .tip {
    position: absolute; top: 18px; pointer-events: none; z-index: 5; min-width: 190px;
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 6px 9px; font-size: var(--fs-sm);
  }
  .tip p { margin: 0; display: flex; align-items: center; gap: 6px; }
  .tip .num { margin-left: auto; padding-left: 10px; }
  .tt { font-weight: 600; margin-bottom: 3px !important; }
  .keys { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; padding: 0; font-size: var(--fs-sm); color: var(--ink-2); }
  .keys li { display: flex; align-items: center; gap: 6px; }
  .sw { display: inline-block; width: 14px; height: 2px; flex: none; background: var(--ink); }
  .sw.modis { background: var(--s-modis); }
  .sw.viirs { background: var(--s-viirs); }
  .sw.ml { background: var(--s-ml); }
  .sw.ml.dash { background: repeating-linear-gradient(90deg, var(--s-ml) 0 5px, transparent 5px 8px); }
  .telemetry { color: var(--ink-3); margin: 8px 0 4px; }
  .tbl summary { cursor: pointer; color: var(--ink-2); }
  .tw { max-width: 100%; overflow-x: auto; }
  .tbl .tw { max-height: 280px; overflow: auto; margin-top: 6px; }
  .tbl table th, .tbl table td { padding: 2px 10px 2px 0; text-align: right; border-bottom: 1px solid var(--rule); font-weight: 400; }
  .body h3 { margin: 22px 0 4px; font-size: var(--fs-base); }
  .mt { width: 100%; margin: 6px 0 10px; }
  .mt th, .mt td { padding: 3px 8px; border-bottom: 1px solid var(--rule); text-align: right; font-weight: 400; white-space: nowrap; }
  .mt thead th { color: var(--ink-3); font-size: var(--fs-xs); }
  .mt tbody th { text-align: left; color: var(--ink-2); }
  .mt tbody th .sw { margin-right: 6px; vertical-align: middle; }
  .mt tr.hl th, .mt tr.hl td { color: var(--ink); }
  .mt td.best { font-weight: 700; }
  .verdict { margin: 10px 0 6px; padding-left: 10px; border-left: 2px solid var(--rule-strong); max-width: 70ch; }
</style>
