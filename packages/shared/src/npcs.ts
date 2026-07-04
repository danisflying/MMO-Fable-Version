import { ABILITIES } from "./abilities";

/**
 * NPC definitions are world data, like quests: edited in the editor's NPC
 * Library, stored in world.json (WorldDef.npcs), applied live via
 * editor:setNpcs. A spawner references one by kind.
 */
export interface BossDef {
  /** Health fraction at which phase 2 starts (once, latched). */
  phase2AtFrac: number;
  /** Abilities added to the kit when phase 2 starts (ids into ABILITIES). */
  phase2Abilities: string[];
}

export interface NpcDef {
  /** Unique kind id — referenced by spawners, quests, and nameplates. */
  kind: string;
  model: string;
  hp: number;
  /** Friendly NPCs never fight: no aggro, no retaliation. */
  friendly: boolean;
  /** Ability kit (ids into ABILITIES); ignored while friendly. */
  abilities: string[];
  /** Model scale (1 = normal size). */
  scale?: number;
  /** Boss fight config: HUD health bar + a phase-2 kit unlock. */
  boss?: BossDef;
}

export const DEFAULT_NPCS: NpcDef[] = [
  { kind: "goblin", model: "goblin", hp: 40, friendly: false, abilities: ["gnash", "frenzy"] },
  { kind: "shaman", model: "goblin", hp: 45, friendly: false, abilities: ["spark", "mend"] },
  { kind: "villager", model: "Character_3", hp: 60, friendly: true, abilities: [] },
  { kind: "guard", model: "Character_3", hp: 120, friendly: true, abilities: [] },
  { kind: "gnoll", model: "goblin", hp: 25, friendly: false, abilities: ["gnash"], scale: 0.8 },
  {
    kind: "hogger", model: "goblin", hp: 300, friendly: false,
    abilities: ["maul", "slam"], scale: 1.6,
    boss: { phase2AtFrac: 0.5, phase2Abilities: ["summonPack", "frenzy"] },
  },
];

/** Kit for spawner kinds that have no definition (e.g. the def was deleted). */
export const FALLBACK_NPC_ABILITIES: string[] = ["gnash"];
export const FALLBACK_NPC_HP = 40;

export function npcIndex(defs: readonly NpcDef[]): Record<string, NpcDef> {
  const index: Record<string, NpcDef> = {};
  for (const def of defs) index[def.kind] = def;
  return index;
}

/**
 * Treat editor input and disk saves as untrusted: dedupe kinds, clamp hp,
 * drop unknown abilities, and keep hostile kits non-empty (an ability-less
 * hostile NPC would just be a statue).
 */
export function sanitizeNpcDefs(raw: unknown): NpcDef[] {
  if (!Array.isArray(raw)) return [];
  const out: NpcDef[] = [];
  const seen = new Set<string>();
  for (const item of raw as Partial<NpcDef>[]) {
    if (!item || typeof item !== "object") continue;
    const kind = String(item.kind ?? "").trim();
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    const friendly = item.friendly === true;
    let abilities = Array.isArray(item.abilities)
      ? item.abilities.filter((id): id is string => typeof id === "string" && id in ABILITIES)
      : [];
    if (friendly) abilities = [];
    else if (abilities.length === 0) abilities = [...FALLBACK_NPC_ABILITIES];
    const def: NpcDef = {
      kind,
      model: String(item.model ?? "").trim() || "goblin",
      hp: Math.max(1, Math.min(9999, Math.floor(Number(item.hp)) || FALLBACK_NPC_HP)),
      friendly,
      abilities,
    };
    const scale = Number(item.scale);
    if (Number.isFinite(scale) && scale !== 1) def.scale = Math.max(0.2, Math.min(5, scale));
    if (!friendly && item.boss && typeof item.boss === "object") {
      const frac = Number(item.boss.phase2AtFrac);
      def.boss = {
        phase2AtFrac: Number.isFinite(frac) ? Math.max(0.05, Math.min(0.95, frac)) : 0.5,
        phase2Abilities: Array.isArray(item.boss.phase2Abilities)
          ? item.boss.phase2Abilities.filter(
              (id): id is string => typeof id === "string" && id in ABILITIES,
            )
          : [],
      };
    }
    out.push(def);
  }
  return out;
}
