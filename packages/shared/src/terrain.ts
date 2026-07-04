/**
 * Heightmap terrain shared by server, client, and editor.
 *
 * The terrain is a square vertex grid centered on the origin. Heights are a
 * Float32Array sampled by heightAt(); paint is a per-vertex splatmap whose
 * blended layer colors become mesh vertex colors. heightAt() interpolates
 * over the SAME two triangles per cell that terrainIndices() emits, so the
 * simulated ground and the rendered ground are the identical surface — and
 * because server and client decode the identical Float32 bits and run the
 * identical math, prediction stays bit-exact on slopes just like on the old
 * flat ground.
 */

export interface TerrainData {
  /** World units per side, centered on the origin. */
  size: number;
  /** Vertices per side; cells per side = resolution - 1. */
  resolution: number;
  /** resolution² heights, row-major: heights[iz * resolution + ix]. */
  heights: Float32Array;
  /** resolution² × 4 weights (0-255) for paint layers 1-4; layer 0 is the remainder. */
  splat: Uint8Array;
}

/** Serialized form stored in world.json and sent over the wire. */
export interface TerrainDefJSON {
  size: number;
  resolution: number;
  /** base64 little-endian Float32Array, resolution². */
  heights: string;
  /** base64 Uint8Array, resolution² × 4. */
  splat: string;
}

/** Absolute vertex-rect update: what the editor brush sends and the server rebroadcasts. */
export interface TerrainPatch {
  x0: number;
  z0: number;
  w: number;
  h: number;
  /** base64 little-endian Float32Array, w*h — present when heights changed. */
  heights?: string;
  /** base64 Uint8Array, w*h*4 — present when paint changed. */
  splat?: string;
}

export const TERRAIN_SIZE = 220;
export const TERRAIN_RESOLUTION = 129;

export interface TerrainLayer {
  id: string;
  name: string;
  /** sRGB hex; renderers convert to their working color space. */
  color: number;
}

/** Layer 0 is the unpainted base; layers 1-4 map to the splat channels. */
export const TERRAIN_LAYERS: readonly TerrainLayer[] = [
  { id: "grass", name: "Grass", color: 0x5d8a4a },
  { id: "dirt", name: "Dirt", color: 0x8a6a48 },
  { id: "rock", name: "Rock", color: 0x7d7f86 },
  { id: "sand", name: "Sand", color: 0xcbb877 },
  { id: "path", name: "Path", color: 0x97865f },
];

export function createFlatTerrain(
  size = TERRAIN_SIZE,
  resolution = TERRAIN_RESOLUTION,
): TerrainData {
  return {
    size,
    resolution,
    heights: new Float32Array(resolution * resolution),
    splat: new Uint8Array(resolution * resolution * 4),
  };
}

// ---------------------------------------------------------------------------
// Sampling

/**
 * Ground height at a world position, clamped to the terrain edge outside it.
 * Interpolates on the render mesh's own triangles (see terrainIndices), not
 * bilinearly, so feet sit exactly on the visible surface.
 */
export function heightAt(t: TerrainData, x: number, z: number): number {
  const res = t.resolution;
  const cell = t.size / (res - 1);
  const half = t.size / 2;
  let gx = (x + half) / cell;
  let gz = (z + half) / cell;
  if (gx < 0) gx = 0;
  else if (gx > res - 1) gx = res - 1;
  if (gz < 0) gz = 0;
  else if (gz > res - 1) gz = res - 1;
  const ix = Math.min(Math.floor(gx), res - 2);
  const iz = Math.min(Math.floor(gz), res - 2);
  const fx = gx - ix;
  const fz = gz - iz;
  const i00 = iz * res + ix;
  const h00 = t.heights[i00];
  const h10 = t.heights[i00 + 1];
  const h01 = t.heights[i00 + res];
  const h11 = t.heights[i00 + res + 1];
  // Each cell splits along the i01-i10 diagonal into two planar triangles.
  if (fx + fz <= 1) {
    return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  }
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

// ---------------------------------------------------------------------------
// Mesh arrays (three-free so both client and editor build from one source)

/** Vertex positions (x, y, z) for the whole grid, resolution² × 3. */
export function terrainPositions(t: TerrainData): Float32Array {
  const res = t.resolution;
  const cell = t.size / (res - 1);
  const half = t.size / 2;
  const out = new Float32Array(res * res * 3);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      out[i * 3] = ix * cell - half;
      out[i * 3 + 1] = t.heights[i];
      out[i * 3 + 2] = iz * cell - half;
    }
  }
  return out;
}

/** Two up-facing triangles per cell, split along the i01-i10 diagonal (matches heightAt). */
export function terrainIndices(t: TerrainData): Uint32Array {
  const res = t.resolution;
  const cells = res - 1;
  const out = new Uint32Array(cells * cells * 6);
  let o = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const i00 = iz * res + ix;
      const i10 = i00 + 1;
      const i01 = i00 + res;
      const i11 = i01 + 1;
      out[o++] = i00;
      out[o++] = i01;
      out[o++] = i10;
      out[o++] = i10;
      out[o++] = i01;
      out[o++] = i11;
    }
  }
  return out;
}

/**
 * Per-vertex colors from the splat weights, resolution² × 3. `palette` is one
 * [r, g, b] (0-1) per TERRAIN_LAYERS entry, already in the renderer's working
 * color space.
 */
export function blendSplatColors(
  t: TerrainData,
  palette: ReadonlyArray<readonly [number, number, number]>,
  out?: Float32Array,
): Float32Array {
  const count = t.resolution * t.resolution;
  const colors = out ?? new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const w1 = t.splat[i * 4] / 255;
    const w2 = t.splat[i * 4 + 1] / 255;
    const w3 = t.splat[i * 4 + 2] / 255;
    const w4 = t.splat[i * 4 + 3] / 255;
    const w0 = Math.max(0, 1 - w1 - w2 - w3 - w4);
    for (let c = 0; c < 3; c++) {
      colors[i * 3 + c] =
        palette[0][c] * w0 +
        palette[1][c] * w1 +
        palette[2][c] * w2 +
        palette[3][c] * w3 +
        palette[4][c] * w4;
    }
  }
  return colors;
}

/**
 * Add paint weight to one vertex. Painting a channel layer steals weight from
 * the other channels when the total would exceed full; painting layer 0
 * (the base) just fades every channel out.
 */
export function addSplatWeight(splat: Uint8Array, vertex: number, layer: number, amount: number): void {
  const base = vertex * 4;
  const amt = Math.round(amount * 255);
  if (layer === 0) {
    for (let c = 0; c < 4; c++) {
      splat[base + c] = Math.max(0, splat[base + c] - amt);
    }
    return;
  }
  const ch = layer - 1;
  const next = Math.min(255, splat[base + ch] + amt);
  let others = 0;
  for (let c = 0; c < 4; c++) {
    if (c !== ch) others += splat[base + c];
  }
  const room = 255 - next;
  if (others > room && others > 0) {
    const scale = room / others;
    for (let c = 0; c < 4; c++) {
      if (c !== ch) splat[base + c] = Math.floor(splat[base + c] * scale);
    }
  }
  splat[base + ch] = next;
}

// ---------------------------------------------------------------------------
// Serialization (pure-JS base64 so Node and browsers produce identical bytes)

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    parts.push(
      B64[b0 >> 2],
      B64[((b0 & 3) << 4) | (b1 >> 4)],
      i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : "=",
      i + 2 < bytes.length ? B64[b2 & 63] : "=",
    );
  }
  return parts.join("");
}

export function base64ToBytes(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64_REV[s.charCodeAt(i)];
    const c1 = B64_REV[s.charCodeAt(i + 1)];
    const c2 = s[i + 2] === "=" ? 0 : B64_REV[s.charCodeAt(i + 2)];
    const c3 = s[i + 3] === "=" ? 0 : B64_REV[s.charCodeAt(i + 3)];
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (o < out.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (o < out.length) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}

/** Explicit little-endian so saved worlds are portable across machines. */
export function floatsToBase64(floats: Float32Array): string {
  const bytes = new Uint8Array(floats.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < floats.length; i++) view.setFloat32(i * 4, floats[i], true);
  return bytesToBase64(bytes);
}

export function base64ToFloats(s: string, expectedLength: number): Float32Array | null {
  const bytes = base64ToBytes(s);
  if (!bytes || bytes.length !== expectedLength * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const v = view.getFloat32(i * 4, true);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

export function terrainToJSON(t: TerrainData): TerrainDefJSON {
  return {
    size: t.size,
    resolution: t.resolution,
    heights: floatsToBase64(t.heights),
    splat: bytesToBase64(t.splat),
  };
}

/** Decode a serialized terrain; malformed data falls back to null. */
export function terrainFromJSON(json: TerrainDefJSON | undefined | null): TerrainData | null {
  if (!json || typeof json !== "object") return null;
  const resolution = Math.floor(json.resolution);
  const size = json.size;
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!Number.isFinite(resolution) || resolution < 2 || resolution > 1025) return null;
  const count = resolution * resolution;
  const heights = typeof json.heights === "string" ? base64ToFloats(json.heights, count) : null;
  const splatBytes = typeof json.splat === "string" ? base64ToBytes(json.splat) : null;
  if (!heights || !splatBytes || splatBytes.length !== count * 4) return null;
  return { size, resolution, heights, splat: splatBytes };
}

// ---------------------------------------------------------------------------
// Patches

/** Snapshot a vertex rect of the current heights/splat as an absolute patch. */
export function extractTerrainPatch(
  t: TerrainData,
  x0: number,
  z0: number,
  w: number,
  h: number,
  include: { heights?: boolean; splat?: boolean },
): TerrainPatch {
  const patch: TerrainPatch = { x0, z0, w, h };
  if (include.heights) {
    const region = new Float32Array(w * h);
    for (let rz = 0; rz < h; rz++) {
      for (let rx = 0; rx < w; rx++) {
        region[rz * w + rx] = t.heights[(z0 + rz) * t.resolution + (x0 + rx)];
      }
    }
    patch.heights = floatsToBase64(region);
  }
  if (include.splat) {
    const region = new Uint8Array(w * h * 4);
    for (let rz = 0; rz < h; rz++) {
      for (let rx = 0; rx < w; rx++) {
        const src = ((z0 + rz) * t.resolution + (x0 + rx)) * 4;
        const dst = (rz * w + rx) * 4;
        for (let c = 0; c < 4; c++) region[dst + c] = t.splat[src + c];
      }
    }
    patch.splat = bytesToBase64(region);
  }
  return patch;
}

/** Apply an absolute patch; returns false (and changes nothing) if malformed. */
export function applyTerrainPatch(t: TerrainData, patch: TerrainPatch): boolean {
  const { x0, z0, w, h } = patch;
  if (![x0, z0, w, h].every((n) => Number.isInteger(n))) return false;
  if (x0 < 0 || z0 < 0 || w < 1 || h < 1) return false;
  if (x0 + w > t.resolution || z0 + h > t.resolution) return false;

  let heights: Float32Array | null = null;
  if (patch.heights !== undefined) {
    heights = base64ToFloats(patch.heights, w * h);
    if (!heights) return false;
  }
  let splat: Uint8Array | null = null;
  if (patch.splat !== undefined) {
    splat = base64ToBytes(patch.splat);
    if (!splat || splat.length !== w * h * 4) return false;
  }

  for (let rz = 0; rz < h; rz++) {
    for (let rx = 0; rx < w; rx++) {
      const dst = (z0 + rz) * t.resolution + (x0 + rx);
      const src = rz * w + rx;
      if (heights) t.heights[dst] = heights[src];
      if (splat) {
        for (let c = 0; c < 4; c++) t.splat[dst * 4 + c] = splat[src * 4 + c];
      }
    }
  }
  return true;
}
