import {
  AOI_RADIUS,
  Transform,
  Velocity,
  snapshotComponents,
  snapshotEntity,
  type Entity,
  type EntitySnapshot,
} from "@mmo/shared";
import { playerSessions, type GameCtx } from "../state";

/**
 * Entity streaming core. Each snapshot tick, every player gets:
 *  - spawn:   full snapshots for entities that entered their AOI
 *  - despawn: ids that left the AOI (or were destroyed)
 *  - delta:   dirty networked components of entities they already know
 *  - combat events involving known entities, and an input ack for prediction.
 */
export function sendSnapshots(ctx: GameCtx): void {
  const { world, grid } = ctx;

  grid.clear();
  for (const e of world.query(Transform)) {
    const tr = world.require(e, Transform);
    grid.insert(e, tr.pos.x, tr.pos.z);
  }

  const dirty = world.consumeDirty();

  for (const s of playerSessions(ctx)) {
    const tr = world.require(s.entityId, Transform);
    const inRange = new Set<Entity>(grid.queryCircle(tr.pos.x, tr.pos.z, AOI_RADIUS));
    inRange.add(s.entityId);

    const spawns: EntitySnapshot[] = [];
    const deltas: EntitySnapshot[] = [];
    for (const e of inRange) {
      if (!s.known.has(e)) {
        spawns.push(snapshotEntity(world, e));
      } else {
        const dirtyComps = dirty.get(e);
        if (dirtyComps) {
          const snap = snapshotComponents(world, e, dirtyComps);
          if (snap) deltas.push(snap);
        }
      }
    }
    const despawns: Entity[] = [];
    for (const e of s.known) {
      if (!inRange.has(e)) despawns.push(e);
    }
    s.known = inRange;

    if (spawns.length) s.send({ t: "spawn", entities: spawns });
    if (despawns.length) s.send({ t: "despawn", ids: despawns });
    if (deltas.length) s.send({ t: "delta", entities: deltas });

    const events = ctx.combatEvents.filter(
      (ev) => s.known.has(ev.attacker) || s.known.has(ev.target),
    );
    if (events.length) s.send({ t: "combatEvent", events });

    const casts = ctx.castEvents.filter((ev) => s.known.has(ev.caster));
    if (casts.length) s.send({ t: "castEvent", events: casts });

    const vel = world.get(s.entityId, Velocity);
    s.send({
      t: "inputAck",
      seq: s.lastProcessedSeq,
      x: tr.pos.x,
      z: tr.pos.z,
      y: tr.pos.y,
      vy: vel?.y ?? 0,
    });
  }

  ctx.combatEvents.length = 0;
  ctx.castEvents.length = 0;
}
