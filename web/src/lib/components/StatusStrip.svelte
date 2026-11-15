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
</script>

{#if s}
  <section class="strip" aria-labelledby="status-h">
    <div class="top">
      <h2 id="status-h" class="when">
        {monthLong(m)}
        {#if s.isCurrent}<span class="tag now">Latest month</span>{/if}
        {#if s.provisional}<span class="tag prov" title="Near-real-time data; values may still change">Provisional</span>{/if}
      </h2>
      {#if !s.isCurrent}
        <button class="btn" onclick={() => session.setFocus(null)}>Back to {MONTHS_SHORT[a.current.month - 1]} {a.current.year}</button>
      {/if}
    </div>

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
  .strip { padding: 22px 0 18px; border-bottom: 1px solid var(--rule); }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .when { font-size: 1.05rem; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tag { font-size: 0.68rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 3px; }
  .tag.now { color: var(--accent-ink); box-shadow: inset 0 0 0 1px var(--accent); }
  .tag.prov {
    color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--rule-strong);
    background: repeating-linear-gradient(135deg, transparent 0 4px, var(--surface-3) 4px 6px);
  }
  .answer { display: grid; grid-template-columns: auto 1fr; gap: 6px 28px; align-items: end; margin-top: 10px; }
  .hero { display: grid; }
  .big { font-size: clamp(3.4rem, 7vw, 5.2rem); line-height: 0.92; font-weight: 600; letter-spacing: -0.05em; color: var(--ink); }
  .x { font-size: 0.55em; color: var(--accent); margin-left: 2px; }
  .cap { color: var(--ink-2); font-size: 0.95rem; }
  .facts { display: grid; gap: 8px; justify-items: start; padding-bottom: 4px; }
  .sentence { font-size: 1.12rem; margin: 0; }
  .sentence strong { font-weight: 600; }
  .detail { margin: 0; }
  .level { display: inline-flex; align-items: center; gap: 6px; font-size: 0.86rem; font-weight: 600; padding: 3px 10px 3px 8px; border-radius: 4px; border: 1px solid currentColor; }
  .level.critical { color: var(--critical); }
  .level.serious { color: var(--serious); }
  .level.warning { color: var(--warning); }
  .level.info { color: var(--info); }
  .level.neutral { color: var(--ink-2); }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 20px 0 0; }
  .kpis > div { padding: 0 14px; border-left: 1px solid var(--rule); }
  .kpis > div:first-child { padding-left: 0; border-left: 0; }
  dt { margin-bottom: 3px; }
  dd { margin: 0; font-size: 0.95rem; }
  dd.sub { font-size: 0.78rem; color: var(--ink-3); margin-top: 2px; }
  .arrow { font-size: 1.05rem; }
  .arrow.up { color: var(--serious); }
  .arrow.down { color: var(--info); }
  @media (max-width: 720px) {
    .answer { grid-template-columns: 1fr; }
    .kpis { grid-template-columns: 1fr 1fr; gap: 14px 0; }
    .kpis > div:nth-child(3) { padding-left: 0; border-left: 0; }
  }
</style>
