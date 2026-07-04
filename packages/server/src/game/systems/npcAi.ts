import {
  ABILITIES,
  Combat,
  Health,
  NPC_MOVE_SPEED,
  NpcAi,
  NpcTag,
  Transform,
  Velocity,
  distSq,
  kitRange,
  type CombatData,
  type Entity,
  type TransformData,
  type Vec3,
  type VelocityData,
} from "@mmo/shared";
import { playerSessions, type GameCtx } from "../../state";
import { cancelCast } from "./combat";
import { despawnMinions } from "./death";

/** NPCs drink their own medicine below this health fraction. */
const HEAL_BELOW = 0.5;

/**
 * Biggest off-cooldown hit in the kit that reaches the target. combatSystem
 * re-validates everything, so this is a preference, not an authorization.
 */
function pickAttack(combat: CombatData, dist: number, time: number): string | null {
  let best: string | null = null;
  let bestDamage = 0;
  for (const id of combat.abilities) {
    const def = ABILITIES[id];
    if (!def || def.damage <= bestDamage) continue;
    if (def.range < dist) continue;
    if (time - (combat.cooldowns[id] ?? -1e9) < def.cooldownMs) continue;
    best = id;
    bestDamage = def.damage;
  }
  return best;
}

function pickHeal(combat: CombatData, time: number): string | null {
  for (const id of combat.abilities) {
    const def = ABILITIES[id];
    if (!def || !def.heal) continue;
    if (time - (combat.cooldowns[id] ?? -1e9) < def.cooldownMs) continue;
    return id;
  }
  return null;
}

/** A ready summon ability — used only while the previous pack is fully dead. */
function pickSummon(ctx: GameCtx, e: Entity, combat: CombatData): string | null {
  for (const id of combat.abilities) {
    const def = ABILITIES[id];
    if (!def || !def.summon) continue;
    if (ctx.time - (combat.cooldowns[id] ?? -1e9) < def.cooldownMs) continue;
    const pack = ctx.minionsByOwner.get(e);
    if (pack) {
      for (const m of pack) if (!ctx.world.isAlive(m)) pack.delete(m);
      if (pack.size > 0) continue;
    }
    return id;
  }
  return null;
}

/**
 * Boss phase 2: once, when hp crosses the def's threshold, the phase-2
 * abilities join the kit and everyone nearby hears about it.
 */
function checkBossPhase(ctx: GameCtx, e: Entity, combat: CombatData): void {
  const ai = ctx.world.require(e, NpcAi);
  if (ai.phase2) return;
  const tag = ctx.world.get(e, NpcTag);
  const boss = tag && ctx.npcsByKind[tag.kind]?.boss;
  if (!boss) return;
  const health = ctx.world.require(e, Health);
  if (health.hp > health.maxHp * boss.phase2AtFrac) return;
  ai.phase2 = true;
  for (const id of boss.phase2Abilities) {
    if (!combat.abilities.includes(id)) combat.abilities.push(id);
  }
  combat.range = kitRange(combat.abilities);
  for (const s of playerSessions(ctx)) {
    if (s.known.has(e)) {
      s.send({ t: "chatMsg", channel: "local", from: tag.kind, text: "roars in fury!" });
    }
  }
}

const WANDER_RADIUS = 6;
const ARRIVE_DIST = 0.3;

function steerToward(tr: TransformData, vel: VelocityData, target: Vec3, speed: number): void {
  const dx = target.x - tr.pos.x;
  const dz = target.z - tr.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  vel.x = (dx / len) * speed;
  vel.z = (dz / len) * speed;
  tr.rotY = Math.atan2(dx, dz);
}

/** Disengage: cancel any cast, send home, and despawn a boss's leftover pack. */
function resetFromChase(ctx: GameCtx, e: Entity, combat: CombatData): void {
  const ai = ctx.world.require(e, NpcAi);
  ai.state = "return";
  ai.moveTarget = null;
  cancelCast(ctx, e, combat);
  despawnMinions(ctx, e);
}

function nearestPlayerWithin(ctx: GameCtx, pos: Vec3, radius: number): Entity | 0 {
  let best: Entity | 0 = 0;
  let bestDistSq = radius * radius;
  for (const s of playerSessions(ctx)) {
    const ptr = ctx.world.get(s.entityId, Transform);
    const hp = ctx.world.get(s.entityId, Health);
    if (!ptr || !hp || hp.hp <= 0) continue;
    const d = distSq(ptr.pos.x, ptr.pos.z, pos.x, pos.z);
    if (d <= bestDistSq) {
      bestDistSq = d;
      best = s.entityId;
    }
  }
  return best;
}

export function npcAiSystem(ctx: GameCtx): void {
  const { world } = ctx;
  for (const e of world.query(NpcAi, Transform, Velocity, Combat)) {
    // query() is a snapshot: a boss resetting mid-iteration despawns its
    // pack, so later entries may already be gone.
    if (!world.isAlive(e)) continue;
    const ai = world.require(e, NpcAi);
    const tr = world.require(e, Transform);
    const vel = world.require(e, Velocity);
    const combat = world.require(e, Combat);

    // Drop invalid targets (disconnected, dead, despawned).
    if (ai.target && !world.isAlive(ai.target)) ai.target = 0;
    if (ai.target) {
      const thp = world.get(ai.target, Health);
      if (!thp || thp.hp <= 0) ai.target = 0;
    }

    if (ai.state === "wander" && !ai.target) {
      const found = nearestPlayerWithin(ctx, tr.pos, ai.aggroRadius);
      if (found) {
        ai.target = found;
        ai.state = "chase";
      }
    }

    switch (ai.state) {
      case "chase": {
        if (!ai.target) {
          resetFromChase(ctx, e, combat);
          break;
        }
        if (distSq(tr.pos.x, tr.pos.z, ai.home.x, ai.home.z) > ai.leashRadius * ai.leashRadius) {
          ai.target = 0;
          resetFromChase(ctx, e, combat);
          break;
        }
        checkBossPhase(ctx, e, combat);
        const targetTr = world.require(ai.target, Transform);
        // Mid-cast: rooted, facing the target. combatSystem lands the effect.
        if (combat.casting) {
          vel.x = 0;
          vel.z = 0;
          tr.rotY = Math.atan2(targetTr.pos.x - tr.pos.x, targetTr.pos.z - tr.pos.z);
          world.markDirty(e, Transform);
          break;
        }
        // Hurt and holding a ready heal? Use it — works at any distance.
        const health = world.require(e, Health);
        if (health.hp <= health.maxHp * HEAL_BELOW) {
          const heal = pickHeal(combat, ctx.time);
          if (heal) ctx.pendingAttacks.push({ attacker: e, target: e, ability: heal });
        }
        const summon = pickSummon(ctx, e, combat);
        if (summon) ctx.pendingAttacks.push({ attacker: e, target: e, ability: summon });
        const d = Math.sqrt(distSq(tr.pos.x, tr.pos.z, targetTr.pos.x, targetTr.pos.z));
        // combat.range is the kit's shortest offensive range, so stopping
        // here means everything the NPC owns can connect.
        if (d > combat.range * 0.85) {
          steerToward(tr, vel, targetTr.pos, NPC_MOVE_SPEED);
        } else {
          vel.x = 0;
          vel.z = 0;
          tr.rotY = Math.atan2(targetTr.pos.x - tr.pos.x, targetTr.pos.z - tr.pos.z);
          world.markDirty(e, Transform);
          // combatSystem enforces the cooldown; pushing every tick is fine.
          const ability = pickAttack(combat, d, ctx.time);
          if (ability) ctx.pendingAttacks.push({ attacker: e, target: ai.target, ability });
        }
        break;
      }
      case "return": {
        if (distSq(tr.pos.x, tr.pos.z, ai.home.x, ai.home.z) <= ARRIVE_DIST * ARRIVE_DIST) {
          vel.x = 0;
          vel.z = 0;
          ai.state = "wander";
          ai.moveTarget = null;
          ai.nextWanderAt = ctx.time + 2000;
        } else {
          steerToward(tr, vel, ai.home, NPC_MOVE_SPEED);
        }
        break;
      }
      case "wander": {
        if (!ai.moveTarget && ctx.time >= ai.nextWanderAt) {
          const angle = Math.random() * Math.PI * 2;
          const r = Math.random() * WANDER_RADIUS;
          ai.moveTarget = {
            x: ai.home.x + Math.cos(angle) * r,
            y: 0,
            z: ai.home.z + Math.sin(angle) * r,
          };
        }
        if (ai.moveTarget) {
          if (distSq(tr.pos.x, tr.pos.z, ai.moveTarget.x, ai.moveTarget.z) <= ARRIVE_DIST * ARRIVE_DIST) {
            vel.x = 0;
            vel.z = 0;
            ai.moveTarget = null;
            ai.nextWanderAt = ctx.time + 2000 + Math.random() * 4000;
          } else {
            steerToward(tr, vel, ai.moveTarget, NPC_MOVE_SPEED * 0.5);
          }
        }
        break;
      }
    }
  }
}
