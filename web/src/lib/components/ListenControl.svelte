<script lang="ts">
  // "Listen": the record as sound, in the calendar header. An accessibility channel and a demonstration of what
  // harmonization does, not evidence. Pure mapping in lib/sound/mapping.ts; Web Audio in lib/sound/player.ts.
  import { onDestroy, tick } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { themeState } from '../theme.svelte'
  import { MONTHS_LONG, toM } from '../format'
  import { buildSchedule, transcript, SPEEDS, type ListenInput, type ListenMode, type Speed } from '../sound/mapping'
  import { SonificationPlayer } from '../sound/player'
  import { listen } from '../sound/listen.svelte'
  import Term from './Term.svelte'

  let { a }: { a: Analysis } = $props()

  const MODES: { v: ListenMode; label: string }[] = [
    { v: 'record', label: 'The record' },
    { v: 'seam', label: 'Raw, then harmonized' },
    { v: 'year', label: 'This year against normal' },
  ]
  const SPEED_LABEL: [Speed, string][] = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]

  let open = $state(false)
  let mode = $state<ListenMode>('record')
  let speed = $state<Speed>('normal')
  let withNormal = $state(false)
  let playing = $state(false)
  /** Paused part-way: the play button resumes. */
  let resumable = $state(false)
  let year = $state<number | null>(null)
  let part = $state<string | null>(null)
  let monthNow = $state<number | null>(null)
  /** Live-region text: year changes and part changes only, never every month. */
  let said = $state('')
  let error = $state('')
  let btn = $state<HTMLButtonElement>()
  let panel = $state<HTMLDivElement>()

  const years = $derived(a.calendar.years)
  const input = $derived<ListenInput>({
    months: a.months,
    harmonized: a.series.harmonized,
    naive: a.series.naive,
    median: a.climatology.median,
    range: [Math.max(a.months[0], toM(years[0], 1)), Math.min(a.months[a.months.length - 1], toM(years[years.length - 1], 12))],
    viirsStartM: session.meta?.viirs_start_m ?? toM(2012, 1),
    currentM: a.current.m,
    annual: a.annual,
  })
  const schedule = $derived(buildSchedule(mode, input, { msPerMonth: SPEEDS[speed], withNormal: mode === 'record' && withNormal }))
  const words = $derived(transcript(mode, input))
  const secs = $derived(Math.round(schedule.duration))
  const span = $derived(`${years[0]}–${years[years.length - 1]}`)
  const describe = $derived(
    mode === 'record'
      ? `The harmonized record, ${span}: one note per month, higher for more fire, with a soft tick at each new year.`
      : mode === 'seam'
        ? `First the raw satellite counts, ${span}, where the 2012 change of sensor is heard as a sudden step up; then the harmonized record over the same years, with no step.`
        : `${a.current.year} so far, month by month: a softer tone for the normal, then the month itself. Higher second note = above normal.`,
  )

  const player = new SonificationPlayer({
    onPosition: (e, y, p) => {
      monthNow = e?.m ?? null
      listen.m = themeState.reducedMotion ? null : (e?.m ?? null)
      if (p !== part) { part = p; if (p) said = `${p}${y ? `, ${y}` : ''}` }
      if (y !== year) { year = y; if (y != null && playing) said = `${y}` }
    },
    onEnd: () => { playing = false; resumable = false; listen.playing = false; listen.m = null; said = 'Finished' },
  })

  // Rebuild when the mode, speed or analysis changes; keep playing from the start of the new schedule.
  $effect(() => {
    const s = schedule
    const was = player.load(s)
    year = null; part = null; monthNow = null; resumable = false
    if (was) void start()
  })

  async function start() {
    error = ''
    try {
      await player.play()
      playing = true
      resumable = false
      listen.playing = true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      playing = false
    }
  }
  function pause() {
    player.pause()
    playing = false
    resumable = player.position > 0
    listen.playing = false
    listen.m = null
  }
  function stop() {
    player.stop()
    playing = false
    resumable = false
    listen.playing = false
    listen.m = null
    said = ''
  }
  // Starting from the panel closes it, so the calendar (and the moving highlight) stays visible; the header button
  // becomes Pause, with the year being played, and keeps focus.
  async function toggle() {
    if (playing) { pause(); return }
    await start()
    if (playing && open) close(true)
  }

  // Stop when the place changes, the page is hidden or left, or the Global pulse opens.
  $effect(() => {
    void session.aoi
    return () => stop()
  })
  $effect(() => {
    const onVis = () => { if (document.hidden && playing) pause() }
    const onLeave = () => stop()
    addEventListener('visibilitychange', onVis)
    addEventListener('pagehide', onLeave)
    addEventListener('harmony:open-pulse', onLeave)
    addEventListener('hashchange', onLeave)
    return () => {
      removeEventListener('visibilitychange', onVis)
      removeEventListener('pagehide', onLeave)
      removeEventListener('harmony:open-pulse', onLeave)
      removeEventListener('hashchange', onLeave)
    }
  })
  onDestroy(() => { void player.dispose(); listen.playing = false; listen.m = null })

  // ---- popover
  async function openPanel() {
    open = !open
    if (open) { await tick(); panel?.querySelector<HTMLElement>('[role=radio][aria-checked=true]')?.focus() }
  }
  function close(refocus = true) { open = false; if (refocus) btn?.focus() }
  function onHeader() { if (playing && !open) pause(); else openPanel() }
  $effect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel?.contains(t) || btn?.contains(t) || (t as Element).closest?.('.pop')) return
      close(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.term .pop')) close() }
    addEventListener('pointerdown', onDown, true)
    addEventListener('keydown', onKey)
    return () => { removeEventListener('pointerdown', onDown, true); removeEventListener('keydown', onKey) }
  })
  // Arrow keys move within a radio group (roving focus), as in a native radio group.
  function radioKeys(e: KeyboardEvent, list: string[], cur: string, set: (v: string) => void) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const v = list[(list.indexOf(cur) + d + list.length) % list.length]
    const group = (e.currentTarget as HTMLElement).parentElement
    set(v)
    tick().then(() => group?.querySelector<HTMLElement>('[aria-checked=true]')?.focus())
  }
  const readout = $derived(
    monthNow != null ? `${MONTHS_LONG[monthNow % 12]} ${Math.floor(monthNow / 12) + 2000}` : year != null ? String(year) : '',
  )
</script>

<div class="listen">
  <button bind:this={btn} class="btn head" class:on={playing} aria-expanded={open} aria-controls="listen-panel"
    aria-label={playing && !open ? `Pause the sound (now ${readout || 'playing'})` : undefined} onclick={onHeader}>
    {#if playing}
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" /></svg>
      <span class="num">{year ?? '…'}</span>
    {:else}
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
      Listen
    {/if}
  </button>

  {#if open}
    <div bind:this={panel} id="listen-panel" class="panel" role="dialog" aria-labelledby="ls-h">
      <div class="ph">
        <h3 id="ls-h">Hear the record</h3>
        <button class="btn icon" aria-label="Close" onclick={() => close()}>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
      </div>

      <div class="field">
        <span class="fl" id="ls-mode">What to play</span>
        <div class="modes" role="radiogroup" aria-labelledby="ls-mode">
          {#each MODES as md (md.v)}
            <button role="radio" aria-checked={mode === md.v} tabindex={mode === md.v ? 0 : -1}
              onclick={() => (mode = md.v)}
              onkeydown={(e) => radioKeys(e, MODES.map((x) => x.v), mode, (v) => (mode = v as ListenMode))}>{md.label}</button>
          {/each}
        </div>
        <p class="desc" id="ls-desc">{describe}{schedule.note && mode === 'seam' ? ` ${schedule.note}` : ''} <span class="muted">About {secs} s.</span></p>
      </div>

      <div class="row">
        <div class="field">
          <span class="fl" id="ls-speed">Speed</span>
          <div class="seg" role="radiogroup" aria-labelledby="ls-speed">
            {#each SPEED_LABEL as [v, l] (v)}
              <button role="radio" aria-checked={speed === v} tabindex={speed === v ? 0 : -1}
                onclick={() => (speed = v)}
                onkeydown={(e) => radioKeys(e, SPEED_LABEL.map((x) => x[0]), speed, (x) => (speed = x as Speed))}>{l}</button>
            {/each}
          </div>
        </div>
        {#if mode === 'record'}
          <label class="chk"><input type="checkbox" bind:checked={withNormal} /> Play the normal before each month</label>
        {/if}
      </div>

      <div class="transport">
        <button class="btn primary play" onclick={toggle} aria-describedby="ls-desc">
          {#if playing}
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" /></svg> Pause
          {:else}
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg> {resumable ? 'Resume' : 'Play'}
          {/if}
        </button>
        <button class="btn" onclick={stop} disabled={!playing && !resumable}>Stop</button>
        <span class="now num" aria-hidden="true">{part && mode === 'seam' ? `${part.split(' (')[0]} · ` : ''}{readout}</span>
      </div>
      {#if error}<p class="err" role="alert">Sound could not start: {error}</p>{/if}

      <p class="help"><Term id="hearing">What am I hearing?</Term> · The sound is an aid and a demonstration, not a measurement. The numbers and the text version below are the record.</p>
      <details class="more">
        <summary>Text version</summary>
        <div class="more-body">
          {#each words as w (w)}<p>{w}</p>{:else}<p>Nothing to describe for these years.</p>{/each}
        </div>
      </details>
    </div>
  {/if}
  <span class="sr-only" aria-live="polite" aria-atomic="true">{said}</span>
</div>

<style>
  .listen { position: relative; }
  .head { gap: 6px; }
  .head.on { color: var(--ink); border-color: var(--ink-3); }
  .panel {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; width: min(380px, calc(100vw - 32px));
    background: var(--surface); border: 1px solid var(--rule-strong); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 12px 14px 14px; display: grid; gap: 12px;
  }
  .ph { display: flex; justify-content: space-between; align-items: center; }
  h3 { font-size: var(--fs-base); }
  .icon { width: 30px; min-height: 30px; padding: 0; justify-content: center; }
  .field { display: grid; gap: 4px; }
  .fl { font-size: var(--fs-sm); color: var(--ink-2); }
  .modes { display: grid; border: 1px solid var(--rule-strong); border-radius: var(--radius); overflow: hidden; }
  .modes button {
    text-align: left; min-height: 32px; padding: 4px 10px; border: 0; border-bottom: 1px solid var(--rule); background: transparent;
    color: var(--ink-2); cursor: pointer; font-size: var(--fs-sm);
  }
  .modes button:last-child { border-bottom: 0; }
  .modes button:hover { background: var(--surface-2); color: var(--ink); }
  .modes button[aria-checked='true'] { color: var(--ink); background: var(--surface-3); box-shadow: inset 2px 0 0 var(--ink-2); }
  .modes button:focus-visible { outline-offset: -2px; }
  .desc { font-size: var(--fs-sm); color: var(--ink-2); margin: 4px 0 0; }
  .row { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: end; }
  .chk { display: inline-flex; gap: 6px; align-items: center; font-size: var(--fs-sm); cursor: pointer; min-height: 30px; }
  .transport { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .play { min-width: 92px; }
  .now { font-size: var(--fs-sm); color: var(--ink-2); }
  .help { font-size: var(--fs-sm); color: var(--ink-3); margin: 0; }
  .err { font-size: var(--fs-sm); color: var(--critical); margin: 0; }
  details.more { margin: 0; }
</style>
