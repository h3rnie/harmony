/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the pipeline output (meta.json, tiles/, points/). Default "/data". */
  readonly VITE_DATA_BASE?: string
  /** Public URL of the source repository (AGPL-3.0-only). Shown in About; unset shows the licence text without a link. */
  readonly VITE_SOURCE_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
