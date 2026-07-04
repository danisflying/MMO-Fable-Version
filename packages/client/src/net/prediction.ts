import {
  GRAVITY,
  JUMP_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  clamp,
  heightAt,
  lerp,
  lerpAngle,
  resolveCircleCollisions,
  type CircleCollider,
  type ClientMessage,
  type TerrainData,
  type WorldBounds,
} from "@mmo/shared";

interface PendingInput {
  seq: number;
  moveX: number;
  moveZ: number;
  jump: boolean;
  dtMs: number;
}

export interface RenderPose {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/**
 * Client-side prediction for the local player: inputs are applied
 * immediately in fixed steps, kept until the server acks them, and replayed
 * on top of the authoritative position. step() must integrate in exactly the
 * server's order (input -> horizontal -> gravity -> ground clamp).
 *
 * Rendering interpolates between the previous and current fixed step
 * (renderPos), and reconciliation corrections are spread over a few ticks
 * (corrX/corrZ decay) instead of snapping, so nothing visually pops.
 */
export class Prediction {
  x = 0;
  y = 0;
  z = 0;
  vy = 0;
  rotY = 0;
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevRotY = 0;
  private corrX = 0;
  private corrZ = 0;
  private seq = 0;
  private pending: PendingInput[] = [];
  private bounds: WorldBounds | null = null;
  private colliders: readonly CircleCollider[] = [];
  private terrain: TerrainData | null = null;

  setBounds(bounds: WorldBounds): void {
    this.bounds = bounds;
  }

  /** Heightmap from welcome; live edits mutate it in place (terrainPatch). */
  setTerrain(terrain: TerrainData): void {
    this.terrain = terrain;
  }

  private groundAt(x: number, z: number): number {
    return this.terrain ? heightAt(this.terrain, x, z) : 0;
  }

  /** Current prop collision circles, sorted by entity id (same as server). */
  setColliders(colliders: readonly CircleCollider[]): void {
    this.colliders = colliders;
  }

  reset(x: number, z: number): void {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.y = this.prevY = this.groundAt(x, z);
    this.vy = 0;
    this.corrX = this.corrZ = 0;
    this.pending = [];
  }

  /** Integrate one input step locally and produce the message to send. */
  applyInput(
    moveX: number,
    moveZ: number,
    rotY: number,
    jump: boolean,
    dtMs: number,
  ): ClientMessage {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevRotY = this.rotY;
    this.rotY = rotY;
    this.step(moveX, moveZ, jump, dtMs);
    // Glide any outstanding reconciliation error away over a few ticks.
    this.corrX *= 0.7;
    this.corrZ *= 0.7;
    if (Math.abs(this.corrX) < 0.001) this.corrX = 0;
    if (Math.abs(this.corrZ) < 0.001) this.corrZ = 0;
    const seq = ++this.seq;
    this.pending.push({ seq, moveX, moveZ, jump, dtMs });
    if (this.pending.length > 200) this.pending.shift();
    return { t: "input", seq, moveX, moveZ, rotY, jump: jump || undefined };
  }

  /**
   * After a terrain patch: mirror the server's re-snap of grounded players so
   * an edit under our feet doesn't leave prediction fighting the next ack.
   */
  resnapToGround(): void {
    if (this.vy !== 0) return;
    this.y = this.prevY = this.groundAt(this.x, this.z);
  }

  /** Server processed inputs up to `seq`; rebase prediction on its state. */
  ack(seq: number, x: number, z: number, y: number, vy: number): void {
    const beforeX = this.x;
    const beforeY = this.y;
    const beforeZ = this.z;
    this.pending = this.pending.filter((p) => p.seq > seq);
    this.x = x;
    this.y = y;
    this.z = z;
    this.vy = vy;
    for (const p of this.pending) this.step(p.moveX, p.moveZ, p.jump, p.dtMs);
    // Shift the interpolation base by the correction so it doesn't pop
    // mid-frame, and feed small corrections into the smoothing offset so
    // they glide instead of snapping. Big jumps (respawn) snap immediately.
    const dx = this.x - beforeX;
    const dz = this.z - beforeZ;
    this.prevX += dx;
    this.prevY += this.y - beforeY;
    this.prevZ += dz;
    if (Math.hypot(dx, dz) < 2) {
      this.corrX -= dx;
      this.corrZ -= dz;
    } else {
      this.corrX = 0;
      this.corrZ = 0;
    }
  }

  /** Smooth render pose: alpha is the fraction of the current tick elapsed. */
  renderPos(alpha: number): RenderPose {
    const a = clamp(alpha, 0, 1);
    const x = lerp(this.prevX, this.x, a) + this.corrX;
    const z = lerp(this.prevZ, this.z, a) + this.corrZ;
    return {
      x,
      // Interpolated y can cut under a ridge between two grounded steps;
      // never render below the terrain surface.
      y: Math.max(this.groundAt(x, z), lerp(this.prevY, this.y, a)),
      z,
      rotY: lerpAngle(this.prevRotY, this.rotY, a),
    };
  }

  private step(moveX: number, moveZ: number, jump: boolean, dtMs: number): void {
    let mx = moveX;
    let mz = moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const dt = dtMs / 1000;
    // Same order as the server: jump trigger, airborne test, horizontal,
    // collide, clamp, then gravity or ground-stick.
    if (jump && this.y <= this.groundAt(this.x, this.z)) this.vy = JUMP_SPEED;
    const airborne = this.vy !== 0 || this.y > this.groundAt(this.x, this.z);
    const resolved = resolveCircleCollisions(
      this.x + mx * PLAYER_MOVE_SPEED * dt,
      this.z + mz * PLAYER_MOVE_SPEED * dt,
      PLAYER_RADIUS,
      this.colliders,
    );
    this.x = resolved.x;
    this.z = resolved.z;
    if (this.bounds) {
      this.x = clamp(this.x, this.bounds.min.x, this.bounds.max.x);
      this.z = clamp(this.z, this.bounds.min.z, this.bounds.max.z);
    }
    const ground = this.groundAt(this.x, this.z);
    if (airborne) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= ground) {
        this.y = ground;
        this.vy = 0;
      }
    } else {
      this.y = ground;
    }
  }
}
