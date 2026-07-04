import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_NPCS,
  FALLBACK_NPC_ABILITIES,
  FALLBACK_NPC_HP,
  STARTER_QUESTS,
  npcIndex,
  sanitizeNpcDefs,
  sanitizeQuestDefs,
  type NpcDef,
  type WorldDef,
} from "@mmo/shared";
import { WORLD_FILE } from "../paths";
import type { GameCtx } from "../state";
import { spawnNpc, spawnProp } from "../game/spawn";

const DEFAULT_WORLD: WorldDef = {
  spawnPoint: { x: 0, y: 0, z: 0 },
  bounds: { min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 0, z: 100 } },
  props: [],
  spawners: [],
  quests: STARTER_QUESTS,
  npcs: DEFAULT_NPCS,
};

/**
 * Worlds saved before NPC defs existed get theirs derived from what's
 * already placed: known kinds keep their stats but adopt the model the
 * world's spawners actually use, and custom kinds (e.g. a hand-typed boss)
 * become real editable defs instead of silent fallbacks.
 */
function migrateNpcs(def: WorldDef): NpcDef[] {
  const npcs = structuredClone(DEFAULT_NPCS);
  const byKind = npcIndex(npcs);
  for (const spawner of def.spawners ?? []) {
    const existing = byKind[spawner.kind];
    if (existing) {
      existing.model = spawner.model || existing.model;
    } else {
      const derived: NpcDef = {
        kind: spawner.kind,
        model: spawner.model || "goblin",
        hp: FALLBACK_NPC_HP,
        friendly: false,
        abilities: [...FALLBACK_NPC_ABILITIES],
      };
      npcs.push(derived);
      byKind[derived.kind] = derived;
    }
  }
  return npcs;
}

export function loadWorldDef(): WorldDef {
  try {
    const raw = readFileSync(WORLD_FILE, "utf8");
    const def = JSON.parse(raw) as WorldDef;
    return {
      ...DEFAULT_WORLD,
      ...def,
      props: def.props ?? [],
      spawners: def.spawners ?? [],
      // Worlds without a quests key inherit the starter quests (migration path);
      // an explicit empty array means "no quests".
      quests: def.quests ? sanitizeQuestDefs(def.quests) : structuredClone(STARTER_QUESTS),
      npcs: def.npcs ? sanitizeNpcDefs(def.npcs) : migrateNpcs(def),
    };
  } catch {
    console.warn(`world file missing or invalid (${WORLD_FILE}), using empty default world`);
    return structuredClone(DEFAULT_WORLD);
  }
}

/** Instantiate props and NPCs from the world definition into the ECS world. */
export function instantiateWorld(ctx: GameCtx): void {
  for (const prop of ctx.def.props) spawnProp(ctx, prop);
  for (const spawner of ctx.def.spawners) {
    for (let i = 0; i < spawner.count; i++) spawnNpc(ctx, spawner);
  }
}

/** Atomic write: temp file then rename, so a crash can't truncate world.json. */
export function saveWorldDef(def: WorldDef): void {
  mkdirSync(dirname(WORLD_FILE), { recursive: true });
  const tmp = join(dirname(WORLD_FILE), `.world.json.tmp`);
  writeFileSync(tmp, JSON.stringify(def, null, 2), "utf8");
  renameSync(tmp, WORLD_FILE);
}
