<script lang="ts">
  // "How we know": the method material in one closing chapter, after the user-question sections.
  // Order: the seam (lead visual) → sensor fusion → orbit-drift fingerprint → conformal uncertainty → ML lab → method.
  // The three middle subsections are global evidence read from validation.json (FusionEvidence, DriftEvidence,
  // ConformalEvidence); a snippet passed for one of them renders in its place instead.
  import type { Snippet } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import SeamView from './SeamView.svelte'
  import MethodLab from './MethodLab.svelte'
  import MethodSection from './MethodSection.svelte'
  import FusionEvidence from './FusionEvidence.svelte'
  import DriftEvidence from './DriftEvidence.svelte'
  import ConformalEvidence from './ConformalEvidence.svelte'

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
  <!-- Global evidence (independent of the selected area); a passed snippet overrides the default subsection. -->
  <div class="sub" id="fusion">{#if fusion}{@render fusion(a)}{:else}<FusionEvidence />{/if}</div>
  <div class="sub" id="drift">{#if drift}{@render drift(a)}{:else}<DriftEvidence />{/if}</div>
  <div class="sub" id="conformal">{#if conformal}{@render conformal(a)}{:else}<ConformalEvidence />{/if}</div>
  <MethodLab {a} />
  <MethodSection chapter />
</section>

<style>
  .chapter { padding: 28px 0 0; border-bottom: 1px solid var(--rule); }
  .chapter > :global(section:last-child) { border-bottom: 0; }
  .sub { border-bottom: 1px solid var(--rule); }
  .sub:empty { display: none; }
</style>
