/* tslint:disable */
/* eslint-disable */

/**
 * Result of `Kernel.cell_layer`; each `take_*` moves its array out (call once).
 */
export class CellLayerResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    take_cells(): Uint32Array;
    take_values(): Float32Array;
    take_weights(): Float32Array;
    readonly level: number;
}

export class Kernel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `options_json`: `AnalyzeOptions`; returns `Analysis` JSON.
     */
    analyze(options_json: string): string;
    begin(level: number): void;
    /**
     * `options_json`: `CellLayerOptions` (`{ mFrom, mTo, mode, switchM, baseline, dn?, seriesMode? }`).
     */
    cell_layer(options_json: string): CellLayerResult;
    /**
     * Returns the number of rows kept (cells inside the AOI).
     */
    ingest_tile(cell: Uint32Array | number[], stratum: Uint16Array | number[], m: Uint16Array | number[], dn: Uint8Array | number[], meq: Uint32Array | number[], kv: Uint32Array | number[], kvsq: Float32Array | number[], v: Uint32Array | number[], nmod: Uint32Array | number[], nvii: Uint32Array | number[]): number;
    /**
     * `meta_json`: the contents of `meta.json`.
     */
    constructor(meta_json: string);
    /**
     * `flat_coords`: lon/lat pairs of all rings; `ring_offsets`: first vertex index of each ring
     * (a trailing total vertex count is allowed). Returns `AoiInfo` JSON.
     */
    set_aoi(flat_coords: Float64Array | number[], ring_offsets: Uint32Array | number[]): string;
    tiles_for(level: number): string[];
    static version(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_celllayerresult_free: (a: number, b: number) => void;
    readonly __wbg_kernel_free: (a: number, b: number) => void;
    readonly celllayerresult_level: (a: number) => number;
    readonly celllayerresult_take_cells: (a: number) => [number, number];
    readonly celllayerresult_take_values: (a: number) => [number, number];
    readonly celllayerresult_take_weights: (a: number) => [number, number];
    readonly kernel_analyze: (a: number, b: number, c: number) => [number, number, number, number];
    readonly kernel_begin: (a: number, b: number) => [number, number];
    readonly kernel_cell_layer: (a: number, b: number, c: number) => [number, number, number];
    readonly kernel_ingest_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => [number, number, number];
    readonly kernel_new: (a: number, b: number) => [number, number, number];
    readonly kernel_set_aoi: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly kernel_tiles_for: (a: number, b: number) => [number, number, number, number];
    readonly kernel_version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
