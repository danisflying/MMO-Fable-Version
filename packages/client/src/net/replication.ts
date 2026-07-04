import {
  lerp,
  lerpAngle,
  type EntitySnapshot,
  type HealthData,
  type ModelRefData,
  type NpcTagData,
  type PlayerTagData,
  type TransformData,
} from "@mmo/shared";

export interface InterpSample {
  t: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface NetEntity {
  id: number;
  transform?: TransformData;
  health?: HealthData;
  modelRef?: ModelRefData;
  playerTag?: PlayerTagData;
  npcTag?: NpcTagData;
  propTag?: { propId: string };
  /** Position history (stamped at receipt) for render-time interpolation. */
  buffer: InterpSample[];
}

const MAX_BUFFER = 20;

/**
 * Client-side mirror of the streamed entity set. Spawn/delta messages merge
 * component data in; transform updates also feed the interpolation buffer.
 */
export class Replication {
  readonly entities = new Map<number, NetEntity>();
  selfId = 0;

  onAdded: ((e: NetEntity) => void) | null = null;
  onRemoved: ((id: number) => void) | null = null;
  onChanged: ((e: NetEntity, names: string[]) => void) | null = null;

  applySpawn(snaps: EntitySnapshot[]): void {
    for (const snap of snaps) {
      const e: NetEntity = { id: snap.id, buffer: [] };
      this.merge(e, snap.c);
      this.entities.set(snap.id, e);
      this.onAdded?.(e);
    }
  }

  applyDespawn(ids: number[]): void {
    for (const id of ids) {
      if (this.entities.delete(id)) this.onRemoved?.(id);
    }
  }

  applyDelta(snaps: EntitySnapshot[]): void {
    for (const snap of snaps) {
      const e = this.entities.get(snap.id);
      if (!e) continue;
      this.merge(e, snap.c);
      this.onChanged?.(e, Object.keys(snap.c));
    }
  }

  private merge(e: NetEntity, c: Record<string, unknown>): void {
    if (c.transform) {
      e.transform = c.transform as TransformData;
      const sample = {
        t: performance.now(),
        x: e.transform.pos.x,
        y: e.transform.pos.y,
        z: e.transform.pos.z,
        rotY: e.transform.rotY,
      };
      // Teleports (death respawn) should snap, not slide across the map.
      const last = e.buffer[e.buffer.length - 1];
      if (last && Math.hypot(sample.x - last.x, sample.z - last.z) > 15) e.buffer.length = 0;
      e.buffer.push(sample);
      if (e.buffer.length > MAX_BUFFER) e.buffer.splice(0, e.buffer.length - MAX_BUFFER);
    }
    if (c.health) e.health = c.health as HealthData;
    if (c.modelRef) e.modelRef = c.modelRef as ModelRefData;
    if (c.playerTag) e.playerTag = c.playerTag as PlayerTagData;
    if (c.npcTag) e.npcTag = c.npcTag as NpcTagData;
    if (c.propTag) e.propTag = c.propTag as { propId: string };
  }

  /** Interpolated transform at renderTime (performance.now() - INTERP_DELAY_MS). */
  sample(id: number, renderTime: number): InterpSample | null {
    const e = this.entities.get(id);
    if (!e || e.buffer.length === 0) return null;
    const buf = e.buffer;
    if (renderTime <= buf[0].t) return buf[0];
    const last = buf[buf.length - 1];
    if (renderTime >= last.t) return last;
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i].t <= renderTime) {
        const a = buf[i];
        const b = buf[i + 1];
        // Samples can arrive in the same millisecond; avoid dividing by ~0.
        if (b.t - a.t < 1) return b;
        const t = (renderTime - a.t) / (b.t - a.t);
        return {
          t: renderTime,
          x: lerp(a.x, b.x, t),
          y: lerp(a.y, b.y, t),
          z: lerp(a.z, b.z, t),
          rotY: lerpAngle(a.rotY, b.rotY, t),
        };
      }
    }
    return last;
  }
}
