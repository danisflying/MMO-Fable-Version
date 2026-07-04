import {
  NPC_RADIUS,
  PlayerTag,
  Transform,
  Velocity,
  clamp,
  heightAt,
  resolveCircleCollisions,
} from "@mmo/shared";
import type { GameCtx } from "../../state";

/**
 * Integrate NPC velocities into positions, with prop collision, clamped to
 * world bounds. Players are integrated per-input in inputSystem (so their
 * state stays a pure function of the input sequence for prediction) and are
 * skipped here.
 */
export function movementSystem(ctx: GameCtx, dt: number): void {
  const { world, def } = ctx;
  const { min, max } = def.bounds;
  for (const e of world.query(Transform, Velocity)) {
    if (world.has(e, PlayerTag)) continue;
    const vel = world.require(e, Velocity);
    if (vel.x === 0 && vel.z === 0) continue;
    const tr = world.require(e, Transform);
    const resolved = resolveCircleCollisions(
      tr.pos.x + vel.x * dt,
      tr.pos.z + vel.z * dt,
      NPC_RADIUS,
      ctx.propColliders,
    );
    tr.pos.x = clamp(resolved.x, min.x, max.x);
    tr.pos.z = clamp(resolved.z, min.z, max.z);
    tr.pos.y = heightAt(ctx.terrain, tr.pos.x, tr.pos.z);
    world.markDirty(e, Transform);
  }
}
