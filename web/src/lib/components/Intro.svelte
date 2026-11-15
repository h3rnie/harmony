<script lang="ts">
  import { session } from '../session.svelte'
  import { PRESETS } from '../presets'
  import { MONTHS_SHORT } from '../format'
</script>

<section class="intro" aria-labelledby="intro-h">
  <p class="eyebrow">Burning-activity calendar · MODIS + VIIRS · 2000 → today</p>
  <h2 id="intro-h">Pick any area on Earth to see how it burns.</h2>
  <p class="lede">
    MODIS has watched fires since 2000; VIIRS since 2012 — and it sees three to ten times more hotspots.
    Harmony converts both into a single unit, so a month in 2003 and a month this year can be compared directly:
    which months burn, which years were extreme, and how <em>now</em> compares with normal.
  </p>
  <ol class="how">
    <li><span class="num">1</span>Draw a polygon, rectangle or circle on the map, enter coordinates, or drop a GeoJSON file.</li>
    <li><span class="num">2</span>Read the answer: this month versus its historical median, in words and numbers.</li>
    <li><span class="num">3</span>Explore the calendar, the 2012 seam, the season, trend and outlook — then export.</li>
  </ol>
  <h3 class="eyebrow">Start with a story</h3>
  <div class="cards">
    {#each PRESETS as p (p.id)}
      <button class="card" onclick={() => session.setAoi({ rings: p.rings, shape: { kind: 'polygon' }, label: p.title, presetId: p.id })}>
        <span class="t">{p.title}</span>
        <span class="s">{p.subtitle}</span>
        <span class="f num">{p.focus.year ? `${MONTHS_SHORT[p.focus.month - 1]} ${p.focus.year}` : `${MONTHS_SHORT[p.focus.month - 1]}, latest`} →</span>
      </button>
    {/each}
  </div>
</section>

<style>
  .intro { padding: 34px 0 28px; border-bottom: 1px solid var(--rule); }
  h2 { font-size: clamp(1.6rem, 3.2vw, 2.3rem); letter-spacing: -0.03em; margin: 8px 0 12px; max-width: 22ch; }
  .lede { color: var(--ink-2); max-width: 62ch; font-size: 1.02rem; }
  .how { list-style: none; padding: 0; margin: 18px 0 26px; display: grid; gap: 8px; color: var(--ink-2); }
  .how li { display: flex; gap: 12px; align-items: baseline; }
  .how .num { color: var(--accent-ink); font-size: 0.8rem; }
  h3 { margin-bottom: 10px; font-weight: 400; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
  .card {
    display: grid; gap: 3px; text-align: left; padding: 14px; background: var(--bg); border: 0; cursor: pointer; color: var(--ink);
    transition: background 0.15s;
  }
  .card:hover { background: var(--surface-2); }
  .card:hover .f { color: var(--accent-ink); }
  .t { font-weight: 600; }
  .s { color: var(--ink-3); font-size: 0.82rem; }
  .f { color: var(--ink-2); font-size: 0.76rem; margin-top: 6px; }
</style>
