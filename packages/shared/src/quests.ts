/**
 * Quest definitions and progression model, shared so the client renders the
 * quest log/dialogs from the same definitions the server validates against.
 */
import type { Vec3 } from "./math";

export type QuestObjective =
  | { type: "kill"; npcKind: string; count: number; label: string }
  | { type: "talk"; npcKind: string; label: string }
  | { type: "reach"; pos: Vec3; radius: number; label: string };

export interface QuestDef {
  id: string;
  name: string;
  /** Dialog body text shown when the quest is offered. */
  description: string;
  /** NpcTag.kind that offers this quest. */
  giverKind: string;
  /** NpcTag.kind that accepts the turn-in. */
  turnInKind: string;
  objectives: QuestObjective[];
  xpReward: number;
  /** Quest id that must be completed before this one is offered. */
  prereq?: string;
}

/** One active quest's per-objective counters (index-aligned with def.objectives). */
export interface QuestProgress {
  questId: string;
  progress: number[];
}

export interface PlayerQuestState {
  active: QuestProgress[];
  completed: string[];
}

/**
 * Default quest content. The authoritative quest list lives in the world data
 * (WorldDef.quests, editable in the editor); these seed worlds that don't
 * define any quests yet.
 */
export const STARTER_QUESTS: QuestDef[] = [
  {
    id: "goblin_cull",
    name: "Goblin Cull",
    description:
      "The goblins east of the village grow bolder every day. Thin their numbers before they raid us.",
    giverKind: "villager",
    turnInKind: "villager",
    objectives: [{ type: "kill", npcKind: "goblin", count: 5, label: "Slay goblins" }],
    xpReward: 120,
  },
  {
    id: "word_to_the_watch",
    name: "Word to the Watch",
    description:
      "Carry word of the goblin raids to the guard posted on the east road. She should hear it from one of us.",
    giverKind: "villager",
    turnInKind: "guard",
    objectives: [{ type: "talk", npcKind: "guard", label: "Find the guard on the east road" }],
    xpReward: 40,
  },
  {
    id: "scout_the_camp",
    name: "Scout the Camp",
    description:
      "Before the watch can act, we need eyes on the goblin camp. Get close enough to count their tents and come back alive.",
    giverKind: "guard",
    turnInKind: "guard",
    objectives: [
      { type: "reach", pos: { x: 25, y: 0, z: -20 }, radius: 8, label: "Scout the goblin camp" },
    ],
    xpReward: 80,
    prereq: "word_to_the_watch",
  },
];

/** Index a quest list by id for O(1) lookups. */
export function questIndex(quests: QuestDef[]): Record<string, QuestDef> {
  const byId: Record<string, QuestDef> = {};
  for (const q of quests) byId[q.id] = q;
  return byId;
}

/** Counter value at which an objective is complete. */
export function objectiveTarget(obj: QuestObjective): number {
  return obj.type === "kill" ? obj.count : 1;
}

export function isObjectiveDone(obj: QuestObjective, progress: number): boolean {
  return progress >= objectiveTarget(obj);
}

export function isQuestComplete(def: QuestDef, qp: QuestProgress): boolean {
  return def.objectives.every((obj, i) => isObjectiveDone(obj, qp.progress[i] ?? 0));
}

export function emptyQuestState(): PlayerQuestState {
  return { active: [], completed: [] };
}

/**
 * Repair quest state loaded from a save: drop quests that no longer exist in
 * the given registry, pad/trim progress arrays to the current objective list,
 * clamp counters. Keeps stale saves loadable across quest-content changes.
 */
export function sanitizeQuestState(
  raw: unknown,
  questsById: Record<string, QuestDef>,
): PlayerQuestState {
  const state = emptyQuestState();
  if (typeof raw !== "object" || raw === null) return state;
  const { active, completed } = raw as { active?: unknown; completed?: unknown };

  if (Array.isArray(completed)) {
    for (const id of completed) {
      if (typeof id === "string" && questsById[id] && !state.completed.includes(id)) {
        state.completed.push(id);
      }
    }
  }
  if (Array.isArray(active)) {
    for (const entry of active) {
      if (typeof entry !== "object" || entry === null) continue;
      const { questId, progress } = entry as { questId?: unknown; progress?: unknown };
      if (typeof questId !== "string") continue;
      const def = questsById[questId];
      if (!def) continue;
      if (state.completed.includes(questId)) continue;
      if (state.active.some((qp) => qp.questId === questId)) continue;
      const counters = def.objectives.map((obj, i) => {
        const v = Array.isArray(progress) ? progress[i] : 0;
        const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
        return Math.max(0, Math.min(n, objectiveTarget(obj)));
      });
      state.active.push({ questId, progress: counters });
    }
  }
  return state;
}

const cleanStr = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const cleanNum = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;

function sanitizeObjective(raw: unknown): QuestObjective | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const label = cleanStr(o.label, 80) || "Objective";
  switch (o.type) {
    case "kill": {
      const npcKind = cleanStr(o.npcKind, 32);
      if (!npcKind) return null;
      return { type: "kill", npcKind, count: Math.round(cleanNum(o.count, 1, 999, 1)), label };
    }
    case "talk": {
      const npcKind = cleanStr(o.npcKind, 32);
      if (!npcKind) return null;
      return { type: "talk", npcKind, label };
    }
    case "reach": {
      const p = (o.pos ?? {}) as Record<string, unknown>;
      return {
        type: "reach",
        pos: {
          x: cleanNum(p.x, -10000, 10000, 0),
          y: 0,
          z: cleanNum(p.z, -10000, 10000, 0),
        },
        radius: cleanNum(o.radius, 0.5, 500, 5),
        label,
      };
    }
    default:
      return null;
  }
}

/**
 * Validate untrusted quest definitions (editor input, hand-edited world.json):
 * drops malformed quests/objectives, dedupes ids, clamps numbers, and clears
 * prereqs that don't reference another surviving quest.
 */
export function sanitizeQuestDefs(raw: unknown): QuestDef[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const q = entry as Record<string, unknown>;
    const id = cleanStr(q.id, 48).replace(/[^a-zA-Z0-9_-]/g, "_");
    const giverKind = cleanStr(q.giverKind, 32);
    const turnInKind = cleanStr(q.turnInKind, 32);
    if (!id || seen.has(id) || !giverKind || !turnInKind) continue;
    const objectives = Array.isArray(q.objectives)
      ? q.objectives.map(sanitizeObjective).filter((o): o is QuestObjective => o !== null)
      : [];
    if (objectives.length === 0) continue;
    seen.add(id);
    const def: QuestDef = {
      id,
      name: cleanStr(q.name, 60) || id,
      description: cleanStr(q.description, 400),
      giverKind,
      turnInKind,
      objectives,
      xpReward: Math.round(cleanNum(q.xpReward, 0, 100000, 0)),
    };
    const prereq = cleanStr(q.prereq, 48);
    if (prereq) def.prereq = prereq;
    out.push(def);
  }
  // Prereqs must reference another surviving quest (and not themselves).
  for (const def of out) {
    if (def.prereq && (!seen.has(def.prereq) || def.prereq === def.id)) delete def.prereq;
  }
  return out;
}

// ---------------------------------------------------------------------------
// XP / levels

export const MAX_LEVEL = 20;

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return 100 * level;
}

/** Lifetime XP at which `level` begins (level 1 starts at 0). */
export function xpForLevel(level: number): number {
  // sum of xpToNext(1..level-1) = 100 * (level-1) * level / 2
  return (100 * (level - 1) * level) / 2;
}

/** Derive level and progress-within-level from lifetime XP. */
export function levelForXp(xp: number): { level: number; into: number; toNext: number } {
  const clamped = Math.max(0, xp);
  let level = 1;
  while (level < MAX_LEVEL && clamped >= xpForLevel(level + 1)) level++;
  if (level >= MAX_LEVEL) {
    const toNext = xpToNext(MAX_LEVEL - 1);
    return { level: MAX_LEVEL, into: toNext, toNext };
  }
  return { level, into: clamped - xpForLevel(level), toNext: xpToNext(level) };
}
