// Calendar / series CSV, calendar SVG + PNG, AOI GeoJSON. All carry the FIRMS acknowledgement.
import type { Analysis } from '../kernel/types'
import { FIRMS_ACK } from '../config'
import { aoiToGeoJSON, type Aoi } from '../geo'
import { MONTHS_SHORT, monthIso, toM, fmtCell, fmtNum } from '../format'
import { activityDomain, activityInverse, activityT, divColor, inkOn, percentileT, ratioT, seqColor, type Theme } from '../color'
import { seriesIndex, SOURCE_SHORT } from '../analysisUtil'
import type { CalMode } from '../urlState'

export interface ExportContext {
  analysis: Analysis
  aoi: Aoi
  baseline: [number, number]
  switchM: number
  dn: string
  kernel: 'wasm' | 'mock'
  dataThrough: string
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const el = document.createElement('a')
  el.href = url
  el.download = name
  document.body.appendChild(el)
  el.click()
  el.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'area'
}

const csvCell = (v: unknown) => {
  if (v == null) return ''
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(+v.toFixed(4)) : '') : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',')

function header(ctx: ExportContext, what: string): string {
  return [
    `# Harmony — ${what}`,
    `# Area: ${ctx.aoi.label}; level L${ctx.analysis.aoi.level}; ${Math.round(ctx.analysis.aoi.areaKm2)} km2`,
    `# Unit: AFCD-M = MODIS-equivalent active-fire cell-days per month (detections, not burned area)`,
    `# Baseline ${ctx.baseline.join('-')}; calibrated VIIRS from ${monthIso(ctx.switchM)}; overpass ${ctx.dn}; data through ${ctx.dataThrough}`,
    ctx.kernel === 'mock' ? '# WARNING: demo output from the mock kernel (synthetic numbers, not FIRMS data)' : `# Generated ${new Date().toISOString()}`,
    `# ${FIRMS_ACK}`,
  ].join('\n') + '\n'
}

export function calendarCsv(ctx: ExportContext): string {
  const a = ctx.analysis
  const lines = [csvRow(['year', 'month', 'harmonized', 'lo80', 'hi80', 'median', 'ratio', 'percentile', 'source', 'provisional'])]
  a.calendar.years.forEach((y, yi) => {
    for (let c = 0; c < 12; c++) {
      const v = a.calendar.value[yi][c]
      if (v == null) continue
      const si = seriesIndex(a, toM(y, c + 1))
      lines.push(csvRow([
        y, c + 1, v, si >= 0 ? a.series.lo80[si] : null, si >= 0 ? a.series.hi80[si] : null,
        a.climatology.median[c], a.calendar.ratio[yi][c], a.calendar.percentile[yi][c],
        si >= 0 ? SOURCE_SHORT[a.series.source[si]] : '', si >= 0 ? (a.series.provisional[si] ? 1 : 0) : 0,
      ]))
    }
  })
  return header(ctx, 'burning calendar') + lines.join('\n') + '\n'
}

export function seriesCsv(ctx: ExportContext): string {
  const a = ctx.analysis, s = a.series
  const lines = [csvRow(['month', 'harmonized', 'lo80', 'hi80', 'lo95', 'hi95', 'modis_eq', 'viirs_cal', 'viirs_raw', 'raw_modis_count', 'raw_viirs_count', 'naive_count', 'source', 'provisional'])]
  a.months.forEach((m, i) => {
    lines.push(csvRow([monthIso(m), s.harmonized[i], s.lo80[i], s.hi80[i], s.lo95[i], s.hi95[i], s.modisEq[i], s.viirsCal[i], s.viirsRaw[i], s.rawModisCount[i], s.rawViirsCount[i], s.naive[i], SOURCE_SHORT[s.source[i]], s.provisional[i] ? 1 : 0]))
  })
  return header(ctx, 'full monthly series') + lines.join('\n') + '\n'
}

export function aoiGeoJson(ctx: ExportContext): string {
  return JSON.stringify(aoiToGeoJSON(ctx.aoi, { source: 'Harmony', acknowledgement: FIRMS_ACK }), null, 2)
}

// ---------- calendar figure (standalone SVG, theme colours resolved) ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function calendarSvg(ctx: ExportContext, mode: CalMode, theme: Theme): { svg: string; width: number; height: number } {
  const a = ctx.analysis
  const css = getComputedStyle(document.documentElement)
  const tok = (n: string, f: string) => css.getPropertyValue(n).trim() || f
  const bg = tok('--bg', '#0a0d12'), ink = tok('--ink', '#eceef2'), ink3 = tok('--ink-3', '#8b94a5'), rule = tok('--rule', '#232b37'), accent = tok('--accent', '#ff8a4c')
  const years = [...a.calendar.years].reverse()
  const cw = 40, ch = 18, gap = 2, left = 56, top = 92, annW = 120
  const width = left + 12 * (cw + gap) + 14 + annW + 64
  const gridH = years.length * (ch + gap)
  const height = top + gridH + 26 + ch + 120
  const dom = activityDomain([...a.calendar.value.flat(), ...a.climatology.median])
  const maxTotal = Math.max(1, ...a.annual.total.map((t) => t ?? 0))
  const color = (yi: number, c: number) => {
    const v = a.calendar.value[yi][c]
    if (v == null) return null
    if (mode === 'activity') return seqColor(activityT(v, dom), theme)
    if (mode === 'anomaly') { const r = a.calendar.ratio[yi][c]; return r == null ? divColor(v > 0 ? 1 : 0, theme) : divColor(ratioT(r), theme) }
    const p = a.calendar.percentile[yi][c]
    return divColor(p == null ? 0 : percentileT(p), theme)
  }
  const font = `font-family="Schibsted Grotesk, Segoe UI, Helvetica, Arial, sans-serif"`
  const mono = `font-family="JetBrains Mono, Consolas, Menlo, monospace"`
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
  out.push(`<defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="${ink}" stroke-opacity="0.45" stroke-width="1.4"/></pattern></defs>`)
  out.push(`<rect width="100%" height="100%" fill="${bg}"/>`)
  out.push(`<text x="${left - 40}" y="32" ${font} font-size="20" font-weight="700" fill="${ink}">Harmony · burning calendar</text>`)
  out.push(`<text x="${left - 40}" y="54" ${font} font-size="13" fill="${ink3}">${esc(ctx.aoi.label)} · ${mode} · AFCD-M (MODIS-equivalent active-fire cell-days) · baseline ${ctx.baseline.join('–')}${ctx.kernel === 'mock' ? ' · DEMO DATA' : ''}</text>`)
  MONTHS_SHORT.forEach((m, c) => out.push(`<text x="${left + c * (cw + gap) + cw / 2}" y="${top - 8}" text-anchor="middle" ${font} font-size="10" fill="${ink3}">${m}</text>`))
  years.forEach((y, r) => {
    const yi = a.calendar.years.indexOf(y)
    const yy = top + r * (ch + gap)
    out.push(`<text x="${left - 8}" y="${yy + ch / 2 + 3.5}" text-anchor="end" ${mono} font-size="10" fill="${ink3}">${y}</text>`)
    for (let c = 0; c < 12; c++) {
      const x = left + c * (cw + gap)
      const fill = color(yi, c)
      if (!fill) { out.push(`<rect x="${x + 0.5}" y="${yy + 0.5}" width="${cw - 1}" height="${ch - 1}" rx="2" fill="none" stroke="${rule}"/>`); continue }
      out.push(`<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="2" fill="${fill}"/>`)
      const m = toM(y, c + 1), si = seriesIndex(a, m)
      if (si >= 0 && a.series.provisional[si]) out.push(`<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="2" fill="url(#h)"/>`)
      if (m === a.current.m) out.push(`<rect x="${x - 1.5}" y="${yy - 1.5}" width="${cw + 3}" height="${ch + 3}" rx="3" fill="none" stroke="${accent}" stroke-width="2"/>`)
      const v = a.calendar.value[yi][c]!
      const label = mode === 'activity' ? fmtCell(v) : mode === 'anomaly' ? (a.calendar.ratio[yi][c]?.toFixed(1) ?? '') : String(Math.round(a.calendar.percentile[yi][c] ?? 0))
      out.push(`<text x="${x + cw / 2}" y="${yy + ch / 2 + 3.5}" text-anchor="middle" ${mono} font-size="9" fill="${inkOn(fill)}">${label}</text>`)
    }
    const ai = a.annual.years.indexOf(y)
    const t = ai >= 0 ? a.annual.total[ai] : null
    if (t != null) {
      const bx = left + 12 * (cw + gap) + 10
      const bw = (annW * t) / maxTotal
      out.push(`<rect x="${bx}" y="${yy + 5}" width="${Math.max(1, bw)}" height="${ch - 10}" fill="${a.annual.complete[ai] ? ink3 : 'url(#h)'}" ${a.annual.complete[ai] ? '' : `stroke="${ink3}"`}/>`)
      out.push(`<text x="${bx + bw + 4}" y="${yy + ch / 2 + 3.5}" ${mono} font-size="9" fill="${ink3}">${fmtNum(t)}</text>`)
    }
  })
  const my = top + gridH + 10
  out.push(`<text x="${left - 8}" y="${my + ch / 2 + 3.5}" text-anchor="end" ${font} font-size="10" fill="${ink3}">Median</text>`)
  a.climatology.median.forEach((v, c) => {
    const fill = mode === 'activity' ? seqColor(activityT(v, dom), theme) : divColor(0, theme)
    const x = left + c * (cw + gap)
    out.push(`<rect x="${x}" y="${my}" width="${cw}" height="${ch}" rx="2" fill="${fill}"/>`)
    out.push(`<text x="${x + cw / 2}" y="${my + ch / 2 + 3.5}" text-anchor="middle" ${mono} font-size="9" fill="${inkOn(fill)}">${fmtCell(v)}</text>`)
  })
  // legend ramp
  const ly = my + ch + 22
  for (let i = 0; i < 60; i++) {
    const t = i / 59
    const fill = mode === 'activity' ? seqColor(t, theme) : divColor(t * 2 - 1, theme)
    out.push(`<rect x="${left + i * 4}" y="${ly}" width="4.2" height="9" fill="${fill}"/>`)
  }
  const lt = mode === 'activity' ? ['0', fmtNum(activityInverse(1, dom))] : mode === 'anomaly' ? ['⅛×', '8×'] : ['0', '100']
  out.push(`<text x="${left}" y="${ly + 22}" ${mono} font-size="9" fill="${ink3}">${lt[0]}</text><text x="${left + 240}" y="${ly + 22}" text-anchor="end" ${mono} font-size="9" fill="${ink3}">${esc(lt[1])}</text>`)
  out.push(`<text x="${left + 256}" y="${ly + 8}" ${font} font-size="10" fill="${ink3}">${mode === 'activity' ? 'log scale' : mode === 'anomaly' ? 'ratio to median, log₂' : 'percentile'} · hatched = provisional · outlined = latest month</text>`)
  // acknowledgement (wrapped)
  const words = FIRMS_ACK.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) { if ((cur + ' ' + w).length > 112) { lines.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w }
  lines.push(cur)
  lines.forEach((l, i) => out.push(`<text x="${left - 40}" y="${ly + 46 + i * 13}" ${font} font-size="9.5" fill="${ink3}">${esc(l)}</text>`))
  out.push('</svg>')
  return { svg: out.join(''), width, height }
}

export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG render failed')); img.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}
