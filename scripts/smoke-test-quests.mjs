// End-to-end quest smoke test: joins a player, walks to the villager, accepts
// quests, kills goblins for credit, talks to the guard, scouts the camp,
// turns everything in, and checks XP/persistence across a reconnect.
// Requires the server to be running. Uses Node's built-in WebSocket (Node 22+).

import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const dataDir = new URL("../data/players/", import.meta.url);
for (const n of ["smokequest", "smokewatch", "smokelegacy"]) {
  rmSync(new URL(`${n}.json`, dataDir), { force: true });
}

const WS_URL = "ws://localhost:8080";
const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      ws,
      name,
      selfId: 0,
      seqCounter: 0,
      entities: new Map(),
      questStates: [],
      questDialogs: [],
      lastAck: null,
      send: (m) => ws.send(JSON.stringify(m)),
    };
    ws.onopen = () => client.send({ t: "join", name });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case "welcome":
          client.selfId = m.entityId;
          resolve(client);
          break;
        case "spawn":
          for (const e of m.entities) client.entities.set(e.id, e.c);
          break;
        case "despawn":
          for (const id of m.ids) client.entities.delete(id);
          break;
        case "delta":
          for (const e of m.entities) {
            const existing = client.entities.get(e.id);
            if (existing) Object.assign(existing, e.c);
          }
          break;
        case "questState":
          client.questStates.push(m);
          break;
        case "questDialog":
          client.questDialogs.push(m);
          break;
        case "inputAck":
          client.lastAck = m;
          break;
        case "error":
          reject(new Error(m.message));
          break;
      }
    };
    ws.onerror = () => reject(new Error("connection failed"));
    setTimeout(() => reject(new Error("welcome timeout")), 3000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (c) => c.questStates[c.questStates.length - 1];
const activeOf = (c, id) => qs(c)?.active.find((q) => q.questId === id);
const findNpc = (c, kind) =>
  [...c.entities.entries()].find(([, e]) => e.npcTag?.kind === kind && e.health?.hp > 0);

/** One 50ms input step toward a world position. */
function stepToward(c, pos) {
  const me = c.lastAck ?? { x: 0, z: 0 };
  const dx = pos.x - me.x;
  const dz = pos.z - me.z;
  const len = Math.hypot(dx, dz) || 1;
  c.send({ t: "input", seq: ++c.seqCounter, moveX: dx / len, moveZ: dz / len, rotY: 0 });
}

/** Walk until within `stopDist` of a (possibly moving) target position. */
async function moveTo(c, getPos, stopDist, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const me = c.lastAck;
    const pos = getPos();
    if (me && pos && Math.hypot(pos.x - me.x, pos.z - me.z) <= stopDist) break;
    if (pos) stepToward(c, pos);
    await sleep(50);
  }
  c.send({ t: "input", seq: ++c.seqCounter, moveX: 0, moveZ: 0, rotY: 0 });
  await sleep(200);
}

/** Interact and wait for the resulting dialog (null on timeout). */
async function interact(c, npcId, timeoutMs = 1000) {
  const before = c.questDialogs.length;
  c.send({ t: "interact", npc: npcId });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (c.questDialogs.length > before) return c.questDialogs[c.questDialogs.length - 1];
    await sleep(50);
  }
  return null;
}

// Fight goblins until goblin_cull has `needed` kills (kites toward the camp).
async function killGoblins(c, needed, timeoutMs = 180000) {
  const start = Date.now();
  let healAt = 0;
  while ((activeOf(c, "goblin_cull")?.progress[0] ?? 0) < needed) {
    if (Date.now() - start > timeoutMs) return false;
    const me = c.lastAck;
    const gob = findNpc(c, "goblin");
    if (!me || !gob) {
      stepToward(c, { x: 25, z: -20 });
      await sleep(50);
      continue;
    }
    const [gid, ge] = gob;
    const gp = ge.transform.pos;
    if (Math.hypot(gp.x - me.x, gp.z - me.z) > 2.2) {
      stepToward(c, gp);
      await sleep(50);
      continue;
    }
    c.send({ t: "input", seq: ++c.seqCounter, moveX: 0, moveZ: 0, rotY: 0 });
    // Spam abilities; the server rejects on-cooldown casts with abilityFail, which is fine.
    c.send({ t: "attack", target: gid, ability: "strike" });
    c.send({ t: "attack", target: gid, ability: "fireball" });
    c.send({ t: "attack", target: gid, ability: "heavy" });
    const hp = c.entities.get(c.selfId)?.health?.hp ?? 100;
    if (hp < 55 && Date.now() > healAt) {
      c.send({ t: "attack", target: c.selfId, ability: "heal" });
      healAt = Date.now() + 10500;
    }
    await sleep(300);
  }
  return true;
}

// ---------------------------------------------------------------------------

const a = await connect("SmokeQuest");
const b = await connect("SmokeWatch"); // bystander: must see none of A's quest traffic
await sleep(500);

// Join push
check(
  "questState pushed on join",
  qs(a) && qs(a).xp === 0 && qs(a).level === 1 && qs(a).active.length === 0,
  JSON.stringify(qs(a) ?? null),
);

// Probe: interact from spawn — villager is ~7 units away, out of range.
const villagerFar = findNpc(a, "villager");
check("villager streamed in", !!villagerFar);
if (villagerFar) {
  const dlg = await interact(a, villagerFar[0], 700);
  check("out-of-range interact ignored", dlg === null, dlg ? "got a dialog!" : "");
}

// Walk to the villager and open the dialog.
await moveTo(a, () => findNpc(a, "villager")?.[1].transform.pos, 2.5);
const villager = findNpc(a, "villager");
let dlg = await interact(a, villager[0]);
check(
  "villager offers cull + watch, not camp (prereq)",
  dlg &&
    dlg.offers.includes("goblin_cull") &&
    dlg.offers.includes("word_to_the_watch") &&
    !dlg.offers.includes("scout_the_camp") &&
    dlg.turnIns.length === 0,
  JSON.stringify(dlg && { offers: dlg.offers, turnIns: dlg.turnIns }),
);

// Probe: accepting the prereq-locked quest at the wrong NPC must be dropped.
a.send({ t: "questAccept", questId: "scout_the_camp", npc: villager[0] });
await sleep(400);
check("prereq-locked accept rejected", !activeOf(a, "scout_the_camp"));

// Accept both offered quests.
a.send({ t: "questAccept", questId: "goblin_cull", npc: villager[0] });
a.send({ t: "questAccept", questId: "word_to_the_watch", npc: villager[0] });
await sleep(400);
check(
  "both quests accepted",
  !!activeOf(a, "goblin_cull") && !!activeOf(a, "word_to_the_watch"),
  JSON.stringify(qs(a)?.active),
);

// Probe: turning in an incomplete quest must be dropped.
a.send({ t: "questTurnIn", questId: "goblin_cull", npc: villager[0] });
await sleep(400);
check(
  "incomplete turn-in rejected",
  !!activeOf(a, "goblin_cull") && !qs(a).completed.includes("goblin_cull"),
);

// Abandon + re-accept.
a.send({ t: "questAbandon", questId: "word_to_the_watch" });
await sleep(300);
check("abandon removes quest", !activeOf(a, "word_to_the_watch"));
a.send({ t: "questAccept", questId: "word_to_the_watch", npc: villager[0] });
await sleep(300);
check("re-accept after abandon", !!activeOf(a, "word_to_the_watch"));

// Talk objective: walk to the guard; a single interact credits the talk AND
// offers the turn-in in the same dialog.
await moveTo(a, () => findNpc(a, "guard")?.[1].transform.pos, 2.5);
const guard = findNpc(a, "guard");
dlg = await interact(a, guard[0]);
check(
  "talk credited + turn-in offered in one interact",
  (activeOf(a, "word_to_the_watch")?.progress[0] ?? 0) >= 1 &&
    dlg?.turnIns.includes("word_to_the_watch"),
  JSON.stringify(dlg && { turnIns: dlg.turnIns }),
);
a.send({ t: "questTurnIn", questId: "word_to_the_watch", npc: guard[0] });
await sleep(400);
const xpAfterWatch = qs(a).xp;
check(
  "watch turned in, +40 xp",
  qs(a).completed.includes("word_to_the_watch") && xpAfterWatch >= 40,
  `xp=${xpAfterWatch}`,
);

// Prereq met: guard now offers the scout quest.
dlg = await interact(a, guard[0]);
check("guard offers scout after prereq", dlg?.offers.includes("scout_the_camp"));
a.send({ t: "questAccept", questId: "scout_the_camp", npc: guard[0] });
await sleep(300);

// Kill 5 goblins at the camp; walking there also completes the reach objective.
const killed = await killGoblins(a, 5);
check(
  "kill objective progressed to 5/5",
  killed && (activeOf(a, "goblin_cull")?.progress[0] ?? 0) >= 5,
  JSON.stringify(activeOf(a, "goblin_cull")),
);
check(
  "reach objective completed at camp",
  (activeOf(a, "scout_the_camp")?.progress[0] ?? 0) >= 1,
  JSON.stringify(activeOf(a, "scout_the_camp")),
);
check("kill xp granted (8/goblin)", qs(a).xp >= xpAfterWatch + 40, `xp=${qs(a).xp}`);

// Turn both in.
await moveTo(a, () => findNpc(a, "guard")?.[1].transform.pos, 2.5);
a.send({ t: "questTurnIn", questId: "scout_the_camp", npc: findNpc(a, "guard")[0] });
await sleep(400);
await moveTo(a, () => findNpc(a, "villager")?.[1].transform.pos, 2.5);
a.send({ t: "questTurnIn", questId: "goblin_cull", npc: findNpc(a, "villager")[0] });
await sleep(400);
const final = qs(a);
check(
  "all three quests completed",
  final.completed.length === 3 && final.active.length === 0,
  JSON.stringify(final.completed),
);
check("level >= 2 after 280+ xp", final.level >= 2, `xp=${final.xp} level=${final.level}`);

// Friendly NPCs never fight back: villager still full hp despite goblin chaos.
const vill = findNpc(a, "villager");
check("villager alive and passive", !!vill && vill[1].health.hp > 0);

// Bystander isolation: B got exactly its own join push, nothing of A's.
check(
  "bystander received no quest traffic",
  b.questStates.length === 1 && b.questDialogs.length === 0,
  `questStates=${b.questStates.length}`,
);

// Persistence: disconnect, inspect the save, reconnect.
a.ws.close();
await sleep(600);
const save = JSON.parse(readFileSync(new URL("smokequest.json", dataDir), "utf8"));
check(
  "save file carries xp + quests",
  save.xp === final.xp && save.quests?.completed?.length === 3,
  `xp=${save.xp} completed=${save.quests?.completed?.length}`,
);
const a2 = await connect("SmokeQuest");
await sleep(400);
check(
  "reconnect restores xp/level/completed",
  qs(a2).xp === final.xp && qs(a2).level === final.level && qs(a2).completed.length === 3,
  `xp=${qs(a2).xp} level=${qs(a2).level}`,
);
a2.ws.close();

// Legacy save (pos/hp only) still loads with fresh quest state.
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  new URL("smokelegacy.json", dataDir),
  JSON.stringify({ pos: { x: 1, y: 0, z: 1 }, hp: 77 }),
);
const legacy = await connect("SmokeLegacy");
await sleep(400);
check(
  "legacy save loads with empty quest state",
  qs(legacy).xp === 0 && qs(legacy).active.length === 0 && qs(legacy).completed.length === 0,
  JSON.stringify(qs(legacy)),
);
check("legacy hp preserved", legacy.entities.get(legacy.selfId)?.health?.hp === 77);
legacy.ws.close();
b.ws.close();
await sleep(200);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} FAILURES` : "\nALL PASS");
process.exit(failed ? 1 : 0);
