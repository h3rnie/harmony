<script lang="ts">
  // "Years and normal" popover in the calendar header (replaces the old sticky controls bar).
  // Defaults suit almost everyone, so the settings sit one click away, next to the view they change.
  import { tick, type Snippet } from 'svelte'
  import { session } from '../session.svelte'
  import YearRange from './YearRange.svelte'
  import Term from './Term.svelte'
  import type { Dn } from '../urlState'

  let {
    units,
  }: {
    /** Insertion point: the units lens (MODIS-equivalent | VIIRS-equivalent) renders here when provided. */
    units?: Snippet
  } = $props()

  let open = $state(false)
  let btn = $state<HTMLButtonElement>()
  let panel = $state<HTMLDivElement>()

  const span = $derived(session.yearSpan)
  const range = $derived<[number, number]>(session.rangeYears ?? span)
  const baseline = $derived(session.effectiveBaseline)
  const custom = $derived(session.rangeYears != null || session.baseline != null || session.dn !== 'both')
  const summary = $derived(
    [session.rangeYears ? `${range[0]}–${range[1]}` : null, session.baseline ? `normal ${baseline[0]}–${baseline[1]}` : null, session.dn !== 'both' ? `${session.dn} passes` : null]
      .filter(Boolean).join(' · '),
  )

  const DN: [Dn, string][] = [['both', 'Day and night'], ['day', 'Day only'], ['night', 'Night only']]

  function setRange(v: [number, number]) {
    session.setRange(v[0] === span[0] && v[1] === span[1] ? null : v)
  }
  function setBaseline(v: [number, number]) {
    if (v[1] - v[0] < 4) v = [v[0], Math.min(span[1], v[0] + 4)]
    session.setBaseline(v)
  }
  function reset() {
    session.setRange(null); session.setBaseline(null); session.setDn('both')
  }
  async function toggle() {
    open = !open
    if (open) { await tick(); panel?.querySelector<HTMLElement>('input[type=range]')?.focus() }
  }
  function close(refocus = true) {
    open = false
    if (refocus) btn?.focus()
  }

  $effect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel?.contains(t) || btn?.contains(t) || (t as Element).closest?.('.pop')) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.term .pop')) close() }
    addEventListener('pointerdown', onDown, true)
    addEventListener('keydown', onKey)
    return () => { removeEventListener('pointerdown', onDown, true); removeEventListener('keydown', onKey) }
  })
</script>

<div class="settings">
  <button bind:this={btn} class="btn gear" aria-expanded={open} aria-controls="analysis-settings" onclick={toggle}>
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.6 3.2.9-.8-1-2.2-1.2.2a5 5 0 0 0-.9-.9l.2-1.2-2.2-1-.8.9a5 5 0 0 0-1.2 0L6.6 1l-2.2 1 .2 1.2a5 5 0 0 0-.9.9l-1.2-.2-1 2.2.9.8a5 5 0 0 0 0 1.2l-.9.8 1 2.2 1.2-.2c.3.3.6.6.9.9l-.2 1.2 2.2 1 .8-.9a5 5 0 0 0 1.2 0l.8.9 2.2-1-.2-1.2c.3-.3.6-.6.9-.9l1.2.2 1-2.2-.9-.8a5 5 0 0 0 0-1.2Z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" /></svg>
    Years and normal
    {#if custom}<span class="dot" aria-hidden="true"></span><span class="sr-only">(changed: {summary})</span>{/if}
  </button>

  {#if open}
    <div bind:this={panel} id="analysis-settings" class="panel" role="dialog" aria-labelledby="as-h">
      <div class="ph">
        <h3 id="as-h">Years and normal</h3>
        <button class="btn icon" aria-label="Close" onclick={() => close()}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </div>

      <div class="field">
        <span class="fl" id="as-years">Years shown</span>
        <YearRange min={span[0]} max={span[1]} value={range} label="Years shown" onchange={setRange} />
      </div>
      <div class="field">
        <span class="fl" id="as-base">Years that define <Term id="normal">normal</Term></span>
        <YearRange min={span[0] + 1} max={span[1]} value={baseline} label="Baseline years" onchange={setBaseline} />
        <p class="help">Normal is the median of these years for the same month. Default 2003–2022.</p>
      </div>

      <details class="more">
        <summary>Advanced</summary>
        <div class="more-body">
          <div class="field">
            <span class="fl" id="as-dn"><Term id="overpass">Satellite pass</Term></span>
            <div class="seg" role="radiogroup" aria-labelledby="as-dn">
              {#each DN as [v, l] (v)}
                <button role="radio" aria-checked={session.dn === v} onclick={() => session.setDn(v)}>{l}</button>
              {/each}
            </div>
          </div>
          {#if units}<div class="field">{@render units()}</div>{/if}
        </div>
      </details>

      {#if custom}<button class="btn reset" onclick={reset}>Reset to defaults</button>{/if}
    </div>
  {/if}
</div>

<style>
  .settings { position: relative; }
  .gear { gap: 6px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--info); }
  .panel {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: min(360px, calc(100vw - 32px));
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 12px 14px 14px; display: grid; gap: 14px;
  }
  .ph { display: flex; justify-content: space-between; align-items: center; }
  h3 { font-size: var(--fs-base); }
  .icon { width: 30px; min-height: 30px; padding: 0; justify-content: center; }
  .field { display: grid; gap: 4px; }
  .fl { font-size: var(--fs-sm); color: var(--ink-2); }
  .help { font-size: var(--fs-sm); color: var(--ink-3); margin: 0; }
  details.more { margin: 0; }
  .reset { justify-self: start; }
</style>
