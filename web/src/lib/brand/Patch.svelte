<script lang="ts">
  // The line patch: a telemetry dial. One tick per fire season (the ember tick at the top is now, the record
  // runs clockwise from the first year), the dashed inner arc is the VIIRS era. The motto lives only here.
  import { session } from '../session.svelte'
  import { yearOf } from '../format'

  let { size = 200, label = '' }: { size?: number | string; label?: string } = $props()
  const uid = $props.id()

  const C = 120
  const meta = $derived(session.meta)
  const y0 = $derived(meta ? yearOf(meta.m_first) : 2000)
  const y1 = $derived(meta ? Math.max(yearOf(meta.m_first) + 1, yearOf(meta.m_last)) : 2026)
  const yV = $derived(meta ? yearOf(meta.viirs_start_m) : 2012)
  const n = $derived(y1 - y0 + 1)

  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180
    return [C + r * Math.sin(a), C - r * Math.cos(a)] as const
  }
  const ticks = $derived(
    Array.from({ length: n - 1 }, (_, i) => {
      const k = i + 1
      const year = y0 + k - 1
      const major = year === y0 || year === yV
      const [x1, yy1] = pt((k * 360) / n, 94)
      const [x2, yy2] = pt((k * 360) / n, major ? 84 : 89)
      return { k, major, x1, y1: yy1, x2, y2: yy2 }
    }),
  )
  const arc = $derived.by(() => {
    const kV = Math.min(n, Math.max(1, yV - y0 + 1))
    const deg = (kV * 360) / n
    const [sx, sy] = pt(deg, 79)
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A 79 79 0 ${360 - deg > 180 ? 1 : 0} 1 ${C} ${C - 79}`
  })
</script>

<svg
  class="patch"
  width={size}
  height={size}
  viewBox="0 0 240 240"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
  focusable="false"
>
  <defs>
    <path id="{uid}-top" d="M 19 120 A 101 101 0 0 1 221 120" />
    <path id="{uid}-bot" d="M 11 120 A 109 109 0 0 0 229 120" />
  </defs>
  <circle class="ground" cx="120" cy="120" r="118" stroke="currentColor" stroke-width="1.4" />
  <circle cx="120" cy="120" r="94" fill="none" stroke="currentColor" stroke-width="0.8" />
  <text class="ring" style="font-size:14px;letter-spacing:.5em" fill="currentColor"><textPath href="#{uid}-top" startOffset="51.1%" text-anchor="middle">HARMONY</textPath></text>
  <text class="ring" style="font-size:10.5px;letter-spacing:.32em" fill="currentColor"><textPath href="#{uid}-bot" startOffset="50.6%" text-anchor="middle">AD ASTRA PER ASPERA</textPath></text>
  <circle class="ember" cx="14" cy="120" r="1.8" />
  <circle class="ember" cx="226" cy="120" r="1.8" />
  {#each ticks as t (t.k)}
    <line x1={t.x1.toFixed(2)} y1={t.y1.toFixed(2)} x2={t.x2.toFixed(2)} y2={t.y2.toFixed(2)} stroke="currentColor" stroke-width={t.major ? 1.2 : 0.8} />
  {/each}
  <line class="ember-s" x1="120" y1="26" x2="120" y2="38" stroke-width="2.2" />
  <path d={arc} fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="1.5 2.5" opacity="0.8" />
  <g transform="translate(84 74) scale(1.5)">
    <rect x="9" y="13" width="7" height="28" fill="currentColor" />
    <rect x="32" y="13" width="7" height="22" fill="currentColor" />
    <rect x="16" y="21" width="16" height="6" fill="currentColor" />
    <rect class="ember" x="32" y="7" width="7" height="6" />
  </g>
  <text class="mono" x="121" y="158" text-anchor="middle" fill="currentColor">MODIS + VIIRS</text>
  <text class="mono" x="121" y="170" text-anchor="middle" fill="currentColor" opacity="0.7">{y0} – {y1}</text>
</svg>

<style>
  .patch { display: block; flex: none; color: var(--patch-ink, var(--ink)); }
  .ground { fill: var(--patch-ground, var(--bg)); }
  .ring { font-family: var(--font-display); font-weight: 500; }
  .mono { font-family: var(--font-num); font-size: 7.5px; letter-spacing: 0.2em; }
  .ember { fill: var(--accent); }
  .ember-s { stroke: var(--accent); }
</style>
