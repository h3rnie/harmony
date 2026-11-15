<script lang="ts">
  // In-place glossary: a dotted-underlined word that opens a short plain-language explanation.
  // Keyboard: Tab to the word, Enter/Space toggles, Escape closes. Mouse: hover previews, click pins.
  import type { Snippet } from 'svelte'
  import { GLOSSARY, type TermId } from './glossary'
  import { session } from '../session.svelte'

  let { id, extra, children }: { id: TermId; extra?: string; children?: Snippet } = $props()

  // Units lens: every bare unit label follows the record's unit (AFCD-M, or AFCD-V under the VIIRS lens).
  const entry = $derived(GLOSSARY[id === 'afcdm' && session.unitLabel === 'AFCD-V' ? 'afcdv' : id])
  const uid = `term-${Math.random().toString(36).slice(2, 9)}`
  let pinned = $state(false)
  let hovering = $state(false)
  const open = $derived(pinned || hovering)
  let btn = $state<HTMLButtonElement>()
  let pos = $state({ left: 0, top: 0, above: false })
  let hoverTimer: ReturnType<typeof setTimeout> | undefined

  function place() {
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const w = Math.min(320, innerWidth - 24)
    const left = Math.max(12, Math.min(innerWidth - w - 12, r.left))
    const above = r.bottom + 170 > innerHeight && r.top > 190
    pos = { left, top: above ? r.top - 6 : r.bottom + 6, above }
  }
  function toggle() {
    pinned = !pinned
    hovering = false
    if (pinned) place()
  }
  function enter(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => { place(); hovering = true }, 180)
  }
  function leave() {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => (hovering = false), 120)
  }

  $effect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (btn?.contains(t) || document.getElementById(uid)?.contains(t)) return
      pinned = false; hovering = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { pinned = false; hovering = false; btn?.focus() }
    }
    const onMove = () => place()
    addEventListener('pointerdown', onDown, true)
    addEventListener('keydown', onKey)
    addEventListener('scroll', onMove, { passive: true, capture: true })
    addEventListener('resize', onMove)
    return () => {
      removeEventListener('pointerdown', onDown, true)
      removeEventListener('keydown', onKey)
      removeEventListener('scroll', onMove, true)
      removeEventListener('resize', onMove)
    }
  })
</script>

<span class="term" data-term={id}><button
    bind:this={btn}
    type="button"
    class="t"
    aria-expanded={open}
    aria-controls={uid}
    onclick={toggle}
    onpointerenter={enter}
    onpointerleave={leave}
  >{#if children}{@render children()}{:else}{entry.term}{/if}</button>{#if open}<span
      id={uid}
      class="pop"
      class:above={pos.above}
      role="note"
      style:left={`${pos.left}px`}
      style:top={`${pos.top}px`}
      onpointerenter={() => clearTimeout(hoverTimer)}
      onpointerleave={leave}
    ><strong>{entry.term}.</strong> {entry.text}{#if extra} {extra}{/if}</span>{/if}</span>

<style>
  .term { display: inline; }
  .t {
    display: inline; padding: 0; margin: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit;
    text-transform: inherit; cursor: help; text-decoration: underline dotted; text-decoration-color: var(--ink-3);
    text-underline-offset: 3px; text-decoration-thickness: 1.5px;
  }
  .t:hover, .t[aria-expanded='true'] { text-decoration-color: var(--ink); }
  .t:focus-visible { outline-offset: 1px; }
  .pop {
    position: fixed; z-index: 60; width: min(320px, calc(100vw - 24px)); display: block;
    background: var(--surface); color: var(--ink-2); border: 1px solid var(--rule-strong); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 10px 12px; font-family: var(--font-ui); font-size: var(--fs-sm); font-weight: 400;
    line-height: 1.5; letter-spacing: normal; text-transform: none; text-align: left; white-space: normal;
  }
  .pop.above { transform: translateY(-100%); }
  .pop strong { color: var(--ink); font-weight: 600; }
</style>
