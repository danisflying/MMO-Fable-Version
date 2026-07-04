import { defineComponent, type ComponentType } from "./ecs/component";
import type { Entity } from "./ecs/world";
import type { Vec3 } from "./math";

export interface TransformData {
  pos: Vec3;
  rotY: number;
}

export interface VelocityData {
  x: number;
  /** Vertical velocity (jumping/falling). */
  y: number;
  z: number;
}

export interface HealthData {
  hp: number;
  maxHp: number;
}

export interface CombatData {
  /** Ability ids this entity may use; the server validates kit membership. */
  abilities: string[];
  /** AI approach distance — the kit's shortest offensive range (see kitRange). */
  range: number;
  /** Per-ability last-use times (sim ms), keyed by ability id. */
  cooldowns: Record<string, number>;
  /** In-progress cast (abilities with castMs); resolved by combatSystem. */
  casting: { ability: string; target: Entity; endsAt: number } | null;
}

export type NpcAiState = "wander" | "chase" | "return";

export interface NpcAiData {
  state: NpcAiState;
  home: Vec3;
  aggroRadius: number;
  leashRadius: number;
  target: Entity | 0;
  moveTarget: Vec3 | null;
  nextWanderAt: number;
  /** "" for summoned minions — they never respawn and die with their owner. */
  spawnerId: string;
  /** Boss phase-2 latch (set once when hp crosses the threshold). */
  phase2?: boolean;
}

export interface ModelRefData {
  model: string;
  scale: number;
}

export interface PlayerTagData {
  name: string;
}

export interface NpcTagData {
  kind: string;
  /** Bosses get the big HUD health bar client-side. */
  boss?: boolean;
}

export interface PropTagData {
  propId: string;
}

export const Transform = defineComponent<TransformData>("transform");
export const Velocity = defineComponent<VelocityData>("velocity");
export const Health = defineComponent<HealthData>("health");
export const Combat = defineComponent<CombatData>("combat");
export const NpcAi = defineComponent<NpcAiData>("npcAi");
export const ModelRef = defineComponent<ModelRefData>("modelRef");
export const PlayerTag = defineComponent<PlayerTagData>("playerTag");
export const NpcTag = defineComponent<NpcTagData>("npcTag");
export const PropTag = defineComponent<PropTagData>("propTag");

/** Components replicated to clients in spawn/delta messages. */
export const NETWORKED: ComponentType<unknown>[] = [
  Transform,
  Health,
  ModelRef,
  PlayerTag,
  NpcTag,
  PropTag,
];
