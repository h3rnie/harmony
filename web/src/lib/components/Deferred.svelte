<script lang="ts">
  // Mounts its content after first paint: as soon as the browser is idle, or earlier if it scrolls near the viewport.
  // Keeps the answer's first paint light (charts below the first screen are not built until then) without hiding
  // anything for long: everything is in the page within a moment, so find-in-page and the section index still work.
  import { onMount, type Snippet } from 'svelte'

  let { minHeight = 400, children }: { minHeight?: number; children: Snippet } = $props()

  let ready = $state(false)
  let el = $state<HTMLDivElement>()

  onMount(() => {
    const show = () => { ready = true }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) show() }, { rootMargin: '600px 0px' })
    if (el) io.observe(el)
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
    const id = ric ? ric(show, { timeout: 1200 }) : setTimeout(show, 300)
    return () => {
      io.disconnect()
      const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
      if (ric && cic) cic(id as number); else clearTimeout(id as ReturnType<typeof setTimeout>)
    }
  })
</script>

{#if ready}
  {@render children()}
{:else}
  <div bind:this={el} class="pending" style:min-height={`${minHeight}px`} aria-hidden="true"></div>
{/if}

<style>
  .pending { border-bottom: 1px solid var(--rule); }
</style>
