import {
  ABILITIES,
  Combat,
  Health,
  NpcAi,
  RANGE_SLACK,
  Transform,
  distSq,
  type AbilityDef,
  type CombatData,
  type Entity,
} from "@mmo/shared";
import { sessionByEntity, type GameCtx, type PendingAttack } from "../../state";
import { spawnMinion } from "../spawn";

/** Validate queued ability uses, advance casts in progress, apply effects. */
export function combatSystem(ctx: GameCtx): void {
  for (const atk of ctx.pendingAttacks) applyAttack(ctx, atk);
  ctx.pendingAttacks.length = 0;
  tickCasts(ctx);
}

/**
 * The single attack path — players and NPCs go through identical validation:
 * kit membership, per-ability cooldown, target liveness, range. Only players
 * get abilityFail feedback (sessionByEntity finds nothing for an NPC, so
 * fail() is a no-op for them). Cast-time abilities pass validation, then
 * park in combat.casting; tickCasts resolves them when the cast completes.
 */
function applyAttack(ctx: GameCtx, atk: PendingAttack): void {
  const { world } = ctx;
  if (!world.isAlive(atk.attacker)) return;
  const combat = world.get(atk.attacker, Combat);
  if (!combat) return;
  const fail = (reason: string) =>
    sessionByEntity(ctx, atk.attacker)?.send({ t: "abilityFail", ability: atk.ability, reason });

  if (combat.casting) {
    fail("Already casting.");
    return;
  }
  const def = ABILITIES[atk.ability];
  // Kit membership is the authorization: a player can't send an NPC's
  // ability id any more than a goblin can Fireball.
  if (!def || !combat.abilities.includes(def.id)) {
    fail("Unknown ability.");
    return;
  }
  const last = combat.cooldowns[def.id] ?? -1e9;
  if (ctx.time - last < def.cooldownMs) {
    fail("Not ready yet.");
    return;
  }

  const target: Entity = def.targetSelf ? atk.attacker : atk.target;
  if (!world.isAlive(target)) {
    fail("Invalid target.");
    return;
  }
  const targetHealth = world.get(target, Health);
  if (!targetHealth || (!def.targetSelf && targetHealth.hp <= 0)) {
    fail("Target is dead.");
    return;
  }
  if (!def.targetSelf) {
    if (target === atk.attacker) {
      fail("Can't attack yourself.");
      return;
    }
    if (!inRange(ctx, atk.attacker, target, def)) {
      fail("Out of range.");
      return;
    }
  }

  // The cooldown is charged when the cast *starts* — an interrupted cast is
  // lost for the full cooldown, which is what makes interrupting worth it.
  combat.cooldowns[def.id] = ctx.time;

  if (def.castMs) {
    combat.casting = { ability: def.id, target, endsAt: ctx.time + def.castMs };
    ctx.castEvents.push({
      caster: atk.attacker,
      ability: def.id,
      durationMs: def.castMs,
      phase: "start",
    });
    return;
  }
  resolveHit(ctx, atk.attacker, target, def);
}

/** Complete (or fizzle) casts whose time has elapsed. */
function tickCasts(ctx: GameCtx): void {
  const { world } = ctx;
  for (const e of world.query(Combat)) {
    const combat = world.require(e, Combat);
    const cast = combat.casting;
    if (!cast || ctx.time < cast.endsAt) continue;
    combat.casting = null;
    const def = ABILITIES[cast.ability];
    if (!def) continue;

    // The world moved during the cast: the target may have died or walked
    // out of range — that's the dodge. The cast fizzles (cooldown stays spent).
    const targetHealth = world.isAlive(cast.target) ? world.get(cast.target, Health) : undefined;
    const fizzled =
      !targetHealth ||
      (!def.targetSelf && targetHealth.hp <= 0) ||
      (!def.targetSelf && !inRange(ctx, e, cast.target, def));
    if (fizzled) {
      ctx.castEvents.push({ caster: e, ability: def.id, durationMs: 0, phase: "interrupted" });
      continue;
    }
    ctx.castEvents.push({ caster: e, ability: def.id, durationMs: 0, phase: "done" });
    if (def.summon) {
      const ai = world.get(e, NpcAi);
      const target = ai?.target && world.isAlive(ai.target) ? ai.target : cast.target;
      for (let i = 0; i < def.summon.count; i++) spawnMinion(ctx, e, def.summon.kind, target);
      // Self-targeted burst so clients get a visual at the summoner's feet.
      ctx.combatEvents.push({ attacker: e, target: e, damage: 0, died: false, ability: def.id });
      continue;
    }
    resolveHit(ctx, e, cast.target, def);
  }
}

/** Apply a validated ability's effect (heal or damage + interrupt/retaliate). */
function resolveHit(ctx: GameCtx, attacker: Entity, target: Entity, def: AbilityDef): void {
  const { world } = ctx;
  const targetHealth = world.require(target, Health);

  if (def.heal) {
    const healed = Math.min(def.heal, targetHealth.maxHp - targetHealth.hp);
    targetHealth.hp += healed;
    world.markDirty(target, Health);
    ctx.combatEvents.push({
      attacker,
      target,
      damage: -healed,
      died: false,
      ability: def.id,
    });
    return;
  }

  targetHealth.hp = Math.max(0, targetHealth.hp - def.damage);
  world.markDirty(target, Health);
  ctx.lastAttackerByVictim.set(target, attacker);
  const targetCombat = world.get(target, Combat);
  if (def.interrupts && targetCombat?.casting) {
    ctx.castEvents.push({
      caster: target,
      ability: targetCombat.casting.ability,
      durationMs: 0,
      phase: "interrupted",
      by: attacker,
    });
    targetCombat.casting = null;
  }
  retaliate(ctx, target, attacker);
  ctx.combatEvents.push({
    attacker,
    target,
    damage: def.damage,
    died: targetHealth.hp <= 0,
    ability: def.id,
  });
}

/** Shared range test (XZ), with the same slack the client's reach check gets. */
function inRange(ctx: GameCtx, attacker: Entity, target: Entity, def: AbilityDef): boolean {
  const attackerTr = ctx.world.get(attacker, Transform);
  const targetTr = ctx.world.get(target, Transform);
  if (!attackerTr || !targetTr) return false;
  const maxRange = def.range + RANGE_SLACK;
  return (
    distSq(attackerTr.pos.x, attackerTr.pos.z, targetTr.pos.x, targetTr.pos.z) <=
    maxRange * maxRange
  );
}

/** NPCs turn on whoever hit them. Friendly NPCs (no Combat) never fight back. */
function retaliate(ctx: GameCtx, target: Entity, attacker: Entity): void {
  if (!ctx.world.get(target, Combat)) return;
  const ai = ctx.world.get(target, NpcAi);
  if (ai && ai.state !== "chase") {
    ai.target = attacker;
    ai.state = "chase";
  }
}

/** Cancel a cast in progress (leash reset, death); cooldown stays spent. */
export function cancelCast(ctx: GameCtx, e: Entity, combat: CombatData): void {
  if (!combat.casting) return;
  ctx.castEvents.push({
    caster: e,
    ability: combat.casting.ability,
    durationMs: 0,
    phase: "interrupted",
  });
  combat.casting = null;
}
