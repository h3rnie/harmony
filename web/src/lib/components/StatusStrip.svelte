<script lang="ts">
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { monthStats, trendWords, LEVEL_TONE, SOURCE_LABEL } from '../analysisUtil'
  import { MONTHS_LONG, MONTHS_SHORT, LEVEL_LABEL, fmtNum, fmtP, fmtRatio, monthLong, ordinal, rankFromEnds, yearOf } from '../format'

  let { a }: { a: Analysis } = $props()

  const m = $derived(session.focus ?? a.current.m)
  const s = $derived(monthStats(a, m))
  const since = $derived(session.meta ? yearOf(session.meta.m_first) : a.calendar.years[0])
  const monthName = $derived(s ? MONTHS_LONG[s.month - 1] : '')
  const tone = $derived(s ? LEVEL_TONE[s.level] ?? 'neutral' : 'neutral')
  const ratioBig = $derived.by(() => {
    if (!s || s.ratio == null) return { n: '—', unit: '' }
    const t = fmtRatio(s.ratio)
    return { n: t.replace('×', ''), unit: '×' }
  })
  const season = $derived(a.season)
  const seasonText = $derived(
    `${MONTHS_SHORT[season.startMonth - 1]}–${MONTHS_SHORT[season.endMonth - 1]}, ${Math.round(season.concentration * 100)} % of activity`,
  )
  const ytd = $derived(a.ytd)
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
</script>

{#if s}
  <section class="strip" aria-labelledby="status-h">
    <p class="eyebrow">01 · This month vs normal</p>
    <div class="top">
      <h2 id="status-h" class="when">
        {monthLong(m)}
        {#if s.isCurrent}<span class="chip now">Latest month</span>{/if}
        {#if s.provisional}<span class="chip prov" title="Near-real-time data; values may still change">Provisional</span>{/if}
      </h2>
      {#if !s.isCurrent}
        <button class="btn" onclick={() => session.setFocus(null)}>Back to {MONTHS_SHORT[a.current.month - 1]} {a.current.year}</button>
      {/if}
    </div>
    {#if inProgress != null && s.isCurrent}
      <p class="small muted in-progress">{monthLong(inProgress)} is still in progress — see Now for the live pace.</p>
    {/if}

    <div class="answer">
      <div class="hero">
        <span class="big num">{ratioBig.n}<span class="x">{ratioBig.unit}</span></span>
        <span class="cap">the normal for {monthName}</span>
      </div>
      <div class="facts">
        <p class="sentence">
          {#if s.value === 0 && s.median === 0}No detections — as usual for {monthName} here.
          {:else if s.percentile != null}<strong class="num">{ordinal(Math.round(s.percentile))}</strong> percentile{/if}
          {#if s.rank != null && !(s.value === 0 && s.median === 0)} · <strong>{rankFromEnds(s.rank, s.of)}</strong> {monthName} since {since}{/if}
        </p>
        <span class="level {tone}">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            {#if tone === 'critical'}<path d="M6 1 11 6 6 11 1 6z" fill="currentColor" />
            {:else if tone === 'serious' || tone === 'warning'}<path d="M6 1.5 11 10.5H1z" fill="currentColor" />
            {:else if tone === 'info'}<path d="M6 10.5 1 1.5h10z" fill="currentColor" />
            {:else}<circle cx="6" cy="6" r="4" fill="currentColor" />{/if}
          </svg>
          {LEVEL_LABEL[s.level] ?? s.level}
        </span>
        <p class="detail small muted">
          <span class="num">{fmtNum(s.value)}</span> AFCD-M
          {#if s.lo80 != null && s.hi80 != null}(80 %: <span class="num">{fmtNum(s.lo80)}–{fmtNum(s.hi80)}</span>){/if}
          vs median <span class="num">{fmtNum(s.median)}</span> · {SOURCE_LABEL[s.source]}
        </p>
      </div>
    </div>

    <dl class="kpis">
      <div>
        <dt class="eyebrow">Year to date {ytd.year}</dt>
        <dd><span class="num">{fmtRatio(ytd.ratio)}</span> median · <span class="num">{ordinal(ytd.rank)}</span> of {ytd.of}</dd>
        <dd class="sub">through {MONTHS_SHORT[ytd.throughMonth - 1]}</dd>
      </div>
      <div>
        <dt class="eyebrow">Trend {a.trend.years[0]}–{a.trend.years[1]}</dt>
        <dd>
          <span class="arrow {a.trend.direction}" aria-hidden="true">{a.trend.direction === 'up' ? '↗' : a.trend.direction === 'down' ? '↘' : '→'}</span>
          {trendWords(a)}
        </dd>
        <dd class="sub">Theil–Sen <span class="num">{a.trend.slopePctPerYear >= 0 ? '+' : '−'}{Math.abs(a.trend.slopePctPerYear).toFixed(1)} %/yr</span>, {fmtP(a.trend.pValue)}</dd>
      </div>
      <div>
        <dt class="eyebrow">Peak month</dt>
        <dd>{MONTHS_LONG[season.peakMonth - 1]}{#if season.secondPeak} <span class="muted">+ {MONTHS_SHORT[season.secondPeak - 1]}</span>{/if}</dd>
        <dd class="sub">season {seasonText}</dd>
      </div>
      <div>
        <dt class="eyebrow">Record month</dt>
        {#if a.records.topMonths[0]}
          <dd>{monthLong(a.records.topMonths[0].m)}</dd>
          <dd class="sub"><span class="num">{fmtNum(a.records.topMonths[0].value)}</span> AFCD-M · {fmtRatio(a.records.topMonths[0].ratio)} normal</dd>
        {:else}<dd>—</dd>{/if}
      </div>
    </dl>
  </section>
{/if}

<style>
  .strip { padding: var(--sec-pad); border-bottom: 1px solid var(--rule); }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
  .when { font-size: var(--fs-xl); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .in-progress { margin: 4px 0 0; }
  .answer { display: grid; grid-template-columns: auto 1fr; gap: 8px 32px; align-items: end; margin-top: 14px; }
  .hero { display: grid; gap: 4px; }
  .big { font-size: var(--fs-hero); line-height: 0.88; font-weight: 600; letter-spacing: -0.05em; color: var(--ink); }
  .x { font-size: 0.55em; color: var(--accent); margin-left: 2px; }
  .cap { color: var(--ink-2); font-size: var(--fs-base); }
  .facts { display: grid; gap: 10px; justify-items: start; padding-bottom: 4px; }
  .sentence { font-size: var(--fs-lg); line-height: 1.4; margin: 0; }
  .sentence strong { font-weight: 600; }
  .detail { margin: 0; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 24px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); }
  .kpis > div { padding: 0 14px; border-left: 1px solid var(--rule); }
  .kpis > div:first-child { padding-left: 0; border-left: 0; }
  dt { margin-bottom: 4px; }
  dd { margin: 0; font-size: var(--fs-base); }
  dd.sub { font-size: var(--fs-sm); color: var(--ink-3); margin-top: 2px; }
  .arrow { font-size: var(--fs-lg); }
  .arrow.up { color: var(--serious); }
  .arrow.down { color: var(--info); }
  @media (max-width: 720px) {
    .answer { grid-template-columns: 1fr; }
    .kpis { grid-template-columns: 1fr 1fr; gap: 14px 0; }
    .kpis > div:nth-child(3) { padding-left: 0; border-left: 0; }
  }
</style>
