/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the pipeline output (meta.json, tiles/, points/). Default "/data". */
  readonly VITE_DATA_BASE?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
