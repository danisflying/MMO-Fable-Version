import { randomUUID } from "node:crypto";
import {
  ABILITY_BAR,
  Combat,
  FALLBACK_NPC_ABILITIES,
  FALLBACK_NPC_HP,
  Health,
  ModelRef,
  NpcAi,
  NpcTag,
  PLAYER_MAX_HP,
  PlayerTag,
  PropTag,
  Transform,
  Velocity,
  heightAt,
  kitRange,
  type Entity,
  type PropDef,
  type SpawnerDef,
  type Vec3,
} from "@mmo/shared";
import type { GameCtx } from "../state";

export function spawnPlayer(ctx: GameCtx, name: string, pos: Vec3, hp: number): Entity {
  const { world } = ctx;
  const e = world.create();
  // Saved y may predate a terrain edit; always start on the ground.
  const spawnPos = { ...pos, y: heightAt(ctx.terrain, pos.x, pos.z) };
  world.add(e, Transform, { pos: spawnPos, rotY: 0 });
  world.add(e, Velocity, { x: 0, y: 0, z: 0 });
  world.add(e, Health, { hp, maxHp: PLAYER_MAX_HP });
  world.add(e, Combat, {
    abilities: [...ABILITY_BAR],
    range: kitRange(ABILITY_BAR),
    cooldowns: {},
    casting: null,
  });
  world.add(e, ModelRef, { model: "Character_3", scale: 1 });
  world.add(e, PlayerTag, { name });
  return e;
}

export function spawnNpc(ctx: GameCtx, spawner: SpawnerDef): Entity {
  const { world } = ctx;
  // The NPC def (editable in the editor's NPC Library) is the authority for
  // stats and model; spawner.model is only the fallback for orphaned kinds.
  const def = ctx.npcsByKind[spawner.kind];
  const hp = def?.hp ?? FALLBACK_NPC_HP;
  const friendly = def?.friendly ?? false;
  const abilities = def ? def.abilities : FALLBACK_NPC_ABILITIES;
  const angle = Math.random() * Math.PI * 2;
  const r = Math.random() * 3;
  const x = spawner.pos.x + Math.cos(angle) * r;
  const z = spawner.pos.z + Math.sin(angle) * r;
  const pos: Vec3 = { x, y: heightAt(ctx.terrain, x, z), z };
  const e = world.create();
  world.add(e, Transform, { pos, rotY: Math.random() * Math.PI * 2 });
  world.add(e, Velocity, { x: 0, y: 0, z: 0 });
  world.add(e, Health, { hp, maxHp: hp });
  if (!friendly && abilities.length) {
    world.add(e, Combat, {
      abilities: [...abilities],
      range: kitRange(abilities),
      cooldowns: {},
      casting: null,
    });
  }
  world.add(e, ModelRef, { model: def?.model || spawner.model, scale: def?.scale ?? 1 });
  world.add(e, NpcTag, def?.boss ? { kind: spawner.kind, boss: true } : { kind: spawner.kind });
  world.add(e, NpcAi, {
    state: "wander",
    home: { ...spawner.pos },
    aggroRadius: spawner.aggroRadius,
    leashRadius: Math.max(spawner.aggroRadius * 2.5, 15),
    target: 0,
    moveTarget: null,
    nextWanderAt: 0,
    spawnerId: spawner.id,
  });

  let set = ctx.npcsBySpawner.get(spawner.id);
  if (!set) {
    set = new Set();
    ctx.npcsBySpawner.set(spawner.id, set);
  }
  set.add(e);
  return e;
}

/**
 * Summoned minion: no spawner, so it never respawns; deathSystem removes the
 * whole pack when its owner dies (or the owner's AI resets). Spawns already
 * aggroed on the owner's target.
 */
export function spawnMinion(ctx: GameCtx, owner: Entity, kind: string, target: Entity): Entity {
  const { world } = ctx;
  const ownerTr = world.require(owner, Transform);
  const def = ctx.npcsByKind[kind];
  const hp = def?.hp ?? FALLBACK_NPC_HP;
  const abilities = def && !def.friendly ? def.abilities : FALLBACK_NPC_ABILITIES;
  const angle = Math.random() * Math.PI * 2;
  const r = 1.5 + Math.random() * 1.5;
  const x = ownerTr.pos.x + Math.cos(angle) * r;
  const z = ownerTr.pos.z + Math.sin(angle) * r;
  const pos: Vec3 = { x, y: heightAt(ctx.terrain, x, z), z };
  const e = world.create();
  world.add(e, Transform, { pos, rotY: ownerTr.rotY });
  world.add(e, Velocity, { x: 0, y: 0, z: 0 });
  world.add(e, Health, { hp, maxHp: hp });
  world.add(e, Combat, {
    abilities: [...abilities],
    range: kitRange(abilities),
    cooldowns: {},
    casting: null,
  });
  world.add(e, ModelRef, { model: def?.model || "goblin", scale: def?.scale ?? 1 });
  world.add(e, NpcTag, { kind });
  world.add(e, NpcAi, {
    state: "chase",
    home: { ...ownerTr.pos },
    aggroRadius: 30,
    leashRadius: 60,
    target,
    moveTarget: null,
    nextWanderAt: 0,
    spawnerId: "",
  });
  let set = ctx.minionsByOwner.get(owner);
  if (!set) {
    set = new Set();
    ctx.minionsByOwner.set(owner, set);
  }
  set.add(e);
  return e;
}

export function spawnProp(ctx: GameCtx, def: PropDef): Entity {
  const { world } = ctx;
  const e = world.create();
  world.add(e, Transform, { pos: { ...def.pos }, rotY: def.rotY });
  world.add(e, ModelRef, { model: def.model, scale: def.scale });
  world.add(e, PropTag, { propId: def.id });
  ctx.propEntities.set(def.id, e);
  return e;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

