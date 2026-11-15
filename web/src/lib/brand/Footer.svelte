<script lang="ts">
  import { FIRMS_ACK } from '../config'
  import { AUTHOR, COPYRIGHT_YEAR, openAbout, openMethod } from './copy'
  import { themeState } from '../theme.svelte'
</script>

<footer class="foot">
  <p class="copy">© {COPYRIGHT_YEAR} Harmony, by <a href={AUTHOR.url} target="_blank" rel="author noopener">{AUTHOR.name}</a>. All rights reserved.</p>
  <p class="links">
    <button class="lk" onclick={openAbout}>About</button>
    <span aria-hidden="true">·</span>
    <button class="lk" onclick={() => openMethod(!themeState.reducedMotion)}>Method</button>
  </p>
  <p class="ack">{FIRMS_ACK}</p>
  <p class="ack">NASA Space Apps 2026 entry · MODIS C6.1 and VIIRS 375 m active fires harmonized to MODIS-equivalent active-fire cell-days (AFCD-M). Basemap © OpenFreeMap, © OpenStreetMap contributors.</p>
</footer>

<style>
  .foot { padding: 28px 0 8px; max-width: 78ch; }
  .copy { font-size: var(--fs-md); color: var(--ink-2); margin: 0 0 6px; }
  .copy a { color: var(--ink); }
  .links { display: flex; gap: 8px; align-items: center; margin: 0 0 14px; color: var(--ink-faint); }
  .lk {
    background: none; border: 0; padding: 2px 0; cursor: pointer; color: var(--ink-3);
    font-family: var(--font-display); font-weight: 500; font-size: var(--fs-xs); letter-spacing: var(--track-label); text-transform: uppercase;
  }
  .lk:hover { color: var(--ink); }
  .ack { font-size: var(--fs-sm); color: var(--ink-3); line-height: 1.5; margin: 0 0 6px; }
</style>
