<script lang="ts">
  import { session } from '../session.svelte'
  import { PRESETS } from '../presets'
  import { MONTHS_SHORT } from '../format'
  import Patch from '../brand/Patch.svelte'
  import { MISSION } from '../brand/copy'
</script>

<section class="intro" aria-labelledby="intro-h">
  <button class="pulse-cta" onclick={() => dispatchEvent(new CustomEvent('harmony:open-pulse'))}>
    <span class="globe" aria-hidden="true"></span>
    <span class="cta-t">Watch 26 years of global fire seasons<span aria-hidden="true">&nbsp;→</span></span>
    <span class="cta-s">Every month since November 2000 on one globe, in one consistent unit. Click any place to analyse it.</span>
  </button>

  <div class="hero">
    <div class="patch"><Patch size="100%" label="Harmony mission patch: Ad astra per aspera" /></div>
    <div class="words">
      <p class="eyebrow">Burning-activity record · MODIS + VIIRS · 2000 to today</p>
      <h2 id="intro-h">Pick any area on Earth to see how it burns.</h2>
      <p class="lede">{MISSION}</p>
    </div>
  </div>

  <ol class="how">
    <li><span class="n num" aria-hidden="true">01</span><span><strong>Choose an area.</strong> Draw on the map, enter coordinates, or drop a GeoJSON file.</span></li>
    <li><span class="n num" aria-hidden="true">02</span><span><strong>Read the answer.</strong> This month against its normal, in words and numbers.</span></li>
    <li><span class="n num" aria-hidden="true">03</span><span><strong>Explore.</strong> Calendar, the 2012 seam, season, trend and outlook, then export.</span></li>
  </ol>

  <h3 class="eyebrow stories-h">Start with a story</h3>
  <div class="cards">
    {#each PRESETS as p (p.id)}
      <button class="card" onclick={() => session.setAoi({ rings: p.rings, shape: { kind: 'polygon' }, label: p.title, presetId: p.id })}>
        <span class="t">{p.title}</span>
        <span class="s">{p.subtitle}</span>
        <span class="f num">{p.focus.year ? `${MONTHS_SHORT[p.focus.month - 1]} ${p.focus.year}` : `${MONTHS_SHORT[p.focus.month - 1]}, latest`} <span aria-hidden="true">→</span></span>
      </button>
    {/each}
  </div>
</section>

<style>
  .intro { padding: 26px 0 28px; border-bottom: 1px solid var(--rule); }
  .pulse-cta {
    display: grid; grid-template-columns: auto 1fr; column-gap: 14px; align-items: center; width: 100%; text-align: left;
    margin: 0 0 30px; padding: 14px 16px; cursor: pointer; color: var(--ink);
    background: linear-gradient(100deg, var(--accent-soft), transparent 70%); border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--rule));
    border-radius: var(--radius); transition: border-color 0.15s, background 0.15s;
  }
  .pulse-cta:hover { border-color: var(--accent); background: linear-gradient(100deg, color-mix(in srgb, var(--accent) 22%, transparent), transparent 75%); }
  .globe {
    grid-row: span 2; width: 38px; height: 38px; border-radius: 50%;
    background: radial-gradient(circle at 62% 58%, #fca50a 0 9%, #dd513a 16%, transparent 34%), radial-gradient(circle at 34% 40%, #f98e09 0 7%, #bc3754 13%, transparent 28%), radial-gradient(circle at 40% 35%, var(--surface-3), var(--bg-2));
    box-shadow: 0 0 0 1px var(--rule-strong), 0 0 18px -4px var(--accent);
  }
  .cta-t { font-weight: 600; font-size: var(--fs-base); }
  .cta-s { color: var(--ink-3); font-size: var(--fs-md); }

  .hero { display: grid; grid-template-columns: 136px 1fr; gap: 28px; align-items: center; }
  .patch { width: 136px; aspect-ratio: 1; }
  h2 { font-size: var(--fs-2xl); letter-spacing: -0.03em; line-height: 1.1; margin: 8px 0 12px; max-width: 22ch; text-wrap: balance; }
  .lede { color: var(--ink-2); max-width: 60ch; font-size: var(--fs-base); line-height: 1.55; margin: 0; }

  .how {
    list-style: none; padding: 0; margin: 26px 0 26px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
  }
  .how li { display: grid; grid-template-columns: auto 1fr; gap: 10px; padding: 12px 16px 12px 0; font-size: var(--fs-md); color: var(--ink-2); line-height: 1.45; }
  .how li + li { padding-left: 16px; border-left: 1px solid var(--rule); }
  .how strong { color: var(--ink); font-weight: 600; }
  .how .n { color: var(--ink-3); font-size: var(--fs-sm); padding-top: 1px; }

  .stories-h { margin-bottom: 10px; font-weight: 500; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); }
  .card {
    display: grid; gap: 3px; text-align: left; padding: 14px; background: var(--bg); border: 0; cursor: pointer; color: var(--ink);
    transition: background 0.15s;
  }
  .card:hover { background: var(--surface-2); }
  .card:hover .f { color: var(--ink); }
  .card:focus-visible { outline-offset: -2px; }
  .t { font-weight: 600; }
  .s { color: var(--ink-3); font-size: var(--fs-md); }
  .f { color: var(--ink-3); font-size: var(--fs-sm); margin-top: 6px; transition: color 0.15s; }

  @media (max-width: 1100px) {
    .how { grid-template-columns: 1fr; }
    .how li { padding: 9px 0; }
    .how li + li { padding-left: 0; border-left: 0; border-top: 1px solid var(--rule); }
  }
  @media (max-width: 560px) {
    .hero { grid-template-columns: 88px 1fr; gap: 16px; }
    .patch { width: 88px; }
    .hero { align-items: center; }
    .words { display: contents; }
    .hero .eyebrow { display: none; }
    h2 { margin: 0; font-size: 1.5rem; }
    .lede { grid-column: 1 / -1; }
  }
</style>
