<script lang="ts">
  import { setUrlHash } from '../urlState'
  // Landing-page watchlist: where fire is most unusual in the latest month, from data/dist/watch.json.
  // Absent or still loading: renders nothing, so the landing stays as calm as before.
  import { onMount } from 'svelte'
  import { session } from '../session.svelte'
  import { fmtArea, monthIso, monthLong, parseMonthIso } from '../format'
  import { clusterAoi, outlineAreaKm2, watchDoc, watchInProgress, watchItems, type WatchDoc } from '../data/watch'

  let doc = $state.raw<WatchDoc | null>(null)
  onMount(() => {
    let live = true
    watchDoc().then((d) => { if (live) doc = d })
    return () => { live = false }
  })

  const m = $derived(doc ? parseMonthIso(doc.month) : null)
  const items = $derived(doc && m != null ? watchItems(doc, 6) : [])
  const win = $derived(doc?.windows.month)
  const nYears = $derived(win ? win.record_years[1] - win.record_years[0] + 1 : 0)
  /** Narrow screens show the top few; the rest sit behind "Show more" (CSS hides the extras only on narrow screens). */
  const FEW = 3
  let more = $state(false)

  function pick(i: number) {
    if (m == null) return
    session.setAoi(clusterAoi(items[i].c, m), { focusM: m })
  }
  function globe() {
    if (m == null) return
    const q = new URLSearchParams(location.hash.slice(1))
    q.set('view', 'pulse'); q.set('t', monthIso(m)); q.set('mode', 'anomaly')
    setUrlHash(`#${q.toString().replace(/%2C/g, ',')}`, 'push')
    dispatchEvent(new CustomEvent('harmony:open-pulse'))
  }
</script>

{#if doc && m != null && items.length}
  <section class="watch" aria-labelledby="watch-h">
    <div class="wh">
      <h3 id="watch-h">Where is fire most unusual?</h3>
      <p class="when">{monthLong(m)}{watchInProgress(doc) ? ' · month in progress' : win?.provisional ? ' · provisional' : ''}</p>
    </div>
    <ol class="list">
      {#each items as it, i (it.c.id)}
        <li class:extra={i >= FEW && !more}>
          <button class="item" onclick={() => pick(i)} aria-label={`${it.c.label}: ${it.ratio}, ${it.rank}, cluster of ${fmtArea(it.c.area_km2)}. Analyse the area around it, ${fmtArea(outlineAreaKm2(it.c))}, for ${monthLong(m)}.`}>
            <span class="lbl">{it.c.label}</span>
            <span class="x num">{it.ratio}</span>
            <span class="meta">{it.rank} · cluster <span class="num">{fmtArea(it.c.area_km2)}</span></span>
          </button>
        </li>
      {/each}
    </ol>
    {#if items.length > FEW}
      <button class="btn more" aria-expanded={more} onclick={() => (more = !more)}>{more ? 'Show fewer' : `Show ${items.length - FEW} more`}</button>
    {/if}
    <p class="foot">
      <button class="link" onclick={globe}>See all on the globe <span aria-hidden="true">→</span></button>
      <span class="cav">Opening one analyses the wider outline around it, so its ratio is lower; the list and the globe also use the hard-switch record without the orbit-drift correction. {watchInProgress(doc) ? `The month is in progress, so each is compared at its pace so far and not ranked` : `Ranked against ${nYears} years`}{win?.provisional ? '; recent months are provisional and may include unscreened static heat sources' : ''}.</span>
    </p>
  </section>
{/if}

<style>
  .watch { display: grid; gap: 8px; }
  .wh { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
  h3 { font-size: var(--fs-base); margin: 0; }
  .when { margin: 0; font-size: var(--fs-sm); color: var(--ink-3); }
  .list {
    list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 1px; background: var(--rule); border: 1px solid var(--rule);
  }
  .item {
    width: 100%; height: 100%; display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; align-items: baseline; align-content: start;
    text-align: left; padding: 8px 12px; background: var(--bg); border: 0; color: var(--ink); cursor: pointer;
    transition: background 0.15s;
  }
  .item:hover { background: var(--surface-2); }
  .item:focus-visible { outline-offset: -2px; }
  .lbl { font-weight: 600; font-size: var(--fs-sm); min-width: 0; }
  .x { font-size: var(--fs-sm); color: var(--ink); white-space: nowrap; }
  .meta { grid-column: 1 / -1; font-size: var(--fs-sm); color: var(--ink-3); }
  .more { display: none; justify-self: start; }
  @media (max-width: 600px) {
    .extra { display: none; }
    .more { display: inline-flex; }
  }
  .foot { margin: 0; max-width: none; font-size: var(--fs-sm); color: var(--ink-3); display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
  .link {
    background: none; border: 0; padding: 0; font: inherit; color: var(--ink-2); cursor: pointer; min-height: 24px;
    text-decoration: underline; text-decoration-color: var(--rule-strong); text-underline-offset: 3px;
  }
  .link:hover { color: var(--ink); text-decoration-color: var(--ink); }
</style>
