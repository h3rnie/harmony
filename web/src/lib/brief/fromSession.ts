// The one place that turns the app session + Analysis into a dossier, shared by the brief card and the Ask box so
// both ask about exactly the same statistics (and therefore share the same cached prompt prefix on the server).
import type { Analysis } from '../kernel/types'
import { session } from '../session.svelte'
import { yearOf } from '../format'
import { buildDossier, type Dossier, type LiveNow } from './dossier'

export function dossierFromSession(a: Analysis, now?: LiveNow | null): Dossier | null {
  const aoi = session.aoi
  const info = session.aoiInfo
  const meta = session.meta
  const focus = session.focus
  if (!aoi || !info || !meta || focus == null) return null
  return buildDossier({
    areaLabel: aoi.label,
    isPreset: !!aoi.presetId,
    areaKm2: info.areaKm2,
    centroid: info.centroid,
    focusM: focus,
    firstYear: yearOf(meta.m_first),
    baseline: session.effectiveBaseline,
    dataThrough: meta.data_through ?? null,
    dayNight: session.dn,
    switchM: session.effectiveSwitchM,
    aquaStartM: meta.aqua_start_m,
    viirsStartM: meta.viirs_start_m,
    analysis: a,
    // What the kernel actually returned wins over the requested lens (they differ only if the kernel fell back).
    unit: a.harmonization?.unit ?? session.unit,
    now,
  })
}
