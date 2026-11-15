# Deployment

The app runs on Vercel at `https://harmony.hernie.me`; the data is served from a Cloudflare R2 bucket at `https://data.harmony.hernie.me`. This page lists what exists, the ordered steps to go live, how to check the result, how to roll back and refresh the data, and what it costs.

## What runs where

| Part | Where | Notes |
| --- | --- | --- |
| Static app (`web/dist`) | Vercel project `harmony`, team `her` (Hernie, Pro plan) | Root Directory `web/`, framework Vite, Node.js 24, Fluid Compute, functions in `iad1`. Configuration in `web/vercel.ts`. |
| `GET /api/live`, `GET /api/live/status` | Vercel Function `web/api/live.ts`, `web/api/live/status.ts` | Wrap `web/server/liveCore.ts` (FIRMS NRT proxy). |
| `GET`/`POST /api/brief`, `POST /api/ask` | Vercel Function `web/api/brief.ts`, `web/api/ask.ts` | Wrap `web/server/ai/core.ts` (Anthropic primary, OpenRouter fallback). NDJSON stream. |
| Per-visitor limits and the daily AI cap | `web/server/limits.ts` | Redis when `REDIS_URL` (or Upstash `KV_REST_API_URL` + `KV_REST_API_TOKEN`) is set, otherwise counted per function instance. |
| Data (`data/dist`) | R2 bucket `harmony-data`, custom domain `data.harmony.hernie.me` | Uploaded by `scripts/upload-data.mjs` under `v/<version>/`. |
| DNS | Cloudflare, zone `hernie.me` | `harmony` CNAME to Vercel (DNS only); `data.harmony` is managed by R2 (proxied). |

The functions are thin wrappers: all request handling is in `web/server/fetchRoutes.ts` (Web `Request` to `Response`), and the logic stays in the same cores that `vite dev` uses through its plugins. Contracts and status codes are the same in both; the deployed routes add the limits below.

### Limits on the deployed routes

| Route | Limit | Over the limit |
| --- | --- | --- |
| `/api/brief` POST + `/api/ask` POST, per visitor | 20 per 10 minutes and 60 per day | `429 rate_limited` with `Retry-After` |
| AI requests that reach a model, all visitors | `AI_DAILY_CAP` per UTC day (default 300; `0` turns AI off) | `GET /api/brief` reports `available: false, capReached: true`, so the page shows the rule-based brief; a POST gets `503 daily_cap` with `Retry-After` until midnight UTC |
| `/api/live`, per visitor | 40 per 10 minutes and 400 per day | `429 rate_limited` with `Retry-After` |
| `/api/live` upstream, per instance | 12 FIRMS batches a minute, plus the FIRMS key budget guard | `429` / `503 busy` (unchanged from the dev route) |

A visitor is identified by an HMAC-SHA256 of the IP address that Vercel reports (`x-vercel-forwarded-for`), keyed with `IP_HASH_SECRET`; the raw address is never stored or logged. Responses served from the in-process response cache do not count against the daily cap. Every route refuses cross-site browser requests with `403 forbidden` (an `Origin` that is not the request's own host, `https://harmony.hernie.me` or the deployment's own Vercel URLs, or `Sec-Fetch-Site: cross-site`). Request bodies are capped at 16,896 bytes (brief) and 68,608 bytes (ask) before parsing.

Without a Redis store each function instance counts on its own, so the daily cap holds per instance, not in total. With Fluid Compute one instance usually serves most of the traffic of a small site, but a burst can start more. Connect a store (step 3) before relying on the cap.

### `/api/live` response size

A 900 square-degree box over 7 days is the largest request the route accepts. Measured on 2026-11-15 (northern-hemisphere savanna season): 202,574 detections for the box 15,-10,45,20, 7.74 MB of JSON, 1.60 MB with gzip and 1.70 MB with Brotli. The function compresses the body when the client accepts it (browsers always do) and always streams it in 64 KB chunks; streamed responses are not subject to Vercel's 4.5 MB response limit, and an uncompressed 7.74 MB response was served through the preview without error. A peak season could roughly double these figures, which still fits.

### Headers and caching

`web/vercel.ts` sets, for every path: a Content-Security-Policy, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security` (two years, subdomains included), `Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that turns off camera, microphone, geolocation and similar features. There is no COEP header: onnxruntime-web runs single-threaded, so the app needs no cross-origin isolation, and COEP would block the basemap.

The CSP allows: scripts and workers from the site itself, `'wasm-unsafe-eval'` for WebAssembly (the kernel and onnxruntime-web), `blob:` workers, inline style attributes, and connections and images from `https://tiles.openfreemap.org` (style JSON, TileJSON, vector tiles, glyphs and sprites all come from that host) and the data origin (`https://data.harmony.hernie.me`, plus the origin of `VITE_DATA_BASE` when it is set at build time). `frame-ancestors 'none'`. Scripts have no `'unsafe-inline'` and no `'unsafe-eval'`; the theme bootstrap that used to be inline is `web/public/theme-init.js`.

Files under `/assets/` (content-hashed by Vite) are cached for a year as immutable. `index.html`, `/` and `theme-init.js` revalidate on every load. The SPA fallback rewrites only extension-less paths outside `/api/` and `/assets/` to `index.html`, so a missing asset, data file or API route stays a 404.

## Current state (2026-11-16)

- The app is live at <https://harmony.hernie.me> (Vercel project `harmony` in team `her`, production). The pitch deck is at `/demo`.
- The repository root is linked (`.vercel/`, git-ignored). `.vercelignore` uploads `web/` and the three pnpm workspace files at the root (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`); the install runs from the root lockfile with pnpm 10.
- Environment variables set for Preview and Production: `FIRMS_MAP_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `IP_HASH_SECRET` (sensitive), and `AI_PROVIDER=anthropic`, `AI_PROFILE=sonnet-high`, `AI_FALLBACK=openrouter`, `AI_DAILY_CAP=300`, `VITE_SOURCE_URL=https://github.com/h3rnie/harmony`, `VITE_DATA_BASE=https://data.harmony.hernie.me/v/20261115T130031Z`.
- The Cloudflare DNS record for the app: `harmony.hernie.me CNAME e6a619f808cfdc33.vercel-dns-016.com`, DNS only.
- R2 bucket `harmony-data` with the custom domain `data.harmony.hernie.me` holds version `20261115T130031Z` (tiles, overview, model and the points archive).
- No Redis store is connected; the limits and the daily cap count per function instance (step 3 below is still open).
- Preview deployments are protected by Vercel Authentication (the team default). Use `vercel curl <url>` for checks; `vercel curl` uses the CLI login.
- Known and accepted: a missing file under `/assets/` or under a data version prefix is answered 404 with the same one-year immutable cache header as a real file, because neither host can set headers by status. A browser that requested a file before it existed keeps the 404; a hard reload clears it.

## Going live, in order

Commands run from the repository root unless stated otherwise. For pnpm network commands behind the local TLS proxy, `export NODE_USE_SYSTEM_CA=1` first.

### 1. R2 bucket and custom domain

The bucket `harmony-data` and its custom domain exist. To recreate them elsewhere: Cloudflare dashboard > R2 > Create bucket (`harmony-data`, automatic location, Standard storage class); then the bucket > Settings > Custom Domains > Connect Domain > `data.harmony.hernie.me`. Cloudflare creates the DNS record itself (proxied); do not add one by hand. Wait until the custom domain shows status Active and certificate Active:

```bash
cf r2 buckets domains custom list --bucket-name harmony-data
```

Leave the bucket's `r2.dev` public URL disabled; the custom domain is the only public path.

### 2. Upload credentials

`scripts/upload-data.mjs` has two backends and picks one by what is configured in `.env.local`:

- **S3 API (preferred for the 11 GB archive):** create an R2 API token at R2 > Manage API tokens > Create API token, permission **Object Read & Write**, scoped to the bucket `harmony-data`, no expiry or a short one. Put the Access Key ID and Secret Access Key in `.env.local` as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (the secret is shown once). `R2_ACCOUNT_ID`, `R2_BUCKET=harmony-data` and `R2_PUBLIC_BASE=https://data.harmony.hernie.me` are already there. Applying CORS through the S3 API needs a token with **Admin Read & Write**; with an Object token, use the CLI or the dashboard for CORS (step 4).
- **Cloudflare CLI:** without S3 keys the script runs `cf r2 objects put` once per object with the CLI's own login. It cannot set `Cache-Control` per object (see step 5) and is slower per object.

### 3. Shared counter store for the limits (owner action)

The limits and the daily cap need a store shared by all function instances. Two options from the Vercel Marketplace; neither could be provisioned without the owner:

- **Redis (Redis Cloud), free 30 MB plan, no payment method.** The first install of this integration needs the Marketplace terms accepted in the browser: open `https://vercel.com/her/~/integrations/accept-terms/redis?source=cli`, read and accept, then run:

  ```bash
  vercel integration add redis --billing-plan 24686 --meta Region=iad1 --name harmony-limits --no-env-pull
  ```

  It connects the database to the project and sets `REDIS_URL` for all environments. The free plan keeps data in memory without persistence; a restart of that database resets the counters, which only means a fresh daily count.
- **Upstash for Redis**, already installed on the team for another project. A new database for this project is offered only on paid plans (Pay As You Go, $0.20 per 100,000 commands, needs a payment method). `vercel integration add upstash/upstash-kv --billing-plan paid --name harmony-limits` sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

The code accepts either set of variables. After connecting, redeploy (environment variable changes apply to new deployments only). A deployment's logs show `[limits] shared store unavailable` once if the store cannot be reached; the routes then fall back to per-instance counting for 30 seconds at a time.

### 4. Bucket CORS

The rules are in `scripts/r2-cors.json`: `GET` and `HEAD` from `https://harmony.hernie.me`, the preview origins `https://harmony-*-her.vercel.app`, and `http://localhost:5173`, `:4173` (and the `127.0.0.1` forms); request header `Range` (and the conditional headers) allowed; `Content-Range`, `Accept-Ranges`, `Content-Length` and `ETag` exposed; max age 86,400 s.

```bash
node scripts/upload-data.mjs --cors
```

Or paste the JSON at R2 > `harmony-data` > Settings > CORS policy. The `--verify` step checks a preflight from a preview origin; if R2 does not match the mid-hostname wildcard, list the preview origins explicitly.

### 5. Upload the data

Use one version id for every part of one dataset. The default is taken from `data/dist/meta.json` (`generated`); for the 2026-11-15 build it is `20261115T130031Z`.

```bash
node scripts/upload-data.mjs --dry-run                       # what would go up: 12,714 objects, 11.1 GB
node scripts/upload-data.mjs --version 20261115T130031Z \
  --prefix meta.json --prefix validation.json --prefix watch.json \
  --prefix tiles/ --prefix overview/ --prefix ml/              # ~4,400 objects, 0.56 GB: enough for the app
node scripts/upload-data.mjs --version 20261115T130031Z --prefix points/   # 8,291 objects, 10.6 GB: CSV export only
node scripts/upload-data.mjs --version 20261115T130031Z --verify
```

Every run skips objects that are already uploaded with the same size and MD5, so an interrupted run is resumed by running it again. The points archive is used only by the CSV hotspot export; the app works without it and reports the export as unavailable.

Caching: with the S3 backend every object carries `Cache-Control: public, max-age=31536000, immutable` (a version prefix is never rewritten). With the CLI backend objects have no `Cache-Control`; add a Response Header Transform Rule on the zone (Rules > Transform Rules > Modify Response Header) for `http.host eq "data.harmony.hernie.me" and starts_with(http.request.uri.path, "/v/")` that sets `Cache-Control` to `public, max-age=31536000, immutable`. Do not add a "cache everything" Cache Rule for this host without testing CORS: Cloudflare's cache does not vary on `Origin`, so a cached `Access-Control-Allow-Origin` for one origin (say a preview) could be served to another (production).

### 6. Point a preview at the data and check it

```bash
printf '%s' 'https://data.harmony.hernie.me/v/20261115T130031Z' | vercel env add VITE_DATA_BASE -e preview --no-sensitive --yes
vercel deploy                                   # prints the preview URL
```

`VITE_DATA_BASE` is read at build time, so it takes effect only in a new deployment. Then work through the checklist below on the preview URL (log in to Vercel in the browser first, or use `vercel curl` for the HTTP checks).

### 7. Production

```bash
printf '%s' 'https://data.harmony.hernie.me/v/20261115T130031Z' | vercel env add VITE_DATA_BASE -e production --no-sensitive --yes
vercel deploy --prod
```

`vercel promote <preview-url>` is the alternative when the checked preview was built with the same environment values.

### 8. Attach the domain

```bash
vercel domains add harmony.hernie.me harmony
```

(or Vercel > project `harmony` > Settings > Domains > Add `harmony.hernie.me`). The DNS record Vercel asks for is already in Cloudflare and must stay as it is:

| Name | Type | Target | Proxy status | TTL |
| --- | --- | --- | --- | --- |
| `harmony` (zone `hernie.me`) | CNAME | `e6a619f808cfdc33.vercel-dns-016.com` | DNS only (grey cloud) | Auto or 300 |

Vercel's domain check reports this record as correct; its generic recommendation, `cname.vercel-dns.com`, also works. Keep it unproxied: Vercel advises against a proxy in front of it, which interferes with its certificate issuance, caching and firewall. Vercel issues the certificate within a few minutes of the domain being added.

## Verification checklist

On the preview (step 6), then on `https://harmony.hernie.me` (step 8):

1. The page loads without the "Demo data" badge; the browser console shows no Content-Security-Policy messages and no failed requests other than intentional 404s.
2. The globe (Global pulse) renders its overview layers; the watchlist shows entries.
3. A preset area (for example the Gran Chaco) and a drawn area both produce the calendar and the brief; network requests to `data.harmony.hernie.me` return `206` with `Access-Control-Allow-Origin` equal to the page origin.
4. `vercel curl <url>/api/live/status` returns `available: true`; "Show live detections" draws points for a small area.
5. `vercel curl <url>/api/brief` returns `available: true`; one brief streams in the page (one model call).
6. A cross-site request is refused: `curl -s -H 'Origin: https://example.com' https://harmony.hernie.me/api/live/status` returns `403 {"error":"forbidden",...}`.
7. `node scripts/upload-data.mjs --version <V> --verify` passes (object counts, ranged GET, CORS).
8. Response headers on `/` include the CSP and the other security headers; `/assets/*` carries `max-age=31536000, immutable`.
9. Function logs (`vercel logs --deployment <url>`) show no `internal_error` and no key material.

Checked on preview deployments on 2026-11-15, first in demo-data mode: items 1 (no CSP messages; only the expected `/data/*` 404s), 4 (a 2 x 2 degree box returned 8 detections, Brotli-encoded), 5 (a brief streamed: 23 deltas, one call), 6 and 8, the 405/415/400 responses, the 7.74 MB worst-case live response, and the daily cap (a preview deployed with `--env AI_DAILY_CAP=1` answered `503 daily_cap` and reported `available: false`). Items 2, 3 and 7 need the uploaded data; the upload has since been done and the live site reads it.

## Rollback

- **App:** `vercel rollback` (previous production deployment) or `vercel rollback <deployment-url>`; instant, no rebuild. Data URLs are baked into each build, so a rollback also returns to the data version that build used.
- **AI off now:** set `AI_DAILY_CAP=0` (`vercel env rm AI_DAILY_CAP production`, then add it with `0`) and redeploy; the page falls back to the rule-based brief. Removing `ANTHROPIC_API_KEY` has the same effect.
- **Domain:** `vercel domains rm harmony.hernie.me` detaches it (the DNS record can stay).
- **Data:** old versions stay in the bucket until deleted, so rolling the app back to a build that points at an older `v/<version>/` works as long as that prefix exists.

## Refreshing the data later

1. Rebuild `data/dist` with the pipeline ([OPERATIONS.md](OPERATIONS.md)); `meta.json` gets a new `generated` time and so a new default version id.
2. Upload the new version (step 5) and `--verify` it. The old version keeps serving the live site meanwhile.
3. Set `VITE_DATA_BASE` to the new prefix (Preview first, then Production: `vercel env rm VITE_DATA_BASE <env>` and add it again), deploy and check a preview, then `vercel deploy --prod`.
4. After a few days, delete the previous version's prefix. List it first and delete only that prefix; nothing else in the bucket should go.

A refresh is atomic for readers: a page that is already open keeps reading the version it was built with, and a new page load gets the new build and the new prefix together. Uploading only the changed tiles under the old version would mix two builds and is not supported.

## Costs

- **R2:** storage is billed per GB-month after the first 10 GB a month; one version is 11.2 GB, two versions during a refresh about 22 GB. Uploading one version is about 12,700 Class A operations (the free allowance is 1 million a month). Page views read tiles with ranged GETs, which are Class B operations (10 million a month free); an area analysis reads tens to a few hundred tiles. Egress through the custom domain is free. Check current prices at https://developers.cloudflare.com/r2/pricing/.
- **Vercel (Pro):** static traffic counts against the plan's Fast Data Transfer allowance (the main bundle is about 0.6 MB compressed). Functions are billed by active CPU, provisioned memory while a request is in flight and invocations; the AI routes mostly wait on the provider, which accrues little active CPU. The live route spends some CPU parsing the FIRMS CSV and compressing the answer.
- **AI:** the brief measured on 2026-11-15 used 1,095 uncached input tokens, 5,781 tokens written to the prompt cache and 1,298 output tokens (Claude Sonnet 5.5, high effort); an Ask answer used 285 input, 5,434 cache-write and 375 output tokens. At the default cap of 300 model-bound requests a day, the worst case is roughly 300 x (1.1 k input + 5.8 k cache write + 1.3 k output) = 0.33 M input, 1.7 M cache-write and 0.39 M output tokens a day, less when repeated questions hit the prompt cache (cache reads are billed at a fraction of input) or the server's response cache. Multiply by the provider's current per-token prices to get a daily ceiling, and set `AI_DAILY_CAP` from that.
- **FIRMS:** free; the key allows 5,000 transactions per 10 minutes, and the route guards it.

## Not automated

- Accepting Marketplace terms and choosing a paid or free plan for the counter store (step 3).
- Creating R2 API tokens (the Cloudflare CLI login cannot create them).
- The Response Header Transform Rule for `Cache-Control` when the CLI backend is used.
- Deleting old data versions.
- Rotating `FIRMS_MAP_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` and `IP_HASH_SECRET`: `vercel env rm <NAME> <env>`, add the new value through stdin (`... | vercel env add <NAME> -e production,preview --sensitive --yes`), redeploy.
- Git-based deployments: the project is not connected to the GitHub repository. `vercel git connect` (with Root Directory `web/`, already set) makes every push build a preview and every push to the production branch deploy to production.
- `node scripts/check-wasm.mjs` is not part of the Vercel build (the build uploads only `web/` and the pnpm workspace files); run it before committing a change under `crates/`.
