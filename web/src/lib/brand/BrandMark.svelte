<script lang="ts">
  // The stepped H. Left stem = MODIS (from 2000, ending), right stem = VIIRS (from 2012, running on),
  // crossbar = the overlap where the two are calibrated into one, ember tip = now.
  let { size = 24, label = '' }: { size?: number | string; label?: string } = $props()
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 48 48"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
  focusable="false"
>
  <rect x="9" y="13" width="7" height="28" fill="currentColor" />
  <rect x="32" y="13" width="7" height="22" fill="currentColor" />
  <rect x="16" y="21" width="16" height="6" fill="currentColor" />
  <rect class="tip" x="32" y="7" width="7" height="6" />
</svg>

<style>
  .mark { display: block; flex: none; }
  .tip { fill: var(--accent); }
</style>
