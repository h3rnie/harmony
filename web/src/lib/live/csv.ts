// "Live hotspots CSV": the fetched near-real-time rows, built client-side (nothing else includes live rows).
import { FIRMS_ACK } from '../config'
import { LIVE_CONF, LIVE_SATS, type LiveResponse } from './types'

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (t: number) => {
  const d = new Date(t * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}
const csvText = (s: string) => (/[",\n#]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function liveCsv(d: LiveResponse, inside: Uint8Array, areaLabel: string): string {
  const head = [
    `# Harmony — live FIRMS hotspots (near-real-time, provisional; not screened for static heat sources)`,
    `# Area: ${areaLabel.replace(/[\r\n]+/g, ' ')}; queried bbox ${d.bbox.join(',')} (W,S,E,N); last ${d.days} UTC days`,
    `# Sources: ${Object.entries(d.sources).map(([k, v]) => `${k} ${v.error ? `failed (${v.error})` : `${v.rows} rows`}`).join('; ')}`,
    `# Fetched ${iso(d.fetched_at)}; local_solar_date = date(UTC + lon/15 h); confidence: VIIRS l/n/h, MODIS <30/30-79/>=80`,
    `# ${FIRMS_ACK}`,
  ]
  const rows = ['latitude,longitude,acq_utc,local_solar_date,satellite,confidence,frp_mw,daynight,inside_area']
  for (let i = 0; i < d.n; i++) {
    const solar = new Date((d.t[i] + d.lon[i] * 240) * 1000).toISOString().slice(0, 10)
    rows.push([d.lat[i], d.lon[i], iso(d.t[i]), solar, csvText(LIVE_SATS[d.sat[i]] ?? ''), LIVE_CONF[d.conf[i]] ?? '', d.frp[i], d.dn[i] === 1 ? 'N' : 'D', inside[i] ? 1 : 0].join(','))
  }
  return head.join('\n') + '\n' + rows.join('\n') + '\n'
}
