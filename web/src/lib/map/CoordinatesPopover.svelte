<script lang="ts">
  import { onMount } from 'svelte'
  import { bboxPolygon, circlePolygon, type Aoi } from '../geo'

  let { onsubmit, onclose }: { onsubmit: (aoi: Aoi) => void; onclose: () => void } = $props()

  let tab = $state<'point' | 'bbox'>('point')
  let lat = $state<number | null>(null)
  let lon = $state<number | null>(null)
  let km = $state<number | null>(50)
  let w = $state<number | null>(null), s = $state<number | null>(null), e = $state<number | null>(null), n = $state<number | null>(null)
  let error = $state<string | null>(null)
  let first: HTMLInputElement | undefined = $state()

  onMount(() => first?.focus())

  const ok = (v: number | null, lo: number, hi: number): v is number => v != null && Number.isFinite(v) && v >= lo && v <= hi

  function submit(ev: SubmitEvent) {
    ev.preventDefault()
    error = null
    if (tab === 'point') {
      if (!ok(lat, -85, 85)) return void (error = 'Latitude must be between −85 and 85.')
      if (!ok(lon, -180, 180)) return void (error = 'Longitude must be between −180 and 180.')
      if (!ok(km, 1, 2000)) return void (error = 'Radius must be between 1 and 2000 km.')
      onsubmit({ rings: circlePolygon(lon, lat, km), shape: { kind: 'circle', lon, lat, km }, label: `${km} km around ${lat.toFixed(2)}°, ${lon.toFixed(2)}°` })
    } else {
      if (!ok(w, -180, 180) || !ok(e, -180, 180)) return void (error = 'West and east must be between −180 and 180.')
      if (!ok(s, -85, 85) || !ok(n, -85, 85)) return void (error = 'South and north must be between −85 and 85.')
      if (!(e > w)) return void (error = 'East must be greater than west (boxes crossing the antimeridian are not supported).')
      if (!(n > s)) return void (error = 'North must be greater than south.')
      onsubmit({ rings: bboxPolygon(w, s, e, n), shape: { kind: 'bbox', w, s, e, n }, label: `Box ${w}°…${e}°, ${s}°…${n}°` })
    }
  }
</script>

<div class="pop" id="coords-pop" role="dialog" aria-label="Enter coordinates">
  <div class="head">
    <p class="eyebrow">Coordinates</p>
    <div class="seg" role="radiogroup" aria-label="Input type">
      <button type="button" role="radio" aria-checked={tab === 'point'} onclick={() => (tab = 'point')}>Point + radius</button>
      <button type="button" role="radio" aria-checked={tab === 'bbox'} onclick={() => (tab = 'bbox')}>Bounding box</button>
    </div>
  </div>
  <form onsubmit={submit} novalidate>
    {#if tab === 'point'}
      <div class="grid3">
        <label>Latitude<input bind:this={first} type="number" step="any" name="lat" bind:value={lat} placeholder="-9.5" required /></label>
        <label>Longitude<input type="number" step="any" name="lon" bind:value={lon} placeholder="-56.0" required /></label>
        <label>Radius km<input type="number" step="any" min="1" max="2000" name="km" bind:value={km} required /></label>
      </div>
    {:else}
      <div class="grid4">
        <label>West<input bind:this={first} type="number" step="any" name="west" bind:value={w} placeholder="-66" /></label>
        <label>South<input type="number" step="any" name="south" bind:value={s} placeholder="-15" /></label>
        <label>East<input type="number" step="any" name="east" bind:value={e} placeholder="-47" /></label>
        <label>North<input type="number" step="any" name="north" bind:value={n} placeholder="-3" /></label>
      </div>
    {/if}
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="button" class="btn" onclick={onclose}>Cancel</button>
      <button type="submit" class="btn primary">Analyse area</button>
    </div>
  </form>
</div>

<style>
  .pop {
    position: absolute; top: 58px; left: 12px; z-index: 4; width: min(400px, calc(100% - 24px));
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow); padding: 12px;
  }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .head .eyebrow { margin: 0; }
  .grid3, .grid4 { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); }
  .grid4 { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 480px) { .grid3, .grid4 { grid-template-columns: 1fr 1fr; } }
  label { display: grid; gap: 3px; font-size: var(--fs-sm); color: var(--ink-3); }
  input { width: 100%; font-family: var(--font-num); }
  .err { color: var(--critical); font-size: var(--fs-md); margin: 8px 0 0; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
