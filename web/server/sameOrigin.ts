// Cross-site guard shared by the server routes (/api/live, /api/brief, /api/ask). Framework-agnostic: takes Node's
// IncomingHttpHeaders or a fetch `Headers` object, so a serverless handler can use it too.
//
// A request is refused when the browser says it comes from another site:
//   - `Sec-Fetch-Site: cross-site`, or
//   - an `Origin` header that is present and not this server's own origin (compared with the `Host` header;
//     an opaque `Origin: null` is refused too).
// Requests without these headers (curl, server-to-server, the smoke scripts) and same-origin requests pass. The aim is
// that another website cannot make a visitor's browser spend this server's FIRMS or model quota.
//
// Behind a proxy that rewrites Host (or for a second public hostname), pass the extra origins that count as "own"
// in `allowedOrigins` (exact "scheme://host[:port]" strings, compared case-insensitively).

export type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null }

function header(h: HeaderBag, name: string): string | undefined {
  if (typeof (h as { get?: unknown }).get === 'function') return (h as { get(n: string): string | null }).get(name) ?? undefined
  const v = (h as Record<string, string | string[] | undefined>)[name]
  return Array.isArray(v) ? v[0] : v
}

/** Why the request must be refused, or null when it is same-origin or carries no browser origin. */
export function crossSiteReason(headers: HeaderBag, allowedOrigins: readonly string[] = []): string | null {
  if (header(headers, 'sec-fetch-site')?.trim().toLowerCase() === 'cross-site') return 'cross-site request'
  const origin = header(headers, 'origin')?.trim()
  if (origin == null || origin === '') return null
  let host: string
  let normalized: string
  try { const u = new URL(origin); host = u.host.toLowerCase(); normalized = u.origin.toLowerCase() } catch { return 'cross-origin request' }
  if (!host) return 'cross-origin request' // "null" and other opaque origins
  if (allowedOrigins.some((a) => a.toLowerCase() === normalized)) return null
  const own = header(headers, 'host')?.trim().toLowerCase()
  return own && own === host ? null : 'cross-origin request'
}
