import {
  GRAVITY,
  JUMP_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_RADIUS,
  Transform,
  Velocity,
  clamp,
  heightAt,
  resolveCircleCollisions,
} from "@mmo/shared";
import { playerSessions, type GameCtx } from "../../state";

/**
 * Inputs are queued one per client tick; ticks line up 1:1 with server ticks,
 * so the queue hovers around 0-1 and only grows under send jitter or a
 * client-side stall (hidden tab, GC). Dropping an input forces a visible
 * reconciliation on the client, so allow a few ticks of backlog before
 * dropping — worst case it adds 200ms of transient input latency instead.
 * (connections.ts separately hard-caps the queue at 10 as a flood guard.)
 */
const MAX_BACKLOG = 4;

/**
 * Consume one input per player per tick and integrate their movement fully
 * (horizontal + jump physics) right here. Players advance only when an input
 * is consumed — never on starved ticks — so server state is a pure function
 * of the input sequence and matches client prediction bit-for-bit. The math
 * and order must mirror Prediction.step exactly.
 */
export function inputSystem(ctx: GameCtx, dt: number): void {
  const { world } = ctx;
  const { min, max } = ctx.def.bounds;
  for (const s of playerSessions(ctx)) {
    const vel = world.get(s.entityId, Velocity);
    const tr = world.get(s.entityId, Transform);
    if (!vel || !tr) continue;

    // Catch up after a client stall: skip old inputs but ack their seqs so
    // the client drops them from its pending list and reconciles cleanly.
    const q = s.inputQueue;
    while (q.length > MAX_BACKLOG) s.lastProcessedSeq = q.shift()!.seq;

    const inp = q.shift();
    if (!inp) {
      vel.x = 0;
      vel.z = 0;
      continue;
    }

    let mx = inp.moveX;
    let mz = inp.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    vel.x = mx * PLAYER_MOVE_SPEED;
    vel.z = mz * PLAYER_MOVE_SPEED;
    // A grounded player's y equals heightAt() exactly (set below from the
    // same floats prediction reads), so <= is a reliable grounded test.
    if (inp.jump && tr.pos.y <= heightAt(ctx.terrain, tr.pos.x, tr.pos.z)) vel.y = JUMP_SPEED;

    const airborne = vel.y !== 0 || tr.pos.y > heightAt(ctx.terrain, tr.pos.x, tr.pos.z);
    if (vel.x !== 0 || vel.z !== 0 || airborne) {
      const resolved = resolveCircleCollisions(
        tr.pos.x + vel.x * dt,
        tr.pos.z + vel.z * dt,
        PLAYER_RADIUS,
        ctx.propColliders,
      );
      tr.pos.x = clamp(resolved.x, min.x, max.x);
      tr.pos.z = clamp(resolved.z, min.z, max.z);
      const ground = heightAt(ctx.terrain, tr.pos.x, tr.pos.z);
      if (airborne) {
        vel.y -= GRAVITY * dt;
        tr.pos.y += vel.y * dt;
        if (tr.pos.y <= ground) {
          tr.pos.y = ground;
          vel.y = 0;
        }
      } else {
        // Grounded: stick to the slope (up hills instantly, down into dips).
        tr.pos.y = ground;
      }
      world.markDirty(s.entityId, Transform);
    }

    if (tr.rotY !== inp.rotY) {
      tr.rotY = inp.rotY;
      world.markDirty(s.entityId, Transform);
    }
    s.lastProcessedSeq = inp.seq;
  }
}
