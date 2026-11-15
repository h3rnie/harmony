# Harmony web app

The Svelte 5 + Vite front end of Harmony: the guided analysis of an area, the burning calendar, the Global pulse,
the live layer, the situation brief and the exports. The project overview, the method and the data build are in the
[root README](../README.md); hosting is in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Run it

```sh
pnpm --dir web install
pnpm --dir web dev       # http://localhost:5173; serves data/dist at /data and the /api routes
pnpm --dir web check     # svelte-check + TypeScript
pnpm --dir web build     # production build into web/dist
pnpm --dir web preview   # serve the build, /api routes included
```

The WASM kernel is committed in `src/lib/kernel/pkg/`, so no Rust toolchain is needed. Rebuild it with
`pnpm --dir web build:wasm` only after changing `crates/`. Without `data/dist`, the app runs on a synthetic demo
kernel and says so on screen.

## Layout

- `src/` the app (`lib/kernel` is the contract with the Rust/WASM kernel; `lib/components` the analysed view;
  `lib/pulse` the Global pulse; `lib/export` the CSV, figure and hotspot exports).
- `server/` the `/api/brief`, `/api/ask` and `/api/live` handlers shared by the dev server and the deployment
  functions in `api/`. API keys are read on the server only and never reach the browser.
