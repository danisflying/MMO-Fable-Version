import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MODELS_DIR } from "../paths";

/** Hand-tuned radii that beat the auto-derived bounding box (e.g. tree trunks). */
const COLLIDER_OVERRIDES: Record<string, number> = {};

/** Props thinner than this don't collide (decals, flowers, ...). */
const MIN_RADIUS = 0.2;

interface GltfJson {
  meshes?: { primitives: { attributes: Record<string, number> }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

/** Footprint radius (max |x|/|z| extent) from a GLB's POSITION accessors. */
function footprintRadius(file: string): number | null {
  try {
    const buf = readFileSync(file);
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return null;
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8")) as GltfJson;
    let r = 0;
    for (const mesh of json.meshes ?? []) {
      for (const prim of mesh.primitives) {
        const acc = json.accessors?.[prim.attributes.POSITION];
        if (!acc?.min || !acc.max) continue;
        r = Math.max(r, Math.abs(acc.min[0]), Math.abs(acc.max[0]), Math.abs(acc.min[2]), Math.abs(acc.max[2]));
      }
    }
    return r > 0 ? r : null;
  } catch {
    return null;
  }
}

/**
 * Collider radius per model name, derived from GLB bounds at boot. Sent to
 * clients in `welcome` so prediction uses the exact same values — clients
 * never re-derive these.
 */
export function loadColliderRadii(): Record<string, number> {
  const radii: Record<string, number> = {};
  if (!existsSync(MODELS_DIR)) return radii;
  for (const file of readdirSync(MODELS_DIR)) {
    if (!file.endsWith(".glb")) continue;
    const name = file.slice(0, -4);
    const r = COLLIDER_OVERRIDES[name] ?? footprintRadius(join(MODELS_DIR, file));
    if (r !== null && r >= MIN_RADIUS) radii[name] = r;
  }
  return radii;
}
