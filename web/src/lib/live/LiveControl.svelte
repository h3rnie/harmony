<script lang="ts">
  // Live detections, as one row of the map legend: a checkbox, the time window, and (when on) the dated key.
  // Off by default while the map shows a past month, so the map keeps one time frame unless asked.
  import { live, fmtAge, WINDOW_HOURS, type LiveWindow } from './store.svelte'
  import { AGE_COLORS, AGE_LABELS } from './liveLayer'
  import { themeState } from '../theme.svelte'
  import { session } from '../session.svelte'

  let { on, shown, onchange }: { on: boolean; shown: number; onchange: (on: boolean) => void } = $props()

  const OPTIONS: { v: Exclude<LiveWindow, 'off'>; label: string }[] = [
    { v: '24h', label: '24 h' }, { v: '48h', label: '48 h' }, { v: '7d', label: '7 days' },
  ]
  const colors = $derived(AGE_COLORS[themeState.theme])
  const win = $derived<Exclude<LiveWindow, 'off'>>(live.window === 'off' ? '24h' : live.window)
  const windowText = $derived(win === '7d' ? 'the last 7 days' : `the last ${WINDOW_HOURS[win]} h`)
  const age = $derived(live.latestT != null ? fmtAge(live.now / 1000 - live.latestT) : null)
  const today = $derived(new Date(live.now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))
</script>

{#if live.available && session.aoi}
  <div class="live" role="group" aria-label="Live detections on the map">
    <div class="row">
      <label class="chk">
        <input type="checkbox" name="live-dots" checked={on} onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)} />
        <span class="dot" aria-hidden="true"></span>Show live detections
      </label>
      {#if on}<select name="live-window" aria-label="Live detections time window" value={win} onchange={(e) => { live.setWindow((e.currentTarget as HTMLSelectElement).value as LiveWindow) }}>
        {#each OPTIONS as o (o.v)}<option value={o.v}>{o.label}</option>{/each}
      </select>{/if}
    </div>

    {#if on}
      {#if live.phase === 'idle' && !live.data}
        <p class="msg" role="status"><button class="link" onclick={() => live.request()}>Load live detections</button></p>
      {:else if live.phase === 'loading' && !live.data}
        <p class="msg" role="status">Loading live detections…</p>
      {:else if live.phase === 'too-large'}
        <p class="msg" role="status">Area too large for live data. Draw a smaller area.</p>
      {:else if live.phase === 'error' && !live.data}
        <p class="msg warn" role="status">{live.error} <button class="link" onclick={() => live.retry()}>Retry</button></p>
      {:else if live.data}
        <p class="msg">Dots: {windowText} to <span class="num">{today}</span>, provisional{#if age}; newest {age === 'just now' ? age : `${age} ago`}{/if}.</p>
        {#if shown === 0}
          <p class="msg" role="status">No detections in {windowText}.</p>
        {:else}
          <ul class="ages" aria-label="Detection age">
            {#each AGE_LABELS as l, k (l)}
              <li>
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r={k === 0 ? 5.5 : k === 1 ? 4.6 : 3} fill={colors.fill[k]} fill-opacity={k === 2 ? 0.55 : 1} stroke={colors.ring[k]} stroke-width={k === 0 ? 1.2 : k === 1 ? 0.6 : 0} />
                </svg>{l}
              </li>
            {/each}
          </ul>
        {/if}
        {#if live.data.stale}<p class="msg warn">Cached copy (FIRMS busy)</p>{/if}
      {/if}
    {/if}
  </div>
{/if}

<style>
  .live { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--rule); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: var(--fs-sm); color: var(--ink); min-height: 30px; }
  .chk input { margin: 0; width: 18px; height: 18px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  select { min-height: 28px; font-size: var(--fs-sm); padding: 0 4px; }
  .msg { margin: 6px 0 0; color: var(--ink-2); line-height: 1.4; font-size: var(--fs-sm); }
  .warn { color: var(--warning); }
  .link { background: none; border: 0; padding: 0; color: var(--ink); text-decoration: underline; cursor: pointer; font-size: inherit; }
  .ages { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: var(--fs-sm); color: var(--ink-2); }
  .ages li { display: inline-flex; align-items: center; gap: 4px; }
  @container map (max-width: 620px) { .ages { display: none; } }
</style>
