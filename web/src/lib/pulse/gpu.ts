// WebGPU globe: one full-screen triangle; the fragment shader ray-casts an orthographic sphere, converts the hit
// to lon/lat and samples the land mask, two month layers (temporal interpolation), the climatology and a 1-D
// colour ramp. Glow = coarse mip levels of the same month layers (mips built on the CPU at upload).
import type { Theme } from '../color'
import { H, W, type YearBytes } from './data'
import { globeLayout, palette, pickGlobe, rampBytes, rotation, type Frame, type PulseRenderer } from './shared'

const MIPS = 6
// usage flags (lib.dom lacks the GPUBufferUsage / GPUTextureUsage namespaces)
const BUF_UNIFORM = 0x40, BUF_COPY_DST = 0x08, TEX_COPY_DST = 0x02, TEX_BINDING = 0x04
const MAX_DPR = 2
const MAX_TEXTURES = 6

const WGSL = /* wgsl */ `
struct U {
  c0: vec4f, c1: vec4f, c2: vec4f,
  res: vec2f, radius: f32, t: f32,
  center: vec2f, la: f32, lb: f32,
  mode: f32, light: f32, glow: f32, pad: f32,
  bg: vec4f, ocean: vec4f, land: vec4f, grid: vec4f, rim: vec4f,
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sData: sampler;
@group(0) @binding(2) var tA: texture_2d_array<f32>;
@group(0) @binding(3) var tB: texture_2d_array<f32>;
@group(0) @binding(4) var tClim: texture_2d_array<f32>;
@group(0) @binding(5) var tLand: texture_2d<f32>;
@group(0) @binding(6) var tRamp: texture_2d<f32>;
@group(0) @binding(7) var sRamp: sampler;

const PI = 3.141592653589793;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn month(uv: vec2f, lod: f32) -> f32 {
  let a = textureSampleLevel(tA, sData, uv, i32(u.la), lod).r;
  let b = textureSampleLevel(tB, sData, uv, i32(u.lb), lod).r;
  return mix(a, b, u.t);
}
fn clim(uv: vec2f, lod: f32) -> f32 {
  let a = textureSampleLevel(tClim, sData, uv, i32(u.la), lod).r;
  let b = textureSampleLevel(tClim, sData, uv, i32(u.lb), lod).r;
  return mix(a, b, u.t);
}
// Soft bloom: 8 rotated taps on a mid mip level (single coarse taps show axis-aligned blocks).
fn bloom(uv: vec2f, lod: f32, rad: f32) -> f32 {
  var acc = month(uv, lod);
  for (var i = 0; i < 8; i++) {
    let a = f32(i) * 0.785398 + 0.39;
    acc += month(uv + vec2f(cos(a) * 0.5, sin(a)) * rad, lod);
  }
  return acc / 9.0;
}
fn ramp(t: f32, row: f32) -> vec3f {
  return textureSampleLevel(tRamp, sRamp, vec2f(clamp(t, 0.0, 1.0), row), 0.0).rgb;
}
fn over(base: vec3f, c: vec3f, k: f32) -> vec3f {
  // additive bloom on a dark ground, soft tint on a light one
  return select(base + c * k, mix(base, c, clamp(k, 0.0, 1.0)), u.light > 0.5);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = (pos.xy - u.center) / u.radius * vec2f(1.0, -1.0);
  let r = length(p);
  let cover = clamp((1.0 - r) * u.radius / 1.5 + 0.5, 0.0, 1.0);
  let z = sqrt(max(0.0, 1.0 - r * r));
  let w = mat3x3f(u.c0.xyz, u.c1.xyz, u.c2.xyz) * vec3f(p, z);
  let lon = atan2(w.x, w.z);
  let lat = asin(clamp(w.y, -1.0, 1.0));
  let uv = vec2f(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  // ground: quiet land over a darker ocean, gentle limb shading for form (no day/night: this is data)
  let land = textureSampleLevel(tLand, sData, uv, 0.0).r;
  var col = mix(u.ocean.rgb, u.land.rgb, smoothstep(0.25, 0.75, land)) * (0.8 + 0.2 * z);

  // graticule every 30 deg, ~1 px wide, meridians fade towards the poles
  let latD = lat * 180.0 / PI;
  let pxDeg = (180.0 / PI) / (u.radius * max(z, 0.08));
  let dLon = abs(fract(lon * 180.0 / PI / 30.0 + 0.5) - 0.5) * 30.0 * cos(lat);
  let dLat = abs(fract(latD / 30.0 + 0.5) - 0.5) * 30.0;
  let gm = (1.0 - smoothstep(0.35, 1.1, dLon / pxDeg)) * (1.0 - smoothstep(60.0, 80.0, abs(latD)));
  let gp = 1.0 - smoothstep(0.35, 1.1, dLat / pxDeg);
  col = mix(col, u.grid.rgb, max(gm, gp) * u.grid.a);

  if (u.mode < 0.5) {
    let v = month(uv, 0.0);
    let t = sqrt(v);
    let g = bloom(uv, 1.5, 0.006) * 0.6 + bloom(uv, 2.5, 0.014) * 0.4;
    col = over(col, ramp(0.55 + 0.45 * sqrt(g), 0.25), sqrt(g) * 0.75 * u.glow);
    col = mix(col, ramp(t, 0.25), smoothstep(0.0, 0.22, t));
  } else {
    let d = month(uv, 0.0) - clim(uv, 0.0);
    let a = sign(d) * min(1.0, sqrt(abs(d) / 0.35));
    let db = month(uv, 2.0) - clim(uv, 2.0);
    col = over(col, ramp(0.5 + 0.5 * sign(db), 0.75), min(1.0, sqrt(abs(db)) * 0.9) * 0.6 * u.glow);
    col = mix(col, ramp(0.5 + 0.5 * a, 0.75), smoothstep(0.12, 0.4, abs(a)));
  }

  // atmosphere: thin rim inside the limb and a short halo outside
  col = mix(col, u.rim.rgb, pow(1.0 - z, 4.0) * u.rim.a * 0.55);
  let halo = exp(-max(r - 1.0, 0.0) * 22.0) * u.rim.a * 0.35;
  let bg = mix(u.bg.rgb, u.rim.rgb, halo);
  return vec4f(mix(bg, col, cover), 1.0);
}
`

/** Box-filtered mip chain of 12 layers (level 0 = the bytes themselves). */
function mipChain(src: Uint8Array, w: number, h: number, layers: number, levels: number) {
  const out: { w: number; h: number; data: Uint8Array }[] = [{ w, h, data: src }]
  for (let l = 1; l < levels; l++) {
    const p = out[l - 1], nw = Math.max(1, p.w >> 1), nh = Math.max(1, p.h >> 1)
    const d = new Uint8Array(nw * nh * layers)
    for (let k = 0; k < layers; k++) {
      const so = k * p.w * p.h, dO = k * nw * nh
      for (let y = 0; y < nh; y++) {
        const r0 = so + 2 * y * p.w, r1 = r0 + p.w
        for (let x = 0; x < nw; x++) {
          const i = 2 * x
          d[dO + y * nw + x] = (p.data[r0 + i] + p.data[r0 + i + 1] + p.data[r1 + i] + p.data[r1 + i + 1] + 2) >> 2
        }
      }
    }
    out.push({ w: nw, h: nh, data: d })
  }
  return out
}

export async function createGpuRenderer(
  canvas: HTMLCanvasElement, theme: Theme, clim: YearBytes, land: { w: number; h: number; px: Uint8Array },
  onLost: (reason: string) => void,
): Promise<PulseRenderer> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new Error('WebGPU unavailable')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter')
  const device = await adapter.requestDevice()
  let destroyed = false
  device.lost.then((info) => { if (!destroyed) onLost(info.message || info.reason || 'device lost') })

  const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext | null
  if (!ctx) throw new Error('No WebGPU canvas context')
  const format = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device, format, alphaMode: 'opaque' })

  const module = device.createShaderModule({ code: WGSL })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })
  const ubuf = device.createBuffer({ size: 176, usage: BUF_UNIFORM | BUF_COPY_DST })
  const sData = device.createSampler({
    addressModeU: 'repeat', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
  })
  const sRamp = device.createSampler({ addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear' })

  function layers(bytes: YearBytes): GPUTexture {
    const tex = device.createTexture({
      size: [W, H, 12], format: 'r8unorm', mipLevelCount: MIPS, usage: TEX_BINDING | TEX_COPY_DST,
    })
    for (const [level, m] of mipChain(bytes, W, H, 12, MIPS).entries()) {
      device.queue.writeTexture({ texture: tex, mipLevel: level }, m.data as Uint8Array<ArrayBuffer>, { bytesPerRow: m.w, rowsPerImage: m.h }, [m.w, m.h, 12])
    }
    return tex
  }
  const climTex = layers(clim)
  const landTex = device.createTexture({ size: [land.w, land.h], format: 'r8unorm', usage: TEX_BINDING | TEX_COPY_DST })
  device.queue.writeTexture({ texture: landTex }, land.px as Uint8Array<ArrayBuffer>, { bytesPerRow: land.w }, [land.w, land.h])
  const rampTex = device.createTexture({ size: [256, 2], format: 'rgba8unorm', usage: TEX_BINDING | TEX_COPY_DST })
  let pal = palette(theme)
  const setRamp = (th: Theme) => device.queue.writeTexture({ texture: rampTex }, rampBytes(th) as Uint8Array<ArrayBuffer>, { bytesPerRow: 1024 }, [256, 2])
  setRamp(theme)

  // Year textures keyed by their byte arrays (the data cache owns identity), small LRU.
  const texs = new Map<YearBytes, GPUTexture>()
  function texFor(bytes: YearBytes): GPUTexture {
    let t = texs.get(bytes)
    if (t) { texs.delete(bytes); texs.set(bytes, t); return t }
    t = layers(bytes)
    texs.set(bytes, t)
    while (texs.size > MAX_TEXTURES) {
      const [k, old] = texs.entries().next().value!
      texs.delete(k)
      old.destroy()
    }
    return t
  }
  let bind: { a: GPUTexture; b: GPUTexture; g: GPUBindGroup } | null = null
  const u = new Float32Array(44)

  return {
    kind: 'webgpu',
    resize() {
      const dpr = Math.min(MAX_DPR, devicePixelRatio || 1)
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    },
    setTheme(th) { pal = palette(th); setRamp(th) },
    pick(x, y, f) { return pickGlobe(x, y, canvas.clientWidth, canvas.clientHeight, f) },
    render(f: Frame) {
      if (destroyed) return
      const a = texFor(f.a), b = texFor(f.b)
      if (!bind || bind.a !== a || bind.b !== b) {
        bind = {
          a, b,
          g: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: ubuf } },
              { binding: 1, resource: sData },
              { binding: 2, resource: a.createView({ dimension: '2d-array' }) },
              { binding: 3, resource: b.createView({ dimension: '2d-array' }) },
              { binding: 4, resource: climTex.createView({ dimension: '2d-array' }) },
              { binding: 5, resource: landTex.createView() },
              { binding: 6, resource: rampTex.createView() },
              { binding: 7, resource: sRamp },
            ],
          }),
        }
      }
      const s = canvas.width / Math.max(1, canvas.clientWidth)
      const g = globeLayout(canvas.clientWidth, canvas.clientHeight, f.zoom)
      const m = rotation(f.lon0, f.lat0)
      u.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], 0)
      u.set([canvas.width, canvas.height, g.r * s, f.t, g.cx * s, g.cy * s, f.la, f.lb, f.mode === 'anomaly' ? 1 : 0, pal.light ? 1 : 0, pal.glow, 0], 12)
      u.set([...pal.bg, ...pal.ocean, ...pal.land, ...pal.grid, ...pal.rim], 24)
      device.queue.writeBuffer(ubuf, 0, u)
      const enc = device.createCommandEncoder()
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind.g)
      pass.draw(3)
      pass.end()
      device.queue.submit([enc.finish()])
    },
    destroy() {
      destroyed = true
      for (const t of texs.values()) t.destroy()
      texs.clear()
      climTex.destroy(); landTex.destroy(); rampTex.destroy(); ubuf.destroy()
      try { ctx.unconfigure() } catch { /* already gone */ }
      device.destroy()
    },
  }
}
