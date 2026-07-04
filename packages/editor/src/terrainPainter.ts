import * as THREE from "three";
import {
  TERRAIN_LAYERS,
  addSplatWeight,
  extractTerrainPatch,
  heightAt,
  type TerrainData,
  type TerrainPatch,
} from "@mmo/shared";

export type BrushMode = "raise" | "lower" | "smooth" | "flatten" | "paint";

const MODES: { id: BrushMode; label: string }[] = [
  { id: "raise", label: "Raise" },
  { id: "lower", label: "Lower" },
  { id: "smooth", label: "Smooth" },
  { id: "flatten", label: "Flatten" },
  { id: "paint", label: "Paint" },
];

/** Sculpt rate at full strength, units/sec; lerp rates are per-second factors. */
const RAISE_RATE = 10;
const FLATTEN_RATE = 6;
const SMOOTH_RATE = 8;
const PAINT_RATE = 3;
/** Cap per-event dt so a hitch doesn't spike the brush. */
const MAX_STEP_MS = 100;
/** Live-send the accumulated dirty region at most this often during a stroke. */
const FLUSH_MS = 120;

export interface TerrainPainterOpts {
  body: HTMLElement;
  scene: THREE.Scene;
  getTerrain: () => TerrainData;
  /** Called after every brush application (mesh re-upload + prop re-snap). */
  onEdited: () => void;
  sendPatch: (patch: TerrainPatch) => void;
}

/**
 * Brush state + the Terrain window UI. main.ts feeds it pointer events on the
 * terrain surface; edits apply to the local heightmap immediately and stream
 * to the server as absolute region patches while the stroke runs.
 */
export class TerrainPainter {
  mode: BrushMode = "raise";
  radius = 6;
  strength = 0.5;
  layer = 1;

  /** Set when the user picks a mode in the window; main switches to the terrain tool. */
  onModeChosen: (() => void) | null = null;

  private readonly opts: TerrainPainterOpts;
  private readonly cursor: THREE.Line;
  private readonly swatchRow: HTMLDivElement;
  private modeButtons = new Map<BrushMode, HTMLButtonElement>();

  private flattenTarget = 0;
  private lastApplyAt = 0;
  private lastFlushAt = 0;
  // Dirty vertex rect accumulated since the last flush (inclusive).
  private dirtyMinX = Infinity;
  private dirtyMinZ = Infinity;
  private dirtyMaxX = -Infinity;
  private dirtyMaxZ = -Infinity;
  private dirtyHeights = false;
  private dirtySplat = false;

  constructor(opts: TerrainPainterOpts) {
    this.opts = opts;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(33 * 3), 3));
    this.cursor = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0x4f8df9, depthTest: false, transparent: true }),
    );
    this.cursor.renderOrder = 999;
    this.cursor.visible = false;
    opts.scene.add(this.cursor);

    // ── Window UI ──────────────────────────────────────────────
    const modes = document.createElement("div");
    modes.className = "brush-modes";
    for (const m of MODES) {
      const btn = document.createElement("button");
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        this.setMode(m.id);
        this.onModeChosen?.();
      });
      this.modeButtons.set(m.id, btn);
      modes.appendChild(btn);
    }

    const radius = sliderRow("Radius", 1, 24, 0.5, this.radius, (v) => (this.radius = v));
    const strength = sliderRow("Strength", 0.05, 1, 0.05, this.strength, (v) => (this.strength = v));

    this.swatchRow = document.createElement("div");
    this.swatchRow.className = "swatches";
    TERRAIN_LAYERS.forEach((layer, i) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.title = layer.name;
      b.style.background = `#${layer.color.toString(16).padStart(6, "0")}`;
      b.addEventListener("click", () => {
        this.layer = i;
        this.updateUi();
      });
      this.swatchRow.appendChild(b);
    });

    const hint = document.createElement("div");
    hint.className = "muted";
    hint.textContent = "Drag on the ground to apply. Shift inverts Raise/Lower.";

    opts.body.style.display = "flex";
    opts.body.style.flexDirection = "column";
    opts.body.style.gap = "8px";
    opts.body.append(modes, radius, strength, this.swatchRow, hint);
    this.updateUi();
  }

  setMode(mode: BrushMode): void {
    this.mode = mode;
    this.updateUi();
  }

  /** Position the brush ring on the surface; null hides it. */
  setCursor(point: { x: number; z: number } | null): void {
    this.cursor.visible = point !== null;
    if (!point) return;
    const t = this.opts.getTerrain();
    const pos = this.cursor.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const x = point.x + Math.cos(a) * this.radius;
      const z = point.z + Math.sin(a) * this.radius;
      pos.setXYZ(i, x, heightAt(t, x, z) + 0.15, z);
    }
    pos.needsUpdate = true;
    this.cursor.geometry.computeBoundingSphere();
  }

  strokeStart(point: { x: number; z: number }): void {
    const t = this.opts.getTerrain();
    this.flattenTarget = heightAt(t, point.x, point.z);
    this.lastApplyAt = performance.now();
    this.lastFlushAt = performance.now();
    this.apply(point, false);
  }

  /** One brush application at `point`; call from pointermove during a stroke. */
  apply(point: { x: number; z: number }, invert: boolean): void {
    const now = performance.now();
    const dt = Math.min(now - this.lastApplyAt, MAX_STEP_MS) / 1000;
    this.lastApplyAt = now;
    if (dt <= 0) return;

    const t = this.opts.getTerrain();
    const res = t.resolution;
    const cell = t.size / (res - 1);
    const half = t.size / 2;
    const r = this.radius;
    const minX = Math.max(0, Math.ceil((point.x - r + half) / cell));
    const maxX = Math.min(res - 1, Math.floor((point.x + r + half) / cell));
    const minZ = Math.max(0, Math.ceil((point.z - r + half) / cell));
    const maxZ = Math.min(res - 1, Math.floor((point.z + r + half) / cell));
    if (minX > maxX || minZ > maxZ) return;

    let mode = this.mode;
    if (invert && (mode === "raise" || mode === "lower")) {
      mode = mode === "raise" ? "lower" : "raise";
    }

    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const wx = ix * cell - half;
        const wz = iz * cell - half;
        const d = Math.hypot(wx - point.x, wz - point.z);
        if (d > r) continue;
        // Cosine falloff: full effect at the center, feathered to the edge.
        const f = 0.5 + 0.5 * Math.cos((Math.PI * d) / r);
        const i = iz * res + ix;
        switch (mode) {
          case "raise":
            t.heights[i] += RAISE_RATE * this.strength * f * dt;
            break;
          case "lower":
            t.heights[i] -= RAISE_RATE * this.strength * f * dt;
            break;
          case "flatten":
            t.heights[i] +=
              (this.flattenTarget - t.heights[i]) *
              Math.min(1, FLATTEN_RATE * this.strength * f * dt);
            break;
          case "smooth": {
            const hl = t.heights[iz * res + Math.max(0, ix - 1)];
            const hr = t.heights[iz * res + Math.min(res - 1, ix + 1)];
            const hd = t.heights[Math.max(0, iz - 1) * res + ix];
            const hu = t.heights[Math.min(res - 1, iz + 1) * res + ix];
            const avg = (hl + hr + hd + hu) / 4;
            t.heights[i] += (avg - t.heights[i]) * Math.min(1, SMOOTH_RATE * this.strength * f * dt);
            break;
          }
          case "paint":
            addSplatWeight(t.splat, i, this.layer, PAINT_RATE * this.strength * f * dt);
            break;
        }
      }
    }

    this.dirtyMinX = Math.min(this.dirtyMinX, minX);
    this.dirtyMinZ = Math.min(this.dirtyMinZ, minZ);
    this.dirtyMaxX = Math.max(this.dirtyMaxX, maxX);
    this.dirtyMaxZ = Math.max(this.dirtyMaxZ, maxZ);
    if (mode === "paint") this.dirtySplat = true;
    else this.dirtyHeights = true;

    this.opts.onEdited();
    if (now - this.lastFlushAt >= FLUSH_MS) this.flush();
  }

  strokeEnd(): void {
    this.flush();
  }

  /** Send the accumulated dirty rect as one absolute patch. */
  private flush(): void {
    this.lastFlushAt = performance.now();
    if (!this.dirtyHeights && !this.dirtySplat) return;
    const t = this.opts.getTerrain();
    const patch = extractTerrainPatch(
      t,
      this.dirtyMinX,
      this.dirtyMinZ,
      this.dirtyMaxX - this.dirtyMinX + 1,
      this.dirtyMaxZ - this.dirtyMinZ + 1,
      { heights: this.dirtyHeights, splat: this.dirtySplat },
    );
    this.opts.sendPatch(patch);
    this.dirtyMinX = this.dirtyMinZ = Infinity;
    this.dirtyMaxX = this.dirtyMaxZ = -Infinity;
    this.dirtyHeights = this.dirtySplat = false;
  }

  private updateUi(): void {
    for (const [id, btn] of this.modeButtons) {
      btn.classList.toggle("active", id === this.mode);
    }
    this.swatchRow.style.display = this.mode === "paint" ? "flex" : "none";
    this.swatchRow.querySelectorAll(".swatch").forEach((el, i) => {
      el.classList.toggle("active", i === this.layer);
    });
  }
}

function sliderRow(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): HTMLLabelElement {
  const row = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = `${label}: ${value}`;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    caption.textContent = `${label}: ${v}`;
    onInput(v);
  });
  row.append(caption, input);
  return row;
}
