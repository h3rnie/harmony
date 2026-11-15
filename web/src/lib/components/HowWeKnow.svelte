<script lang="ts">
  // "How we know": the method material in one closing chapter, after the user-question sections.
  // Order: the seam (lead visual) → sensor fusion → orbit-drift fingerprint → conformal uncertainty → ML lab → method.
  // The three middle subsections are insertion points: pass a snippet and it renders in place; omit it and nothing shows.
  import type { Snippet } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import SeamView from './SeamView.svelte'
  import MethodLab from './MethodLab.svelte'
  import MethodSection from './MethodSection.svelte'

  let {
    a,
    fusion,
    drift,
    conformal,
  }: {
    a: Analysis
    /** Insertion point: sensor fusion (replaces the hard switch year). */
    fusion?: Snippet<[Analysis]>
    /** Insertion point: MODIS orbit-drift fingerprint. */
    drift?: Snippet<[Analysis]>
    /** Insertion point: conformal uncertainty. */
    conformal?: Snippet<[Analysis]>
  } = $props()
</script>

<section class="chapter" id="how" aria-labelledby="how-h">
  <h2 id="how-h" class="q-title">How we know</h2>
  <p class="lead">Two generations of satellites see fire differently. This is how Harmony joins them into one record, and how well that holds up.</p>

  <SeamView {a} />
  {#if fusion}<div class="sub" id="fusion">{@render fusion(a)}</div>{/if}
  {#if drift}<div class="sub" id="drift">{@render drift(a)}</div>{/if}
  {#if conformal}<div class="sub" id="conformal">{@render conformal(a)}</div>{/if}
  <MethodLab {a} />
  <MethodSection chapter />
</section>

<style>
  .chapter { padding: 28px 0 0; border-bottom: 1px solid var(--rule); }
  .chapter > :global(section:last-child) { border-bottom: 0; }
  .sub { border-bottom: 1px solid var(--rule); }
</style>
