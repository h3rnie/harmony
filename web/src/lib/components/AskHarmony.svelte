<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import type { Analysis } from '../kernel/types'
  import { session } from '../session.svelte'
  import { dossierFromSession } from '../brief/fromSession'
  import { ASK_MAX_ANSWER_CHARS, ASK_MAX_QUESTION_CHARS, ASK_MAX_TURNS, type ChatTurn, type Dossier } from '../brief/dossier'
  import { AiClientError, streamAsk } from '../brief/client'
  import { liveNowSummary } from '../brief/liveNow'
  import { suggestQuestions } from '../brief/suggestions'
  import { aiStatus } from '../brief/status.svelte'

  let { a }: { a: Analysis } = $props()

  interface Turn extends ChatTurn {
    /** Month the answer was computed for (the dossier changes when the user moves the month or baseline). */
    view?: string
    model?: string
    cachedContext?: boolean
    ungrounded?: string[]
  }

  const available = $derived(!session.isMock && aiStatus.value?.ask === true)
  const dossier = $derived<Dossier | null>(dossierFromSession(a))
  const suggestions = $derived(dossier ? suggestQuestions(dossier) : [])

  let turns = $state<Turn[]>([])
  let draft = $state('')
  let phase = $state<'idle' | 'loading' | 'streaming'>('idle')
  let partial = $state('')
  let error = $state<{ code: string; retryAfter?: number } | null>(null)
  let ctl: AbortController | null = null
  let log: HTMLElement | undefined = $state()
  let inputEl: HTMLInputElement | undefined = $state()

  const busy = $derived(phase !== 'idle')
  const tooLong = $derived(Array.from(draft).length > ASK_MAX_QUESTION_CHARS)

  const REASONS: Record<string, string> = {
    rate_limited: 'Too many questions in a short time',
    refused: 'The model declined this question',
    bad_output: 'The model returned an unusable answer',
    upstream_error: 'The AI service did not respond',
    bad_request: 'The question could not be sent',
    no_key: 'Ask Harmony is not available on this server',
    bad_config: 'Ask Harmony is not available on this server',
  }

  // Conversation resets when the area changes.
  const areaKey = $derived(session.aoi ? `${session.aoi.label}|${JSON.stringify(session.aoi.rings)}` : '')
  $effect(() => {
    void areaKey
    untrack(() => clear())
  })
  onDestroy(() => ctl?.abort())

  function clear() {
    ctl?.abort()
    ctl = null
    turns = []
    partial = ''
    error = null
    phase = 'idle'
  }

  function stop() {
    ctl?.abort()
    ctl = null
    if (partial.trim()) {
      turns = [...turns, { role: 'assistant', content: partial.trim().slice(0, ASK_MAX_ANSWER_CHARS), view: dossier?.month.label }]
    } else if (turns.length && turns[turns.length - 1].role === 'user') {
      // Stopped before any text arrived: take the question back into the box instead of leaving it unanswered.
      draft = turns[turns.length - 1].content
      turns = turns.slice(0, -1)
    }
    partial = ''
    phase = 'idle'
    inputEl?.focus()
  }

  /** The last turns that fit the server's cap, always starting with a user turn and ending with the new question. */
  function windowed(history: Turn[], q: string): ChatTurn[] {
    const all: ChatTurn[] = [...history.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: q }]
    // Defensive: the server needs strictly alternating turns; collapse any run of the same role to its last turn.
    const alt = all.filter((t, i) => i === all.length - 1 || all[i + 1].role !== t.role)
    let w = alt.slice(-ASK_MAX_TURNS)
    while (w.length && w[0].role !== 'user') w = w.slice(1)
    return w
  }

  async function ask(question: string) {
    const q = question.replace(/\s+/g, ' ').trim()
    if (!q || busy || !dossier || Array.from(q).length > ASK_MAX_QUESTION_CHARS) return
    error = null
    const history = turns
    const d: Dossier = { ...dossier }
    const now = liveNowSummary()
    if (now) d.now = now
    turns = [...history, { role: 'user', content: q }]
    draft = ''
    partial = ''
    phase = 'loading'
    const mine = (ctl = new AbortController())
    scrollDown()
    try {
      const done = await streamAsk(d, windowed(history, q), {
        signal: mine.signal,
        onDelta: (t) => { if (ctl === mine) { phase = 'streaming'; partial += t } },
        onReset: () => { if (ctl === mine) partial = '' },
      })
      if (ctl !== mine) return
      turns = [...turns, {
        role: 'assistant', content: done.text.slice(0, ASK_MAX_ANSWER_CHARS), view: d.month.label, model: done.model,
        cachedContext: !!done.cache && done.cache.read / Math.max(1, done.usage.input + done.usage.cacheRead + done.usage.cacheWrite) >= 0.5, ungrounded: done.ungrounded,
      }]
    } catch (e) {
      if (ctl !== mine || mine.signal.aborted) return
      // The question did not get an answer: take it back out of the transcript and into the input.
      turns = history
      draft = q
      error = { code: e instanceof AiClientError ? e.code : 'upstream_error', retryAfter: e instanceof AiClientError ? e.retryAfter : undefined }
    } finally {
      if (ctl === mine) { phase = 'idle'; partial = ''; ctl = null; scrollDown(); inputEl?.focus() }
    }
  }

  async function scrollDown() {
    await tick()
    log?.scrollTo({ top: log.scrollHeight })
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(draft) }
    else if (e.key === 'Escape') { if (busy) { e.preventDefault(); stop() } else if (draft) { e.preventDefault(); draft = '' } }
  }
</script>

{#if available}
  <div class="ask" role="group" aria-labelledby="ask-h">
    <h3 id="ask-h">Ask Harmony</h3>
    <p class="muted prov">Answers come only from the statistics on this page, not from the web or from anything else. They cannot tell causes, weather or burned area.</p>

    {#if turns.length === 0 && !busy}
      <div class="chips" aria-label="Suggested questions">
        {#each suggestions as s (s)}
          <button class="chip" type="button" onclick={() => ask(s)} disabled={!dossier}>{s}</button>
        {/each}
      </div>
    {/if}

    {#if turns.length > 0 || busy}
      <div class="log" bind:this={log} role="log" aria-label="Conversation with Ask Harmony" aria-live="polite" aria-busy={phase === 'streaming'}>
        {#each turns as t, i (i)}
          {#if t.role === 'user'}
            <p class="q"><span class="who">You</span>{t.content}</p>
          {:else}
            <div class="ans">
              <p class="who">Harmony</p>
              <p class="body">{t.content}</p>
              {#if t.ungrounded && t.ungrounded.length}
                <p class="small warn" role="note">Some figures here ({t.ungrounded.join(', ')}) could not be matched to the statistics on this page; check before quoting.</p>
              {/if}
              <p class="small muted meta">{t.view ? `For ${t.view}` : ''}{t.model ? ` · ${t.model}` : ''}{t.cachedContext ? ' · cached context' : ''}</p>
            </div>
          {/if}
        {/each}
        {#if phase === 'loading'}<p class="small muted" role="status">Thinking…</p>{/if}
        {#if phase === 'streaming'}
          <div class="ans"><p class="who">Harmony</p><p class="body">{partial}</p></div>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="small err" role="alert">
        {REASONS[error.code] ?? 'Something went wrong'}{error.code === 'rate_limited' && error.retryAfter ? `; try again in ${error.retryAfter} s` : ''}. Your question is still in the box.
      </p>
    {/if}

    <form class="row" onsubmit={(e) => { e.preventDefault(); ask(draft) }}>
      <label class="sr" for="ask-input">Ask a question about this area</label>
      <input
        id="ask-input" class="in" type="text" name="ask-harmony" autocomplete="off" enterkeyhint="send"
        placeholder="Ask about this area, e.g. when does the season peak?"
        bind:value={draft} bind:this={inputEl} onkeydown={onKey} disabled={!dossier}
        aria-describedby="ask-hint" aria-invalid={tooLong}
      />
      {#if busy}
        <button class="btn" type="button" onclick={stop}>Stop</button>
      {:else}
        <button class="btn primary" type="submit" disabled={!draft.trim() || tooLong || !dossier}>Ask</button>
      {/if}
      <button class="btn" type="button" onclick={clear} disabled={turns.length === 0 && !draft && !error}>Clear</button>
    </form>
    <p id="ask-hint" class="small muted hint" class:over={tooLong}>
      {#if tooLong}Questions are limited to {ASK_MAX_QUESTION_CHARS} characters.{:else}Enter to send · Esc to stop or clear the box.{/if}
    </p>
  </div>
{/if}

<style>
  .ask { margin-top: 22px; padding-top: 16px; border-top: 1px dashed var(--rule-strong); max-width: 70ch; }
  h3 { margin: 0 0 4px; font-size: var(--fs-base); }
  .prov { margin: 0 0 10px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .chip {
    font: inherit; font-size: var(--fs-base); text-transform: none; letter-spacing: normal; line-height: 1.35; color: var(--ink-2); background: var(--surface); border: 1px solid var(--rule-strong);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; text-align: left;
  }
  .chip:hover:not(:disabled) { color: var(--ink); background: var(--surface-2); }
  .chip:disabled { opacity: 0.5; cursor: not-allowed; }
  .log { max-height: 340px; overflow-y: auto; padding: 4px 2px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
  .q { margin: 0; padding: 6px 10px; background: var(--surface-2); border-radius: 8px; font-size: var(--fs-base); align-self: flex-end; max-width: 92%; }
  .who { display: block; font-size: var(--fs-xs); color: var(--ink-3); margin: 0 0 2px; }
  .q .who { display: inline; margin-right: 8px; }
  .ans { border-left: 2px solid var(--accent); padding-left: 12px; }
  .ans .body { margin: 0; white-space: pre-wrap; line-height: 1.55; font-size: var(--fs-base); }
  .meta { margin: 4px 0 0; }
  .warn { color: var(--warning); margin: 4px 0 0; }
  .err { color: var(--ink-2); margin: 0 0 8px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .in {
    flex: 1 1 240px; min-width: 0; font: inherit; color: var(--ink); background: var(--bg-2); border: 1px solid var(--rule-strong);
    border-radius: 6px; padding: 7px 10px;
  }
  .in:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .in[aria-invalid='true'] { border-color: var(--critical); }
  .hint { margin: 6px 0 0; }
  .hint.over { color: var(--critical); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
