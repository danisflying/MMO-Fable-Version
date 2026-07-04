// Quest Builder / editor-refactor smoke test: an editor session rewrites the
// quest list via editor:setQuests while a player is online, and we verify the
// player receives fresh questDefs, has stale progress pruned, and that the
// extended editor:updateSpawner / editor:updateProp fields apply. Restores the
// original quest list at the end. Requires the server to be running.

import { rmSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Editor session ---------------------------------------------------------
const editor = new WebSocket("ws://localhost:8080");
let worldDef = null;
let authOk = false;
editor.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "editor:authOk") authOk = true;
  if (m.t === "editor:worldState") worldDef = m.def;
};
await new Promise((r) => (editor.onopen = r));
const esend = (m) => editor.send(JSON.stringify(m));
esend({ t: "editor:auth", token: "dev" });
await sleep(300);
check("editor authed + worldState has quests", authOk && Array.isArray(worldDef?.quests),
  `${worldDef?.quests?.length} quests`);
const originalQuests = structuredClone(worldDef.quests);

// --- Player session ---------------------------------------------------------
rmSync(new URL("../data/players/qbwatcher.json", import.meta.url), { force: true });
const player = new WebSocket("ws://localhost:8080");
const questDefsMsgs = [];
const questStates = [];
const entities = new Map();
player.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "questDefs") questDefsMsgs.push(m);
  if (m.t === "questState") questStates.push(m);
  if (m.t === "spawn") for (const e of m.entities) entities.set(e.id, e.c);
  if (m.t === "despawn") for (const id of m.ids) entities.delete(id);
  if (m.t === "delta")
    for (const e of m.entities) {
      const c = entities.get(e.id);
      if (c) Object.assign(c, e.c);
    }
};
await new Promise((r) => (player.onopen = r));
player.send(JSON.stringify({ t: "join", name: "QbWatcher" }));
await sleep(500);

check(
  "player got questDefs on join matching world data",
  questDefsMsgs.length === 1 && questDefsMsgs[0].quests.length === originalQuests.length,
  `defs=${questDefsMsgs[0]?.quests.map((q) => q.id).join(",")}`,
);

const statesBefore = questStates.length;

// --- Editor rewrites the quest list ----------------------------------------
const newQuest = {
  id: "builder_test",
  name: "Builder Test",
  description: "Made by the quest builder smoke test.",
  giverKind: "villager",
  turnInKind: "villager",
  objectives: [
    { type: "kill", npcKind: "goblin", count: 2, label: "Test kills" },
    { type: "reach", pos: { x: -10, y: 0, z: -10 }, radius: 4, label: "Test spot" },
  ],
  xpReward: 25,
};
// Include one malformed quest — the server must drop it.
esend({ t: "editor:setQuests", quests: [newQuest, { id: "broken", objectives: [] }] });
await sleep(400);

check(
  "editor worldState reflects sanitized quest list",
  worldDef.quests.length === 1 && worldDef.quests[0].id === "builder_test",
  worldDef.quests.map((q) => q.id).join(","),
);
check(
  "player got updated questDefs pushed live",
  questDefsMsgs.length === 2 && questDefsMsgs[1].quests.length === 1 &&
    questDefsMsgs[1].quests[0].id === "builder_test",
);
check("player questState resynced after quest edit", questStates.length > statesBefore);

// --- Extended spawner update (inspector path) --------------------------------
const spawner = worldDef.spawners.find((s) => s.kind === "goblin");
esend({
  t: "editor:updateSpawner",
  spawnerId: spawner.id,
  pos: spawner.pos,
  kind: spawner.kind,
  model: spawner.model,
  count: 2, // was 3 — forces a repopulate
  respawnMs: 12000,
  aggroRadius: 7,
});
await sleep(400);
const updated = worldDef.spawners.find((s) => s.id === spawner.id);
check(
  "spawner fields updated via inspector message",
  updated.count === 2 && updated.respawnMs === 12000 && updated.aggroRadius === 7,
  JSON.stringify({ count: updated.count, respawnMs: updated.respawnMs, aggro: updated.aggroRadius }),
);
await sleep(300);
const liveGoblins = [...entities.values()].filter((c) => c.npcTag?.kind === "goblin").length;
check("live goblin count repopulated to 2", liveGoblins === 2, `saw ${liveGoblins}`);

// --- Extended prop update (model swap) ---------------------------------------
const prop = worldDef.props[0];
const otherModel = prop.model === "rock" ? "tree" : "rock";
esend({
  t: "editor:updateProp",
  propId: prop.id,
  pos: prop.pos,
  rotY: prop.rotY,
  scale: prop.scale,
  model: otherModel,
});
await sleep(400);
check(
  "prop model swapped via inspector message",
  worldDef.props[0].model === otherModel,
  `${prop.model} -> ${worldDef.props[0].model}`,
);

// --- Restore original state ---------------------------------------------------
esend({
  t: "editor:updateProp",
  propId: prop.id,
  pos: prop.pos,
  rotY: prop.rotY,
  scale: prop.scale,
  model: prop.model,
});
esend({
  t: "editor:updateSpawner",
  spawnerId: spawner.id,
  pos: spawner.pos,
  kind: spawner.kind,
  model: spawner.model,
  count: spawner.count,
  respawnMs: spawner.respawnMs,
  aggroRadius: spawner.aggroRadius,
});
esend({ t: "editor:setQuests", quests: originalQuests });
await sleep(400);
check(
  "original quests restored",
  worldDef.quests.length === originalQuests.length,
  worldDef.quests.map((q) => q.id).join(","),
);
check(
  "player told about restored quests",
  questDefsMsgs[questDefsMsgs.length - 1].quests.length === originalQuests.length,
);

editor.close();
player.close();
await sleep(200);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILURES` : "\nALL PASS");
process.exit(failed ? 1 : 0);
