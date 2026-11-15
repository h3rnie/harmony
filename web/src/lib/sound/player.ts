// Sonification, audio part: plays a Schedule (mapping.ts) with the Web Audio API. No libraries.
// The AudioContext is created on the first play() call, which must come from a user gesture.
// Events are scheduled a little ahead of time (lookahead pump), so pause and stop take effect within ~0.2 s.
import { eventAt, type Schedule, type ToneEvent } from './mapping'

/** Master level, capped: the loudest single tone peaks at about this fraction of full scale. */
export const MASTER_GAIN = 0.22
const LOOKAHEAD = 0.18
const LEVEL: Record<string, number> = { value: 0.55, zero: 0.2, normal: 0.26, tick: 0.35 }

export interface PlayerHooks {
  /** Called whenever the month (or the year) under the playhead changes; null when nothing is sounding. */
  onPosition?: (e: ToneEvent | null, year: number | null, part: string | null) => void
  onEnd?: () => void
}

export class SonificationPlayer {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private schedule: Schedule | null = null
  private next = 0
  private startAt = 0
  private offset = 0
  private pumpTimer: ReturnType<typeof setInterval> | undefined
  private posTimer: ReturnType<typeof setInterval> | undefined
  private live = new Set<{ src: AudioScheduledSourceNode; gain: GainNode }>()
  private lastKey = ''
  private year: number | null = null
  private part: string | null = null
  playing = false

  private hooks: PlayerHooks
  constructor(hooks: PlayerHooks = {}) { this.hooks = hooks }

  /** True once an AudioContext exists (only after a user gesture). */
  get started() { return this.ctx != null }
  get position() { return this.playing && this.ctx ? this.ctx.currentTime - this.startAt : this.offset }

  load(s: Schedule) {
    const wasPlaying = this.playing
    this.halt()
    this.schedule = s
    this.offset = 0
    this.next = 0
    this.year = null
    this.part = null
    this.report(null)
    return wasPlaying
  }

  async play() {
    if (!this.schedule || this.playing) return
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) throw new Error('Web Audio is not available in this browser')
      this.ctx = new AC()
      const limiter = this.ctx.createDynamicsCompressor()
      limiter.threshold.value = -10; limiter.knee.value = 6; limiter.ratio.value = 12
      limiter.attack.value = 0.003; limiter.release.value = 0.15
      this.master = this.ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(limiter).connect(this.ctx.destination)
      // 60 ms of soft noise for the year tick (a timbre no data tone uses).
      const len = Math.round(this.ctx.sampleRate * 0.06)
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const ch = this.noise.getChannelData(0)
      let seed = 1
      for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; ch[i] = (seed / 2147483647) * 2 - 1 }
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.offset >= this.schedule.duration) { this.offset = 0; this.next = 0 }
    const now = this.ctx.currentTime
    this.master!.gain.cancelScheduledValues(now)
    this.master!.gain.setValueAtTime(this.master!.gain.value, now)
    this.master!.gain.linearRampToValueAtTime(MASTER_GAIN, now + 0.05)
    this.startAt = now + 0.06 - this.offset
    this.playing = true
    this.pump()
    this.pumpTimer = setInterval(() => this.pump(), 40)
    this.posTimer = setInterval(() => this.track(), 40)
  }

  pause() {
    if (!this.playing || !this.ctx) return
    this.offset = Math.max(0, this.ctx.currentTime - this.startAt)
    this.halt()
    const ev = this.schedule!.events
    this.next = ev.findIndex((e) => e.t >= this.offset)
    if (this.next < 0) this.next = ev.length
  }

  stop() {
    this.halt()
    this.offset = 0
    this.next = 0
    this.year = null
    this.part = null
    this.report(null)
  }

  async dispose() {
    this.stop()
    const c = this.ctx
    this.ctx = null; this.master = null
    if (c) try { await c.close() } catch { /* already closed */ }
  }

  // ---------------------------------------------------------------- internals

  private halt() {
    clearInterval(this.pumpTimer); clearInterval(this.posTimer)
    this.playing = false
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const n of this.live) {
      try {
        n.gain.gain.cancelScheduledValues(now)
        n.gain.gain.setTargetAtTime(0, now, 0.012)
        n.src.stop(now + 0.08)
      } catch { /* not started yet */ }
    }
    this.live.clear()
    if (this.master) {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setTargetAtTime(0, now, 0.02)
    }
  }

  private pump() {
    if (!this.ctx || !this.schedule) return
    const ev = this.schedule.events
    const horizon = this.ctx.currentTime + LOOKAHEAD
    while (this.next < ev.length && this.startAt + ev[this.next].t < horizon) {
      const e = ev[this.next++]
      const at = this.startAt + e.t
      if (at + e.dur < this.ctx.currentTime) continue // fell behind (tab throttled): skip rather than burst
      this.sound(e, Math.max(at, this.ctx.currentTime))
    }
  }

  private sound(e: ToneEvent, at: number) {
    const ctx = this.ctx!
    if (e.kind === 'rest' || e.kind === 'pause') return
    const g = ctx.createGain()
    g.gain.value = 0
    let src: AudioScheduledSourceNode
    let peak = LEVEL[e.kind] ?? 0.3
    if (e.kind === 'tick') {
      const b = ctx.createBufferSource()
      b.buffer = this.noise
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.2
      b.connect(bp).connect(g)
      src = b
    } else {
      const o = ctx.createOscillator()
      o.type = e.kind === 'value' ? 'sine' : 'triangle'
      o.frequency.value = e.freq ?? 262
      // Mild equal-loudness compensation: high notes sound louder at the same amplitude.
      peak *= Math.min(1, (262 / (e.freq ?? 262)) ** 0.3)
      o.connect(g)
      src = o
    }
    g.connect(this.master!)
    // Envelope: short linear attack and release, so no note starts or ends with a click.
    const atk = Math.min(0.012, e.dur / 4), rel = Math.min(0.045, e.dur / 3)
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(peak, at + atk)
    g.gain.setValueAtTime(peak, at + Math.max(atk, e.dur - rel))
    g.gain.linearRampToValueAtTime(0, at + e.dur)
    const node = { src, gain: g }
    this.live.add(node)
    src.onended = () => { this.live.delete(node); try { g.disconnect() } catch { /* gone */ } }
    src.start(at)
    src.stop(at + e.dur + 0.02)
  }

  private track() {
    if (!this.ctx || !this.schedule) return
    const pos = this.ctx.currentTime - this.startAt
    const ev = this.schedule.events
    // Year and part follow the last tick / part start that has sounded.
    for (let i = Math.min(ev.length - 1, this.next); i >= 0; i--) {
      if (ev[i].t > pos) continue
      if (ev[i].year != null || ev[i].part) {
        for (let k = i; k >= 0; k--) if (ev[k].part) { this.part = ev[k].part!; break }
        for (let k = i; k >= 0; k--) if (ev[k].year != null) { this.year = ev[k].year; break }
        break
      }
    }
    this.report(eventAt(ev, pos))
    if (pos > this.schedule.duration + 0.1) {
      this.halt()
      this.offset = 0; this.next = 0; this.year = null; this.part = null
      this.report(null)
      this.hooks.onEnd?.()
    }
  }

  private report(e: ToneEvent | null) {
    const key = `${e?.m ?? '-'}|${e?.kind ?? ''}|${this.year}|${this.part}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.hooks.onPosition?.(e, this.year, this.part)
  }
}
