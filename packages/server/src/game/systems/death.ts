import {
  Health,
  NpcAi,
  NpcTag,
  PlayerTag,
  Transform,
  Velocity,
  heightAt,
  type Entity,
} from "@mmo/shared";
import { sessionByEntity, type GameCtx } from "../../state";
import { onNpcKilled } from "../quests";

/** Remove an owner's summoned pack outright (boss died, reset, or despawned). */
export function despawnMinions(ctx: GameCtx, owner: Entity): void {
  const pack = ctx.minionsByOwner.get(owner);
  if (!pack) return;
  ctx.minionsByOwner.delete(owner);
  for (const m of pack) {
    if (ctx.world.isAlive(m)) ctx.world.destroy(m);
    ctx.lastAttackerByVictim.delete(m);
  }
}

/**
 * Handle hp<=0: players respawn at the spawn point with full hp,
 * NPCs are destroyed and queued for respawn at their spawner.
 */
export function deathSystem(ctx: GameCtx): void {
  const { world } = ctx;
  // Owners can vanish without dying (editor despawn); orphaned packs go too.
  for (const owner of ctx.minionsByOwner.keys()) {
    if (!world.isAlive(owner)) despawnMinions(ctx, owner);
  }
  for (const e of world.query(Health)) {
    // query() is a snapshot: a dying boss despawns its pack mid-iteration,
    // so later entries may already be gone.
    if (!world.isAlive(e)) continue;
    const health = world.require(e, Health);
    if (health.hp > 0) continue;

    if (world.has(e, PlayerTag)) {
      const tr = world.require(e, Transform);
      const { x, z } = ctx.def.spawnPoint;
      tr.pos = { x, y: heightAt(ctx.terrain, x, z), z };
      health.hp = health.maxHp;
      const vel = world.get(e, Velocity);
      if (vel) vel.y = 0; // don't carry mid-jump momentum through a respawn
      world.markDirty(e, Transform);
      world.markDirty(e, Health);
      ctx.lastAttackerByVictim.delete(e);
      // The kill is the fight's end: everything hunting this player gives up
      // and heads home (npcAi's disengage path — cancels casts, despawns
      // packs) instead of chasing the corpse run to the spawn point.
      for (const npc of world.query(NpcAi)) {
        const ai = world.require(npc, NpcAi);
        if (ai.target === e) ai.target = 0;
      }
      sessionByEntity(ctx, e)?.send({ t: "death" });
    } else if (world.has(e, NpcTag)) {
      const killer = ctx.lastAttackerByVictim.get(e);
      ctx.lastAttackerByVictim.delete(e);
      if (killer && world.isAlive(killer) && world.has(killer, PlayerTag)) {
        const session = sessionByEntity(ctx, killer);
        if (session) onNpcKilled(ctx, session, world.require(e, NpcTag).kind);
      }
      const ai = world.get(e, NpcAi);
      // Summoned minions (spawnerId "") die for good; their pack dies with them.
      if (ai && ai.spawnerId) {
        const spawner = ctx.def.spawners.find((s) => s.id === ai.spawnerId);
        ctx.npcRespawns.push({
          spawnerId: ai.spawnerId,
          at: ctx.time + (spawner?.respawnMs ?? 10000),
        });
        ctx.npcsBySpawner.get(ai.spawnerId)?.delete(e);
      }
      despawnMinions(ctx, e);
      world.destroy(e);
    }
  }
}
