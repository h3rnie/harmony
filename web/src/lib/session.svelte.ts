// Application state (Svelte 5 runes) and the AOI -> tiles -> kernel -> Analysis pipeline.
import type { Analysis, AnalyzeOptions, AoiInfo, CellLayer, KernelClient, Meta } from './kernel/types'
import { aoiProblem, type Aoi } from './geo'
import { selectKernel, type KernelSelection } from './kernelSelect'
import { beginTileRun, mapLimit, readTile, tileInfo } from './data/tileReader'
import { DEBOUNCE_MS, DEFAULT_BASELINE, FETCH_CONCURRENCY, MAX_AOI_BYTES, MAX_AOI_CELLS } from './config'
import { readHash, writeHash, type CalMode, type Dn, type OverlayMode, type RecordMode, type Unit } from './urlState'
import { fmtRatio, monthLong, ordinal, toM, yearOf } from './format'
import { presetById } from './presets'

export type Status = 'booting' | 'idle' | 'loading' | 'analyzing' | 'ready' | 'error'

class Stale extends Error {}

class Session {
  status = $state<Status>('booting')
  error = $state<string | null>(null)
  /** 'area': the chosen area cannot be analysed (crosses the 180° meridian, too large); 'run': loading or analysis failed. */
  errorKind = $state<'area' | 'run'>('run')
  progress = $state({ done: 0, total: 0, bytes: 0, level: -1 })
  sel = $state.raw<KernelSelection | null>(null)
  aoi = $state.raw<Aoi | null>(null)
  aoiInfo = $state.raw<AoiInfo | null>(null)
  analysis = $state.raw<Analysis | null>(null)
  layer = $state.raw<CellLayer | null>(null)
  layerM = $state<number | null>(null)

  // View options (all mirrored in the URL hash)
  focusM = $state<number | null>(null)
  calMode = $state<CalMode>('activity')
  overlay = $state<OverlayMode>('harmonized')
  switchYear = $state<number | null>(null)
  baseline = $state<[number, number] | null>(null)
  dn = $state<Dn>('both')
  rangeYears = $state<[number, number] | null>(null)
  /** How the record is built: precision-weighted fusion (default) or the original hard switch. */
  recordMode = $state<RecordMode>('fused')
  /** Units lens: MODIS-equivalent (default) or VIIRS-equivalent cell-days. */
  unit = $state<Unit>('modis')

  /** Polite live-region text. */
  announce = $state('')

  /** Preset month-of-year without a year: resolved to the latest year with data once analysed. */
  private pendingMonth: number | null = null
  private runId = 0
  private lock: Promise<unknown> = Promise.resolve()
  private dataReady = false
  private fullTimer: ReturnType<typeof setTimeout> | undefined
  private anaTimer: ReturnType<typeof setTimeout> | undefined
  private abort: AbortController | null = null

  get meta(): Meta | null { return this.sel?.meta ?? null }
  get kernel(): KernelClient | null { return this.sel?.kernel ?? null }
  get isMock() { return this.sel?.kind === 'mock' }

  /** Record bounds in years. */
  get yearSpan(): [number, number] {
    const m = this.meta
    return m ? [yearOf(m.m_first), yearOf(m.m_last)] : [2000, new Date().getFullYear()]
  }
  get effectiveSwitchM(): number {
    const m = this.meta!
    return this.switchYear != null ? toM(this.switchYear, 1) : m.default_switch_m
  }
  get effectiveBaseline(): [number, number] {
    const [y0, y1] = this.yearSpan
    const b = this.baseline ?? DEFAULT_BASELINE
    return [Math.max(b[0], y0 + 1), Math.min(b[1], y1)]
  }
  get options(): AnalyzeOptions {
    const m = this.meta!
    const r = this.rangeYears
    return {
      switchM: this.effectiveSwitchM,
      baseline: this.effectiveBaseline,
      dn: this.dn,
      range: r ? [Math.max(m.m_first, toM(r[0], 1)), Math.min(m.m_last, toM(r[1], 12))] : [m.m_first, m.m_last],
      mode: this.recordMode,
      unit: this.unit,
    }
  }
  /** Unit label of every harmonized value on screen: what the kernel actually returned, else the requested lens. */
  get unitLabel(): 'AFCD-M' | 'AFCD-V' {
    const u = this.analysis?.harmonization?.unit ?? this.unit
    return u === 'viirs' ? 'AFCD-V' : 'AFCD-M'
  }
  /** The month the status strip and map overlay describe. */
  get focus(): number | null {
    const a = this.analysis
    if (!a) return null
    const f = this.focusM
    if (f != null && this.meta && f >= this.meta.m_first && f <= this.meta.m_last) return f
    return a.current.m
  }

  // ---------------------------------------------------------------- lifecycle

  async boot() {
    try {
      this.sel = await selectKernel()
    } catch (e) {
      this.fail(e)
      return
    }
    const v = readHash()
    this.focusM = v.focusM
    this.calMode = v.calMode
    this.overlay = v.overlay
    this.switchYear = v.switchYear
    this.baseline = v.baseline
    this.dn = v.dn
    this.rangeYears = v.rangeYears
    this.recordMode = v.recordMode
    this.unit = v.unit
    this.status = 'idle'
    // A shared preset link without an explicit month opens on the preset's story month.
    if (v.aoi) this.setAoi(v.aoi, { ...(v.aoi.presetId && v.focusM == null ? {} : { keepFocus: true }), history: 'replace' })
    // Back / Forward (popstate) and hand-edited hashes (hashchange) restore the state without adding history.
    // The handler is idempotent, so the pair of events one step can fire restores once.
    addEventListener('popstate', () => this.onHashChange())
    addEventListener('hashchange', () => this.onHashChange())
  }

  private onHashChange() {
    const v = readHash()
    const sameAoi = JSON.stringify(v.aoi?.rings) === JSON.stringify(this.aoi?.rings)
    this.focusM = v.focusM; this.calMode = v.calMode; this.overlay = v.overlay
    const optsChanged = v.switchYear !== this.switchYear || v.dn !== this.dn ||
      String(v.baseline) !== String(this.baseline) || String(v.rangeYears) !== String(this.rangeYears) ||
      v.recordMode !== this.recordMode || v.unit !== this.unit
    this.switchYear = v.switchYear; this.baseline = v.baseline; this.dn = v.dn; this.rangeYears = v.rangeYears
    this.recordMode = v.recordMode; this.unit = v.unit
    if (!sameAoi) this.setAoi(v.aoi, { ...(v.aoi?.presetId && v.focusM == null ? {} : { keepFocus: true }), history: 'replace' })
    else if (optsChanged) this.scheduleAnalyze()
    else this.refreshLayer()
  }

  /** Mirror the state in the URL: 'push' adds a history entry (a different place), 'replace' amends the current one. */
  private syncHash(mode: 'push' | 'replace' = 'replace') {
    writeHash({
      aoi: this.aoi, focusM: this.focusM, calMode: this.calMode, overlay: this.overlay,
      switchYear: this.switchYear, baseline: this.baseline, dn: this.dn, rangeYears: this.rangeYears,
      recordMode: this.recordMode, unit: this.unit,
    }, mode)
  }

  // ---------------------------------------------------------------- public actions

  /**
   * o.edit: the same place reshaped (draw "Edit"), so the previous answer may stay on screen, dimmed, until the new one
   * is ready. Any other change is a different place: its old answer is cleared at once, so a stale answer for the
   * wrong area or month never shows and then flips (audit F9).
   */
  setAoi(aoi: Aoi | null, o: { keepFocus?: boolean; focusM?: number | null; edit?: boolean; history?: 'push' | 'replace' | 'none' } = {}) {
    // A different place is a new history entry; reshaping the same place, or restoring from Back/Forward, is not.
    const hist = o.history ?? (o.edit || (aoi && aoi === this.aoi) ? 'replace' : 'push')
    const why = aoi ? aoiProblem(aoi) : null
    if (why) {
      // Nothing of the previous area stays on screen, and nothing stray is drawn: no area, one clear message.
      clearTimeout(this.fullTimer)
      this.abort?.abort()
      this.runId++
      this.aoi = null; this.analysis = null; this.layer = null; this.layerM = null; this.aoiInfo = null
      this.focusM = null; this.pendingMonth = null; this.dataReady = false
      if (hist !== 'none') this.syncHash('replace')
      this.error = why
      this.errorKind = 'area'
      this.status = 'error'
      this.announce = why
      return
    }
    this.aoi = aoi
    if (!o.edit) { this.analysis = null; this.layer = null; this.layerM = null; this.aoiInfo = null }
    if (!o.keepFocus) this.focusM = o.focusM ?? null
    const preset = presetById(aoi?.presetId)
    this.pendingMonth = null
    if (preset && !o.keepFocus && o.focusM === undefined && this.meta) {
      if (preset.focus.year != null) this.focusM = toM(preset.focus.year, preset.focus.month)
      else this.pendingMonth = preset.focus.month
    }
    if (hist !== 'none') this.syncHash(hist)
    clearTimeout(this.fullTimer)
    this.abort?.abort()
    this.runId++
    if (!aoi) {
      this.analysis = null; this.layer = null; this.aoiInfo = null
      this.status = 'idle'
      this.error = null
      return
    }
    this.status = 'loading'
    this.error = null
    this.errorKind = 'run'
    this.fullTimer = setTimeout(() => this.runFull(), DEBOUNCE_MS)
  }

  setFocus(m: number | null) {
    this.focusM = m
    this.syncHash()
    this.refreshLayer()
  }
  setCalMode(mode: CalMode) { this.calMode = mode; this.syncHash() }
  setOverlay(mode: OverlayMode) { this.overlay = mode; this.syncHash(); this.refreshLayer() }
  setSwitchYear(y: number | null) { this.switchYear = y; this.syncHash(); this.scheduleAnalyze() }
  setBaseline(b: [number, number] | null) { this.baseline = b; this.syncHash(); this.scheduleAnalyze() }
  setDn(dn: Dn) { this.dn = dn; this.syncHash(); this.scheduleAnalyze() }
  setRange(r: [number, number] | null) { this.rangeYears = r; this.syncHash(); this.scheduleAnalyze() }
  setRecordMode(mode: RecordMode) { this.recordMode = mode; this.syncHash(); this.scheduleAnalyze() }
  setUnit(u: Unit) { this.unit = u; this.syncHash(); this.scheduleAnalyze() }

  // ---------------------------------------------------------------- pipeline

  /** Serialize kernel access: the worker holds one AOI at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn)
    this.lock = p.catch(() => undefined)
    return p
  }

  private check(id: number) {
    if (id !== this.runId) throw new Stale()
  }

  private async pickLevel(kernel: KernelClient, meta: Meta, info: AoiInfo) {
    const levels = [...meta.levels].sort((a, b) => a.cell_deg - b.cell_deg)
    const index = this.sel!.index
    const coslat = Math.max(0.05, Math.cos((info.centroid[1] * Math.PI) / 180))
    let last = { level: levels[levels.length - 1].level, keys: [] as string[], bytes: 0 }
    for (const L of levels) {
      const keys = await kernel.tilesFor(L.level)
      let bytes = 0
      for (const k of keys) bytes += tileInfo(index, L.level, k)?.[0] ?? 0
      last = { level: L.level, keys, bytes }
      const fits = index
        ? bytes <= MAX_AOI_BYTES
        : info.areaKm2 / ((L.cell_deg * 111.32) ** 2 * coslat) <= MAX_AOI_CELLS
      if (fits) return last
    }
    return last
  }

  private async runFull() {
    const id = ++this.runId
    const sel = this.sel, aoi = this.aoi
    if (!sel || !aoi) return
    const ctrl = new AbortController()
    this.abort = ctrl
    try {
      await this.exclusive(async () => {
        this.check(id)
        const { kernel, meta, index } = sel
        this.dataReady = false
        this.status = 'loading'
        const info = await kernel.setAoi(aoi.rings)
        this.check(id)
        this.aoiInfo = info
        const pick = await this.pickLevel(kernel, meta, info)
        this.check(id)
        await kernel.begin(pick.level)
        // Tiles absent from the index hold no fire data; the mock kernel needs no tiles at all.
        const keys = sel.kind === 'mock' ? [] : index ? pick.keys.filter((k) => tileInfo(index, pick.level, k)) : pick.keys
        this.progress = { done: 0, total: keys.length, bytes: 0, level: pick.level }
        beginTileRun() // this run's tiles stay cached; older ones may be evicted
        let ingest: Promise<unknown> = Promise.resolve()
        await mapLimit(keys, FETCH_CONCURRENCY, async (key) => {
          const ti = tileInfo(index, pick.level, key)
          let cols
          try {
            cols = await readTile(pick.level, key, ti?.[0], ctrl.signal)
          } catch (e) {
            if (ctrl.signal.aborted) throw new Stale()
            if (!index && /HTTP 404/.test(String(e))) return // no index: missing tile = no data
            throw e
          }
          this.check(id)
          ingest = ingest.then(() => { this.check(id); return kernel.ingestTile(cols) })
          await ingest
          this.progress = { ...this.progress, done: this.progress.done + 1, bytes: this.progress.bytes + (ti?.[0] ?? 0) }
        })
        await ingest
        this.check(id)
        this.dataReady = true
        await this.analyzeLocked(id)
      })
      await this.refreshLayer()
    } catch (e) {
      if (!(e instanceof Stale)) this.fail(e)
    }
  }

  private async analyzeLocked(id: number) {
    const kernel = this.kernel!
    this.status = 'analyzing'
    const a = await kernel.analyze(this.options)
    this.check(id)
    if (this.pendingMonth != null) {
      const mo = this.pendingMonth
      this.pendingMonth = null
      const yi = [...a.calendar.years.keys()].reverse().find((i) => (a.calendar.value[i][mo - 1] ?? 0) > 0)
      if (yi != null) { this.focusM = toM(a.calendar.years[yi], mo); this.syncHash() }
    }
    this.analysis = a
    this.status = 'ready'
    this.error = null
    this.announce = this.summaryText(a)
  }

  scheduleAnalyze() {
    if (!this.aoi || !this.sel) return
    clearTimeout(this.anaTimer)
    this.anaTimer = setTimeout(async () => {
      const id = this.runId
      try {
        await this.exclusive(async () => {
          this.check(id)
          if (!this.dataReady) return // a full run is in flight and will analyze with the new options
          await this.analyzeLocked(id)
        })
        await this.refreshLayer()
      } catch (e) {
        if (!(e instanceof Stale)) this.fail(e)
      }
    }, DEBOUNCE_MS / 2)
  }

  async refreshLayer() {
    const m = this.focus
    if (m == null || !this.sel || !this.dataReady) return
    const id = this.runId
    try {
      const layer = await this.exclusive(async () => {
        this.check(id)
        if (!this.dataReady) throw new Stale()
        return this.kernel!.cellLayer({
          mFrom: m, mTo: m, mode: this.overlay, switchM: this.effectiveSwitchM, baseline: this.effectiveBaseline, dn: this.dn,
          seriesMode: this.recordMode,
        })
      })
      this.check(id)
      this.layer = this.lensLayer(layer, m)
      this.layerM = m
    } catch (e) {
      if (!(e instanceof Stale)) console.warn('cell layer failed', e)
    }
  }

  /**
   * The cell layer has no unit option, so under the VIIRS lens its single-month activity values are divided here by
   * the area's own factor for that calendar month (the same f_k the kernel applies to the series, METHOD.md section 18).
   * Ratios to normal are unit-free and left alone.
   */
  private lensLayer(layer: CellLayer, m: number): CellLayer {
    const f = this.analysis?.harmonization?.lensFactor
    if (this.overlay !== 'harmonized' || this.analysis?.harmonization?.unit !== 'viirs' || !f) return layer
    const k = f[((m % 12) + 12) % 12]
    if (!(k > 0) || k === 1) return layer
    return { ...layer, values: layer.values.map((v) => v / k) }
  }

  private fail(e: unknown) {
    console.error(e)
    const msg = e instanceof Error ? e.message : String(e)
    // The kernel's own limit, phrased for people (it is checked up front too, see geo.aoiProblem).
    this.error = /area too large/i.test(msg) ? 'This area is too large to analyse; the Global pulse shows the whole planet.' : msg
    this.errorKind = /area too large/i.test(msg) ? 'area' : 'run'
    this.status = 'error'
    if (this.errorKind === 'area') { this.analysis = null; this.layer = null }
  }

  private summaryText(a: Analysis): string {
    const c = a.current
    const where = this.aoi?.label ?? 'the selected area'
    return `Analysis updated for ${where}. ${monthLong(c.m)}: ${fmtRatio(c.ratio)} the normal for the month, ${c.percentile == null ? '' : ordinal(Math.round(c.percentile)) + ' percentile'}.`
  }
}

export const session = new Session()
