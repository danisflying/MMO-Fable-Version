import type { Vec3 } from "./math";
import type { NpcDef } from "./npcs";
import type { QuestDef } from "./quests";
import type { TerrainDefJSON } from "./terrain";

/** A static GLB prop placed in the world by the editor. */
export interface PropDef {
  id: string;
  model: string;
  pos: Vec3;
  rotY: number;
  scale: number;
}

/** Spawns `count` NPCs around `pos`; dead NPCs respawn after `respawnMs`. */
export interface SpawnerDef {
  id: string;
  kind: string;
  model: string;
  pos: Vec3;
  count: number;
  respawnMs: number;
  aggroRadius: number;
}

export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

/** Serialized world layout — the contents of assets/world/world.json. */
export interface WorldDef {
  spawnPoint: Vec3;
  bounds: WorldBounds;
  props: PropDef[];
  spawners: SpawnerDef[];
  /** Quest content, editable in the editor's Quest Builder. */
  quests: QuestDef[];
  /** NPC definitions, editable in the editor's NPC Library; spawners reference them by kind. */
  npcs: NpcDef[];
  /**
   * Serialized heightmap + paint splat. Absent in old worlds (flat default).
   * The server keeps the decoded live copy in GameCtx.terrain and only fills
   * this field when serializing (save, editor auth).
   */
  terrain?: TerrainDefJSON;
}
