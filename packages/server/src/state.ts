import type { WebSocket } from "ws";
import {
  ModelRef,
  Transform,
  World,
  type CastEventData,
  type CircleCollider,
  type CombatEventData,
  type Entity,
  type NpcDef,
  type PlayerQuestState,
  type QuestDef,
  type ServerMessage,
  type TerrainData,
  type WorldDef,
  createFlatTerrain,
  emptyQuestState,
  encode,
  npcIndex,
  questIndex,
  terrainFromJSON,
} from "@mmo/shared";
import { SpatialGrid } from "./streaming/spatialGrid";

export interface PlayerInput {
  seq: number;
  moveX: number;
  moveZ: number;
  rotY: number;
  jump: boolean;
}

export class Session {
  entityId: Entity | 0 = 0;
  name = "";
  isEditor = false;
  /** Entities this client currently knows about (streamed in). */
  known = new Set<Entity>();
  /**
   * Queued movement inputs, processed exactly one per tick so server
   * integration matches the client's fixed-step prediction (no rubber-banding).
   */
  inputQueue: PlayerInput[] = [];
  lastProcessedSeq = 0;
  /** Lifetime XP; level is always derived via levelForXp. */
  xp = 0;
  quests: PlayerQuestState = emptyQuestState();

  constructor(readonly socket: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(encode(msg));
    }
  }
}

export interface PendingAttack {
  attacker: Entity;
  target: Entity;
  /** Ability id; every attack (player or NPC) is an ability use. */
  ability: string;
}

export interface NpcRespawn {
  spawnerId: string;
  at: number;
}

export interface GameCtx {
  world: World;
  def: WorldDef;
  /**
   * Live decoded heightmap — the only copy the sim reads. def.terrain is
   * re-encoded from this on save and editor auth, and cleared otherwise so a
   * stale serialized blob can't leak into worldState broadcasts.
   */
  terrain: TerrainData;
  sessions: Set<Session>;
  grid: SpatialGrid;
  /** propId -> live entity, kept in sync with def.props by the editor handlers. */
  propEntities: Map<string, Entity>;
  /** Collider radius per model name, derived from GLB bounds at boot. */
  colliderRadii: Record<string, number>;
  /** Prop collision circles sorted by entity id; rebuilt when props change. */
  propColliders: CircleCollider[];
  npcsBySpawner: Map<string, Set<Entity>>;
  /** Live summoned minions per owner (boss); they die/despawn with the owner. */
  minionsByOwner: Map<Entity, Set<Entity>>;
  pendingAttacks: PendingAttack[];
  combatEvents: CombatEventData[];
  castEvents: CastEventData[];
  npcRespawns: NpcRespawn[];
  /** Most recent damaging entity per victim, for quest kill credit. */
  lastAttackerByVictim: Map<Entity, Entity>;
  /** def.quests indexed by id; rebuilt whenever the editor changes quests. */
  questsById: Record<string, QuestDef>;
  /** def.npcs indexed by kind; rebuilt whenever the editor changes NPC defs. */
  npcsByKind: Record<string, NpcDef>;
  /** Server sim time in ms, advanced by TICK_MS each tick. */
  time: number;
}

export function createCtx(def: WorldDef, colliderRadii: Record<string, number> = {}): GameCtx {
  const terrain = terrainFromJSON(def.terrain) ?? createFlatTerrain();
  delete def.terrain;
  return {
    world: new World(),
    def,
    terrain,
    sessions: new Set(),
    grid: new SpatialGrid(),
    propEntities: new Map(),
    colliderRadii,
    propColliders: [],
    npcsBySpawner: new Map(),
    minionsByOwner: new Map(),
    pendingAttacks: [],
    combatEvents: [],
    castEvents: [],
    npcRespawns: [],
    lastAttackerByVictim: new Map(),
    questsById: questIndex(def.quests),
    npcsByKind: npcIndex(def.npcs),
    time: 0,
  };
}

export function* playerSessions(ctx: GameCtx): Generator<Session> {
  for (const s of ctx.sessions) {
    if (!s.isEditor && s.entityId !== 0 && ctx.world.isAlive(s.entityId)) yield s;
  }
}

/** Rebuild the sorted prop collider list (boot + every editor prop change). */
export function rebuildPropColliders(ctx: GameCtx): void {
  const colliders: CircleCollider[] = [];
  for (const entity of ctx.propEntities.values()) {
    const tr = ctx.world.get(entity, Transform);
    const model = ctx.world.get(entity, ModelRef);
    if (!tr || !model) continue;
    const base = ctx.colliderRadii[model.model];
    if (base === undefined) continue;
    colliders.push({ id: entity, x: tr.pos.x, z: tr.pos.z, r: base * model.scale });
  }
  colliders.sort((a, b) => a.id - b.id);
  ctx.propColliders = colliders;
}

export function sessionByEntity(ctx: GameCtx, e: Entity): Session | undefined {
  for (const s of ctx.sessions) {
    if (s.entityId === e) return s;
  }
  return undefined;
}
