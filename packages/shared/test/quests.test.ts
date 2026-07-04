import { describe, expect, it } from "vitest";
import {
  MAX_LEVEL,
  STARTER_QUESTS,
  isObjectiveDone,
  isQuestComplete,
  levelForXp,
  objectiveTarget,
  questIndex,
  sanitizeQuestDefs,
  sanitizeQuestState,
  xpForLevel,
  type QuestObjective,
} from "../src/quests";

const QUESTS = questIndex(STARTER_QUESTS);

const kill: QuestObjective = { type: "kill", npcKind: "goblin", count: 5, label: "k" };
const talk: QuestObjective = { type: "talk", npcKind: "guard", label: "t" };
const reach: QuestObjective = { type: "reach", pos: { x: 0, y: 0, z: 0 }, radius: 5, label: "r" };

describe("objectives", () => {
  it("targets: kill uses count, talk/reach use 1", () => {
    expect(objectiveTarget(kill)).toBe(5);
    expect(objectiveTarget(talk)).toBe(1);
    expect(objectiveTarget(reach)).toBe(1);
  });

  it("isObjectiveDone at and past the target", () => {
    expect(isObjectiveDone(kill, 4)).toBe(false);
    expect(isObjectiveDone(kill, 5)).toBe(true);
    expect(isObjectiveDone(talk, 1)).toBe(true);
  });

  it("isQuestComplete requires every objective", () => {
    const def = { ...QUESTS.goblin_cull, objectives: [kill, talk] };
    expect(isQuestComplete(def, { questId: def.id, progress: [5, 0] })).toBe(false);
    expect(isQuestComplete(def, { questId: def.id, progress: [5, 1] })).toBe(true);
    // missing counters count as 0
    expect(isQuestComplete(def, { questId: def.id, progress: [5] })).toBe(false);
  });
});

describe("levelForXp", () => {
  it("starts at level 1 with 0 xp", () => {
    expect(levelForXp(0)).toEqual({ level: 1, into: 0, toNext: 100 });
  });

  it("levels up at exactly 100 xp", () => {
    expect(levelForXp(99).level).toBe(1);
    expect(levelForXp(100)).toEqual({ level: 2, into: 0, toNext: 200 });
  });

  it("is monotonic", () => {
    let prev = 1;
    for (let xp = 0; xp <= xpForLevel(MAX_LEVEL) + 500; xp += 50) {
      const { level } = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(prev);
      prev = level;
    }
  });

  it("caps at MAX_LEVEL with a full bar", () => {
    const top = levelForXp(xpForLevel(MAX_LEVEL) + 1_000_000);
    expect(top.level).toBe(MAX_LEVEL);
    expect(top.into).toBe(top.toNext);
  });

  it("clamps negative xp", () => {
    expect(levelForXp(-50).level).toBe(1);
  });
});

describe("sanitizeQuestState", () => {
  it("returns empty state for garbage input", () => {
    for (const garbage of [null, undefined, 42, "x", [], { active: "no" }]) {
      expect(sanitizeQuestState(garbage, QUESTS)).toEqual({ active: [], completed: [] });
    }
  });

  it("drops unknown quest ids", () => {
    const out = sanitizeQuestState(
      {
        active: [{ questId: "deleted_quest", progress: [3] }],
        completed: ["also_gone", "goblin_cull"],
      },
      QUESTS,
    );
    expect(out.active).toEqual([]);
    expect(out.completed).toEqual(["goblin_cull"]);
  });

  it("repairs progress arrays: pads, trims, clamps, floors", () => {
    const out = sanitizeQuestState(
      {
        active: [{ questId: "goblin_cull", progress: [99.7, 1, 2] }],
        completed: [],
      },
      QUESTS,
    );
    // goblin_cull has one objective: kill 5
    expect(out.active).toEqual([{ questId: "goblin_cull", progress: [5] }]);

    const padded = sanitizeQuestState(
      { active: [{ questId: "goblin_cull" }], completed: [] },
      QUESTS,
    );
    expect(padded.active).toEqual([{ questId: "goblin_cull", progress: [0] }]);
  });

  it("dedupes and drops active quests already completed", () => {
    const out = sanitizeQuestState(
      {
        active: [
          { questId: "goblin_cull", progress: [2] },
          { questId: "goblin_cull", progress: [3] },
          { questId: "word_to_the_watch", progress: [0] },
        ],
        completed: ["word_to_the_watch", "word_to_the_watch"],
      },
      QUESTS,
    );
    expect(out.active).toEqual([{ questId: "goblin_cull", progress: [2] }]);
    expect(out.completed).toEqual(["word_to_the_watch"]);
  });
});

describe("sanitizeQuestDefs", () => {
  it("returns [] for non-arrays and drops malformed quests", () => {
    expect(sanitizeQuestDefs(null)).toEqual([]);
    expect(sanitizeQuestDefs("x")).toEqual([]);
    expect(
      sanitizeQuestDefs([
        null,
        42,
        { id: "no_kinds", objectives: [{ type: "talk", npcKind: "a" }] },
        { id: "no_objectives", giverKind: "a", turnInKind: "a", objectives: [] },
        { id: "bad_objective", giverKind: "a", turnInKind: "a", objectives: [{ type: "wat" }] },
      ]),
    ).toEqual([]);
  });

  it("passes valid defs through and round-trips the starter quests", () => {
    expect(sanitizeQuestDefs(STARTER_QUESTS)).toEqual(STARTER_QUESTS);
  });

  it("dedupes ids, clamps numbers, clears dangling/self prereqs", () => {
    const out = sanitizeQuestDefs([
      {
        id: "q1",
        name: "Q1",
        giverKind: "villager",
        turnInKind: "villager",
        objectives: [{ type: "kill", npcKind: "goblin", count: -5, label: "k" }],
        xpReward: -10,
        prereq: "does_not_exist",
      },
      {
        id: "q1", // duplicate — dropped
        giverKind: "x",
        turnInKind: "x",
        objectives: [{ type: "talk", npcKind: "x" }],
      },
      {
        id: "q2",
        giverKind: "guard",
        turnInKind: "guard",
        objectives: [{ type: "reach", pos: { x: 1, z: 2 }, radius: 99999 }],
        xpReward: 50,
        prereq: "q2", // self — cleared
      },
    ]);
    expect(out.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(out[0].objectives[0]).toMatchObject({ count: 1 });
    expect(out[0].xpReward).toBe(0);
    expect(out[0].prereq).toBeUndefined();
    expect(out[1].objectives[0]).toMatchObject({ pos: { x: 1, y: 0, z: 2 }, radius: 500 });
    expect(out[1].prereq).toBeUndefined();
    // q2's name falls back to its id
    expect(out[1].name).toBe("q2");
  });

  it("keeps prereqs that reference surviving quests", () => {
    const out = sanitizeQuestDefs([
      { id: "a", giverKind: "v", turnInKind: "v", objectives: [{ type: "talk", npcKind: "v" }] },
      {
        id: "b",
        giverKind: "v",
        turnInKind: "v",
        objectives: [{ type: "talk", npcKind: "v" }],
        prereq: "a",
      },
    ]);
    expect(out[1].prereq).toBe("a");
  });
});

describe("quest content sanity", () => {
  it("ids match keys, prereqs exist, kinds and rewards set", () => {
    for (const [key, def] of Object.entries(QUESTS)) {
      expect(def.id).toBe(key);
      expect(def.giverKind).toBeTruthy();
      expect(def.turnInKind).toBeTruthy();
      expect(def.objectives.length).toBeGreaterThan(0);
      expect(def.xpReward).toBeGreaterThan(0);
      if (def.prereq) expect(QUESTS[def.prereq]).toBeDefined();
    }
  });
});
