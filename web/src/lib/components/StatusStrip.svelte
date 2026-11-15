<script lang="ts">
  // The answer card: one hero figure, one plain sentence, three supporting facts. Precision sits behind "Details".
  import { fade } from 'svelte/transition'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { live } from '../live/store.svelte'
  import { monthStats, LEVEL_TONE, SOURCE_LABEL } from '../analysisUtil'
  import { MONTHS_LONG, MONTHS_SHORT, LEVEL_LABEL, fmtArea, fmtNum, fmtRatio, monthLong, ordinal, rankFromEnds } from '../format'
  import { yearContext } from '../brief/yearContext'
  import Term from './Term.svelte'
  import { briefLead } from './briefLead.svelte'
  import { addsFact } from './leadFacts'
  import { goToSection, livePace, partOfMonth, HINT_KEY } from './livePace'

  let {
    a,
    analogs = null,
  }: {
    a: Analysis
    /** Insertion point: one line on analog years, e.g. "2026 so far most resembles 2010 and 2007". */
    analogs?: string | null
  } = $props()

  const m = $derived(session.focus ?? a.current.m)
  const s = $derived(monthStats(a, m))
  const monthName = $derived(s ? MONTHS_LONG[s.month - 1] : '')
  const tone = $derived(s ? LEVEL_TONE[s.level] ?? 'neutral' : 'neutral')
  const ratioBig = $derived.by(() => {
    if (!s || s.ratio == null) return { n: '—', unit: '' }
    return { n: fmtRatio(s.ratio).replace('×', ''), unit: '×' }
  })
  const season = $derived(a.season)
  const seasonText = $derived(
    season.lengthMonths >= 12
      ? `Fires occur all year here, peaking in ${MONTHS_LONG[season.peakMonth - 1]}.`
      : `The fire season here runs ${MONTHS_LONG[season.startMonth - 1]} to ${MONTHS_LONG[season.endMonth - 1]} and peaks in ${MONTHS_LONG[season.peakMonth - 1]}${season.secondPeak ? ` and ${MONTHS_LONG[season.secondPeak - 1]}` : ''}.`,
  )
  const rankText = $derived.by(() => {
    if (!s) return ''
    if (s.value === 0 && s.median === 0) return `No detections, as usual for ${monthName} here.`
    if (s.rank == null) return ''
    return `The ${rankFromEnds(s.rank, s.of)} ${monthName} in ${s.of} years.`
  })
  // The year fact follows the month in view (one time frame): this year so far, or that year as a whole.
  const yc = $derived(s ? yearContext(a, s) : null)
  const yearFact = $derived.by(() => {
    if (!yc) return null
    if (!s!.isCurrent && yc.annual) {
      return { dt: `${yc.annual.year} as a whole`, dd: yc.annual.rank === 1 ? 'The most active year' : `${ordinal(yc.annual.rank)} most active year`, sub: `of ${yc.annual.of} complete years`, ratio: false }
    }
    const y = yc.ytd
    return {
      dt: s!.isCurrent ? `${y.year} so far` : `${y.year} to ${MONTHS_SHORT[y.throughMonth - 1]}`,
      dd: `${fmtRatio(y.ratio)} normal`,
      sub: y.rank != null ? `${ordinal(y.rank)} of ${y.of} years${s!.isCurrent ? `, through ${MONTHS_SHORT[y.throughMonth - 1]}` : ''}` : '',
      ratio: true,
    }
  })
  const t = $derived(a.trend)
  const trendHead = $derived(
    t.direction === 'none' || !Number.isFinite(t.slopePctPerYear)
      ? 'No clear trend'
      : `${t.direction === 'up' ? 'Rising' : 'Falling'} about ${Math.abs(t.slopePctPerYear) < 1 ? Math.abs(t.slopePctPerYear).toFixed(1) : Math.round(Math.abs(t.slopePctPerYear))} % a year`,
  )
  const record = $derived(a.records.topMonths[0])
  // Newest drawn month, when it is partial (still in progress) and so not the month described here.
  const inProgress = $derived.by(() => {
    const p = a.series.partial
    if (!p) return null
    for (let i = a.months.length - 1; i >= 0; i--) {
      if (a.series.harmonized[i] == null) continue
      return p[i] && a.months[i] > a.current.m ? a.months[i] : null
    }
    return null
  })

  // Analog years (kernel `analysis.analogs`): one line when the latest month is in view, only if the kernel calls
  // them informative for this area (hindcast skill and agreement); otherwise they are anecdotes and stay hidden.
  const analogParts = $derived.by(() => {
    const an = a.analogs
    if (analogs != null || !s?.isCurrent || !an?.informative || an.year !== a.current.year) return null
    const top = an.top.filter((t) => t.restRatio != null).slice(0, 2)
    if (!top.length) return null
    const join = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0])
    return {
      year: an.year, years: join(top.map((t) => String(t.year))), ratios: join(top.map((t) => fmtRatio(t.restRatio))),
      one: top.length === 1, note: an.note,
    }
  })
  const analogLine = $derived(
    analogs ?? (analogParts
      ? `${analogParts.year} so far most resembles ${analogParts.years}; ${analogParts.one ? 'that year' : 'those years'} went on to finish ${analogParts.ratios} normal for the rest of the year.`
      : null),
  )

  // The lifted AI headline earns its line only when it states a number or month the card does not already show.
  const cardText = $derived(
    s
      ? [
          session.aoi?.label, monthLong(m), `${ratioBig.n}×`, monthName, LEVEL_LABEL[s.level], rankText, seasonText, analogLine,
          yearFact ? `${yearFact.dt} ${yearFact.dd} ${yearFact.sub}` : '', trendHead, `since ${t.years[0]}`,
          record ? `${monthLong(record.m)} ${fmtRatio(record.ratio)}` : '',
          fmtNum(s.value), s.lo80 != null ? fmtNum(s.lo80) : '', s.hi80 != null ? fmtNum(s.hi80) : '', fmtNum(s.median),
          session.effectiveBaseline.join('–'), s.percentile != null ? ordinal(Math.round(s.percentile)) : '',
        ].filter(Boolean).join(' ')
      : '',
  )
  const leadLine = $derived(briefLead.text && addsFact(briefLead.text, cardText) ? briefLead.text : '')

  // "This week" line: only when the month in view is the latest month, so the card keeps one time frame.
  const pace = $derived(s?.isCurrent && live.available ? livePace(a) : null)
  const nowDate = $derived(new Date(live.now))
  const weekLine = $derived(
    pace && pace.ratio != null && pace.calibration !== 'none'
      ? `This week: ${fmtRatio(pace.ratio)} the normal pace for ${partOfMonth(nowDate)}-${MONTHS_LONG[nowDate.getUTCMonth()]}`
      : null,
  )

  // One-line, dismissible first-analysis hint (contextual help instead of a tour).
  // It goes away for good once the viewer has picked a month in the calendar (CalendarView records that).
  let hint = $state(false)
  $effect(() => { void session.focusM; try { hint = localStorage.getItem(HINT_KEY) !== '1' } catch { hint = false } })
  const smooth = $derived(!themeState.reducedMotion)
</script>

{#if s}
  <section id="answer" class="card" aria-labelledby="status-h">
    <div class="place">
      <p class="area"><span class="name">{session.aoi?.label ?? 'Selected area'}</span>{#if session.aoiInfo}<span class="km num">{fmtArea(session.aoiInfo.areaKm2)}</span>{/if}</p>
      {#if !s.isCurrent}
        <button class="btn" onclick={() => session.setFocus(null)}>Back to {MONTHS_SHORT[a.current.month - 1]} {a.current.year}</button>
      {/if}
    </div>

    <h2 id="status-h" class="when">
      {monthLong(m)} <span class="vs">compared with normal</span>
      {#if s.provisional}<Term id="provisional"><span class="chip prov">Provisional</span></Term>{/if}
    </h2>

    <div class="answer">
      <p class="hero">
        <span class="big num" data-answer-numeral>{ratioBig.n}<span class="x">{ratioBig.unit}</span></span>
        <span class="cap">the <Term id="normal">normal</Term> for {monthName}</span>
      </p>
      <div class="facts">
        <span class="level {tone}">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            {#if tone === 'critical'}<path d="M6 1 11 6 6 11 1 6z" fill="currentColor" />
            {:else if tone === 'serious' || tone === 'warning'}<path d="M6 1.5 11 10.5H1z" fill="currentColor" />
            {:else if tone === 'info'}<path d="M6 10.5 1 1.5h10z" fill="currentColor" />
            {:else}<circle cx="6" cy="6" r="4" fill="currentColor" />{/if}
          </svg>
          {LEVEL_LABEL[s.level] ?? s.level}
        </span>
        <p class="sentence">{rankText} {seasonText}</p>
      </div>
    </div>

    {#if analogs}<p class="line">{analogs}</p>
    {:else if analogParts}
      <p class="line analog">{analogParts.year} so far <Term id="analogs" extra={analogParts.note}>most resembles</Term> {analogParts.years}; {analogParts.one ? 'that year' : 'those years'} went on to finish <span class="num">{analogParts.ratios}</span> normal for the rest of the year.</p>
    {/if}
    {#if leadLine}<p class="line lead-in" transition:fade={{ duration: smooth ? 250 : 0 }}>{leadLine}</p>{/if}
    {#if weekLine}
      <p class="line week"><span class="now-dot" aria-hidden="true"></span><button class="link" onclick={() => goToSection('now', smooth)}>{weekLine} <span aria-hidden="true">↓</span></button></p>
    {:else if inProgress != null && s.isCurrent}
      <p class="line muted">{monthLong(inProgress)} is still in progress. <button class="link" onclick={() => goToSection('now', smooth)}>See what is burning right now <span aria-hidden="true">↓</span></button></p>
    {/if}

    <details class="more">
      <summary>Details</summary>
      <div class="more-body">
        <p>
          <span class="num">{fmtNum(s.value)}</span> <Term id="afcdm" />
          {#if s.lo80 != null && s.hi80 != null}(<Term id="likely">likely range</Term> <span class="num">{fmtNum(s.lo80)}–{fmtNum(s.hi80)}</span>){/if},
          against a normal of <span class="num">{fmtNum(s.median)}</span> for {monthName} ({session.effectiveBaseline.join('–')} median).
          {#if s.percentile != null}<Term id="percentile" /> <span class="num">{ordinal(Math.round(s.percentile))}</span>.{/if}
          Source: {SOURCE_LABEL[s.source]}.
        </p>
      </div>
    </details>

    <dl class="kpis">
      <div>
        {#if yearFact}
          <dt class="eyebrow">{yearFact.dt}</dt>
          <dd>{yearFact.dd}</dd>
          <dd class="sub">{yearFact.sub}</dd>
        {:else}<dt class="eyebrow">This year</dt><dd>—</dd>{/if}
      </div>
      <div>
        <dt class="eyebrow">Trend</dt>
        <dd>{trendHead}</dd>
        <dd class="sub">since {t.years[0]}{t.direction === 'none' ? '' : t.pValue < 0.05 ? ', likely real' : ', could be chance'}</dd>
      </div>
      <div>
        <dt class="eyebrow">Record month</dt>
        {#if record}
          <dd>{monthLong(record.m)}</dd>
          <dd class="sub"><span class="num">{fmtRatio(record.ratio)}</span> normal</dd>
        {:else}<dd>—</dd>{/if}
      </div>
    </dl>

    {#if hint}
      <p class="hint" role="note">
        <span>Tip: click any month in the calendar below to map it and see it here.</span>
      </p>
    {/if}
  </section>
{/if}

<style>
  .card { padding: 20px 0 22px; }
  .place { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 34px; }
  .area { margin: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .name {
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-sm); letter-spacing: var(--track-label);
    text-transform: uppercase; color: var(--ink-2);
  }
  .km { font-size: var(--fs-sm); color: var(--ink-3); }
  .when { font-size: var(--fs-xl); display: flex; align-items: center; gap: 4px 10px; flex-wrap: wrap; margin-top: 6px; }
  .vs { color: var(--ink-3); font-weight: 400; }
  .answer { display: grid; grid-template-columns: auto 1fr; gap: 10px 28px; align-items: end; margin-top: 14px; }
  .hero { display: grid; gap: 4px; margin: 0; }
  .big { font-size: var(--fs-hero); line-height: 0.88; font-weight: 600; letter-spacing: -0.05em; color: var(--ink); }
  .x { font-size: 0.55em; color: var(--accent); margin-left: 2px; }
  .cap { color: var(--ink-2); font-size: var(--fs-base); }
  .facts { display: grid; gap: 10px; justify-items: start; padding-bottom: 2px; }
  .sentence { font-size: var(--fs-lg); line-height: 1.45; margin: 0; max-width: 48ch; }
  .line { margin: 14px 0 0; font-size: var(--fs-base); color: var(--ink-2); }
  .line + .line { margin-top: 6px; }
  .lead-in { color: var(--ink); border-left: 2px solid var(--rule-strong); padding-left: 10px; }
  .week { display: flex; align-items: center; gap: 8px; }
  .now-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .link {
    background: none; border: 0; padding: 0; font: inherit; color: var(--ink); cursor: pointer;
    text-decoration: underline; text-decoration-color: var(--rule-strong); text-underline-offset: 3px;
  }
  .link:hover { text-decoration-color: var(--ink); }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); }
  .kpis > div { padding: 0 14px; border-left: 1px solid var(--rule); }
  .kpis > div:first-child { padding-left: 0; border-left: 0; }
  dt { margin-bottom: 4px; }
  dd { margin: 0; font-size: var(--fs-base); }
  dd.sub { font-size: var(--fs-base); color: var(--ink-3); margin-top: 2px; }
  .hint {
    display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 16px 0 0; max-width: none;
    padding: 8px 12px; border: 1px dashed var(--rule-strong); border-radius: var(--radius); color: var(--ink-2); font-size: var(--fs-sm);
  }
  .x { background: none; border: 0; color: var(--ink-3); font-size: var(--fs-lg); line-height: 1; cursor: pointer; min-width: 32px; min-height: 32px; }
  .x:hover { color: var(--ink); }
  @media (max-width: 720px) {
    .answer { grid-template-columns: 1fr; }
    .kpis { grid-template-columns: 1fr 1fr; gap: 14px 0; }
    .kpis > div:nth-child(3) { padding-left: 0; border-left: 0; }
  }
</style>
