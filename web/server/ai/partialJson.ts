// Incremental extraction of top-level string fields from a JSON document that is still streaming, so the card can
// fill progressively even though structured output arrives as one JSON text.

/** Decoded value of top-level-ish string field `key` as far as the buffer goes; null when the key has not started. */
export function partialString(buf: string, key: string): string | null {
  const m = new RegExp('"' + key + '"\\s*:\\s*"').exec(buf)
  if (!m) return null
  let i = m.index + m[0].length
  let out = ''
  while (i < buf.length) {
    const c = buf[i]
    if (c === '"') return out
    if (c === '\\') {
      const n = buf[i + 1]
      if (n === undefined) break
      if (n === 'u') {
        const hex = buf.slice(i + 2, i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'b' ? '\b' : n === 'f' ? '\f' : n
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Feed raw JSON text chunks; get `(field, newText)` callbacks for the watched fields. */
export class FieldStreamer {
  private buf = ''
  private sent = new Map<string, number>()
  private readonly fields: readonly string[]
  private readonly emit: (field: string, text: string) => void
  constructor(fields: readonly string[], emit: (field: string, text: string) => void) {
    this.fields = fields
    this.emit = emit
  }

  push(chunk: string): void {
    this.buf += chunk
    for (const f of this.fields) {
      const v = partialString(this.buf, f)
      if (v == null) continue
      const from = this.sent.get(f) ?? 0
      if (v.length > from) {
        this.emit(f, v.slice(from))
        this.sent.set(f, v.length)
      }
    }
  }

  reset(): void {
    this.buf = ''
    this.sent.clear()
  }
}

/** Parse a JSON object out of model text: tolerates code fences and prose around the object. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s)
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch { return null }
  }
  const direct = tryParse(t)
  if (direct) return direct
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  return a >= 0 && b > a ? tryParse(t.slice(a, b + 1)) : null
}
