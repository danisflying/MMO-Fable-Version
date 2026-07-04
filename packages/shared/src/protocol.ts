import type { Vec3 } from "./math";
import type { NpcDef } from "./npcs";
import type { QuestDef, QuestProgress } from "./quests";
import type { TerrainDefJSON, TerrainPatch } from "./terrain";
import type { WorldBounds, WorldDef } from "./worlddef";

/** Full or partial component data for one entity, keyed by component name. */
export interface EntitySnapshot {
  id: number;
  c: Record<string, unknown>;
}

export type ChatChannel = "global" | "local";

// ---------------------------------------------------------------------------
// client -> server

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "input"; seq: number; moveX: number; moveZ: number; rotY: number; jump?: boolean }
  | { t: "attack"; target: number; ability?: string }
  | { t: "chat"; channel: ChatChannel; text: string }
  | { t: "interact"; npc: number }
  | { t: "questAccept"; questId: string; npc: number }
  | { t: "questTurnIn"; questId: string; npc: number }
  | { t: "questAbandon"; questId: string }
  | EditorMessage;

export type EditorMessage =
  | { t: "editor:auth"; token: string }
  | { t: "editor:placeProp"; model: string; pos: Vec3; rotY: number; scale: number }
  | { t: "editor:updateProp"; propId: string; pos: Vec3; rotY: number; scale: number; model?: string }
  | { t: "editor:deleteProp"; propId: string }
  | {
      t: "editor:placeSpawner";
      kind: string;
      model: string;
      pos: Vec3;
      count: number;
      respawnMs: number;
      aggroRadius: number;
    }
  | {
      t: "editor:updateSpawner";
      spawnerId: string;
      pos: Vec3;
      kind?: string;
      model?: string;
      count?: number;
      respawnMs?: number;
      aggroRadius?: number;
    }
  | { t: "editor:deleteSpawner"; spawnerId: string }
  | { t: "editor:setSpawnPoint"; pos: Vec3 }
  | { t: "editor:setQuests"; quests: QuestDef[] }
  /** Replace the NPC definitions; live NPCs respawn with the new stats. */
  | { t: "editor:setNpcs"; npcs: NpcDef[] }
  /** Absolute region edit from a sculpt/paint brush stroke. */
  | { t: "editor:terrain"; patch: TerrainPatch }
  | { t: "editor:save" };

// ---------------------------------------------------------------------------
// server -> client

export interface CombatEventData {
  attacker: number;
  target: number;
  /** Negative for heals. */
  damage: number;
  died: boolean;
  /** Ability id for player attacks; absent for NPC basic attacks. */
  ability?: string;
}

/** Cast lifecycle, driving cast bars/animations. Clients time the bar locally. */
export interface CastEventData {
  caster: number;
  ability: string;
  /** Full cast length (only meaningful on "start"). */
  durationMs: number;
  /** start → (done | interrupted). A fizzle (target left range/died) is "interrupted". */
  phase: "start" | "done" | "interrupted";
  /** Who broke the cast, when a player's interrupt ability did. */
  by?: number;
}

export type ServerMessage =
  | {
      t: "welcome";
      entityId: number;
      bounds: WorldBounds;
      spawnPoint: Vec3;
      /** Footprint collider radius per model name (scale 1); props collide. */
      colliderRadii: Record<string, number>;
      /** Full heightmap + paint state; prediction samples the same data as the server. */
      terrain: TerrainDefJSON;
    }
  | { t: "spawn"; entities: EntitySnapshot[] }
  | { t: "despawn"; ids: number[] }
  | { t: "delta"; entities: EntitySnapshot[] }
  | { t: "inputAck"; seq: number; x: number; z: number; y: number; vy: number }
  | { t: "chatMsg"; channel: ChatChannel; from: string; text: string }
  | { t: "combatEvent"; events: CombatEventData[] }
  | { t: "castEvent"; events: CastEventData[] }
  | { t: "abilityFail"; ability: string; reason: string }
  | { t: "questDefs"; quests: QuestDef[] }
  | { t: "questState"; active: QuestProgress[]; completed: string[]; xp: number; level: number }
  | { t: "questDialog"; npc: number; npcKind: string; offers: string[]; turnIns: string[] }
  /** Live terrain edit, broadcast to everyone but the editor that made it. */
  | { t: "terrainPatch"; patch: TerrainPatch }
  | { t: "death" }
  | { t: "error"; message: string }
  | { t: "editor:authOk" }
  | { t: "editor:worldState"; def: WorldDef }
  | { t: "editor:saved" };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.t !== "string") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
