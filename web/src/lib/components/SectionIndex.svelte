<script module lang="ts">
  export interface IndexItem { id: string; label: string; title?: string }
</script>

<script lang="ts">
  // Sticky "On this page" index for the guided scroll, with scroll-spy.
  // Buttons, not #anchors: the URL hash carries the view state and must not change when jumping.
  // Keyboard: Tab into the list, Left/Right/Home/End move between entries, Enter jumps and moves focus to the section title.
  import { onMount, tick } from 'svelte'
  import { themeState } from '../theme.svelte'

  let { items }: { items: IndexItem[] } = $props()

  let active = $state<string | null>(null)
  let nav = $state<HTMLElement>()
  let list = $state<HTMLUListElement>()

  // Sticky stack above the content = header + this index. The index publishes its real height as --index-h, and
  // app.css derives every jump target's scroll-margin-top from it, so native #anchors, scrollIntoView and the
  // jumps below all stop at the same line, at any breakpoint.
  function offset(): number {
    const hdr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 52
    return hdr + (nav?.offsetHeight ?? 44) + 24
  }
  const root = document.documentElement

  function spy() {
    const y = offset() + 40
    let cur: string | null = null
    for (const it of items) {
      const el = document.getElementById(it.id)
      if (!el) continue
      if (el.getBoundingClientRect().top <= y) cur = it.id
    }
    // At the very bottom the last short sections can never reach the line: mark the last one.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = items.at(-1)?.id ?? cur
    if (cur !== active) {
      active = cur
      tick().then(() => {
        const b = list?.querySelector<HTMLElement>('[aria-current="true"]')
        if (b && list) {
          const lr = list.getBoundingClientRect(), br = b.getBoundingClientRect()
          if (br.left < lr.left || br.right > lr.right) list.scrollLeft += br.left - lr.left - 16
        }
      })
    }
  }

  onMount(() => {
    let raf = 0
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(spy) }
    addEventListener('scroll', on, { passive: true })
    addEventListener('resize', on)
    const ro = new ResizeObserver(on)
    ro.observe(document.body)
    const publish = () => { if (nav) root.style.setProperty('--index-h', `${nav.offsetHeight}px`) }
    // Write the variable on the next frame, never inside the observer callback (that is a ResizeObserver loop).
    let raf2 = 0
    const ro2 = new ResizeObserver(() => { cancelAnimationFrame(raf2); raf2 = requestAnimationFrame(publish) })
    if (nav) ro2.observe(nav)
    publish()
    on()
    return () => {
      removeEventListener('scroll', on); removeEventListener('resize', on); ro.disconnect(); ro2.disconnect(); cancelAnimationFrame(raf); cancelAnimationFrame(raf2)
      root.style.removeProperty('--index-h')
    }
  })

  function jump(id: string) {
    const el = document.getElementById(id)
    if (!el) return
    const top = el.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(el).scrollMarginTop) || offset() - 12)
    scrollTo({ top, behavior: themeState.reducedMotion ? 'auto' : 'smooth' })
    const h = el.querySelector<HTMLElement>('h2, h3') ?? el
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
    h.focus({ preventScroll: true })
  }

  function onKey(e: KeyboardEvent) {
    const btns = [...(list?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let j = i
    if (e.key === 'ArrowRight') j = Math.min(btns.length - 1, i + 1)
    else if (e.key === 'ArrowLeft') j = Math.max(0, i - 1)
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = btns.length - 1
    else return
    e.preventDefault()
    btns[j].focus()
  }
</script>

<nav class="index" aria-label="On this page" bind:this={nav}>
  <span class="lbl" aria-hidden="true">On this page</span>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <ul bind:this={list} onkeydown={onKey}>
    {#each items as it (it.id)}
      <li>
        <button aria-current={active === it.id ? 'true' : undefined} title={it.title} onclick={() => jump(it.id)}>{it.label}</button>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .index {
    position: sticky; top: var(--header-h); z-index: 12;
    display: flex; align-items: center; gap: 12px; margin: 0 calc(-1 * clamp(16px, 3vw, 40px));
    padding: 0 clamp(16px, 3vw, 40px);
    background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(8px);
    border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule);
  }
  .lbl { flex: none; font-size: var(--fs-sm); color: var(--ink-3); white-space: nowrap; }
  ul {
    list-style: none; margin: 0; padding: 0; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
    min-width: 0; flex: 1; mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
  }
  ul::-webkit-scrollbar { display: none; }
  li { flex: none; }
  button {
    display: inline-flex; align-items: center; min-height: 40px; padding: 0 8px; background: none; border: 0; cursor: pointer;
    color: var(--ink-3); font-size: var(--fs-base); white-space: nowrap; box-shadow: inset 0 -2px 0 transparent;
    transition: color 0.15s, box-shadow 0.15s;
  }
  button:hover { color: var(--ink); }
  button[aria-current='true'] { color: var(--ink); box-shadow: inset 0 -2px 0 var(--ink-2); }
  button:focus-visible { outline-offset: -3px; }
  @media (max-width: 1440px) { .lbl { display: none; } }
  @media (max-width: 900px) {
    button { min-height: 44px; }
  }
</style>
