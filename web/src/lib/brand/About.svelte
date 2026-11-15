<script lang="ts">
  // About / credits: one of the few human moments (patch, mission, dedication). Opened by `harmony:open-about`.
  import { onMount } from 'svelte'
  import Patch from './Patch.svelte'
  import { AUTHOR, CHALLENGE, DEDICATION, EVENT, MISSION, SOURCE_URL, TAGLINE, openMethod } from './copy'
  import { FIRMS_ACK } from '../config'
  import { themeState } from '../theme.svelte'

  let dlg: HTMLDialogElement

  // Public source link (build-time, optional). Only http(s) URLs are linked; anything else shows the text alone.
  const sourceUrl = SOURCE_URL

  onMount(() => {
    const show = () => { if (!dlg.open) dlg.showModal() }
    addEventListener('harmony:open-about', show)
    return () => removeEventListener('harmony:open-about', show)
  })

  function close() { dlg.close() }
  function toMethod() {
    close()
    openMethod(!themeState.reducedMotion)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dlg}
  class="about"
  aria-labelledby="about-h"
  onclick={(e) => { if (e.target === dlg) close() }}
>
  <div class="inner">
      <button class="btn close" onclick={close} aria-label="Close About">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </button>
      <div class="patch-col">
        <Patch size="100%" label="Harmony mission patch: Ad astra per aspera" />
      </div>
      <div class="text">
        <p class="eyebrow">About</p>
        <h2 id="about-h" class="wm">Harmony</h2>
        <p class="tg">{TAGLINE}</p>
        <p class="mission">{MISSION}</p>
        <p class="ded">{DEDICATION}</p>

        <dl class="facts">
          <div>
            <dt class="eyebrow">Built by</dt>
            <dd><a href={AUTHOR.url} target="_blank" rel="author noopener">{AUTHOR.name}</a> · {AUTHOR.place}</dd>
          </div>
          <div>
            <dt class="eyebrow">Event</dt>
            <dd>{EVENT} — {CHALLENGE}</dd>
          </div>
          <div>
            <dt class="eyebrow">Data</dt>
            <dd class="fine">{FIRMS_ACK} Basemap © OpenFreeMap, © OpenStreetMap contributors.</dd>
          </div>
          <div>
            <dt class="eyebrow">Method</dt>
            <dd>Detections, not burned area; recent months are provisional. <button class="link" onclick={toMethod}>Read the method and its caveats</button></dd>
          </div>
        </dl>
        <p class="indep">An independent entry to {EVENT}. Not affiliated with or endorsed by NASA.</p>
        <p class="indep src">
          {#if sourceUrl}<a href={sourceUrl} target="_blank" rel="noopener">Source code: AGPL-3.0-only</a>{:else}Source code: AGPL-3.0-only{/if}.
          The Harmony name, mark and patch are not covered by the code licence.
        </p>
      </div>
    </div>
</dialog>

<style>
  .about {
    width: min(860px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 0; overflow: auto;
    color: var(--ink); background: var(--bg); border: 1px solid var(--rule-strong); border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .about:focus-visible { outline: none; }
  .about::backdrop { background: var(--scrim); backdrop-filter: blur(3px); }
  .inner { position: relative; display: grid; grid-template-columns: 220px 1fr; gap: 36px; padding: 40px 40px 32px; align-items: start; }
  .patch-col { width: 220px; aspect-ratio: 1; }
  .close { position: absolute; top: 12px; right: 12px; width: 32px; padding: 0; justify-content: center; }
  .wm {
    font-family: var(--font-display); font-weight: 500; font-size: 1.9rem; line-height: 1;
    letter-spacing: var(--track-wordmark); text-transform: uppercase; margin: 6px 0 8px;
  }
  .tg {
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-sm); letter-spacing: 0.22em;
    text-transform: uppercase; color: var(--ink-2); margin: 0 0 18px;
  }
  .mission { font-size: var(--fs-lg); line-height: 1.55; max-width: 56ch; margin: 0 0 14px; }
  .ded {
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-base); letter-spacing: 0.04em;
    color: var(--ink-2); padding-left: 12px; border-left: 2px solid var(--accent); margin: 0 0 22px; max-width: 52ch;
  }
  .facts { margin: 0; display: grid; gap: 0; border-top: 1px solid var(--rule); }
  .facts > div { display: grid; grid-template-columns: 92px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--rule); }
  .facts dt { padding-top: 3px; }
  .facts dd { margin: 0; font-size: var(--fs-md); color: var(--ink-2); }
  .facts dd a { color: var(--ink); }
  .fine { font-size: var(--fs-sm) !important; color: var(--ink-3) !important; line-height: 1.5; }
  .link {
    background: none; border: 0; padding: 0; color: var(--ink); text-decoration: underline; text-decoration-color: var(--rule-strong);
    text-underline-offset: 3px; cursor: pointer; font-size: inherit;
  }
  .link:hover { text-decoration-color: var(--accent); }
  .indep { margin: 14px 0 0; font-size: var(--fs-sm); color: var(--ink-3); max-width: none; }
  .indep.src { margin-top: 4px; }
  .indep a { color: var(--ink-2); }

  @media (max-width: 700px) {
    .inner { grid-template-columns: 1fr; gap: 18px; padding: 28px 20px 22px; }
    .patch-col { width: 156px; justify-self: center; }
    .facts > div { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
