// End-to-end smoke test: joins two players over WebSocket, moves one toward
// the goblin spawner, attacks a goblin, chats, and checks entity streaming.
// Requires the server to be running. Uses Node's built-in WebSocket (Node 22+).

import { rmSync } from "node:fs";

// Remove saves from previous runs so both players spawn at the spawn point.
for (const n of ["smokealice", "smokebob"]) {
  rmSync(new URL(`../data/players/${n}.json`, import.meta.url), { force: true });
}

const WS_URL = "ws://localhost:8080";
const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` â€” ${detail}` : ""}`);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      ws,
      name,
      selfId: 0,
      entities: new Map(),
      chat: [],
      combatEvents: [],
      abilityFails: [],
      lastAck: null,
      send: (m) => ws.send(JSON.stringify(m)),
    };
    ws.onopen = () => {
      client.send({ t: "join", name });
    };
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
        case "chatMsg":
          client.chat.push(m);
          break;
        case "combatEvent":
          client.combatEvents.push(...m.events);
          break;
        case "abilityFail":
          client.abilityFails.push(m);
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

// Drive movement: send inputs at 20 Hz toward a direction for `ms`.
async function move(client, moveX, moveZ, ms) {
  const steps = Math.floor(ms / 50);
  for (let i = 0; i < steps; i++) {
    client.send({ t: "input", seq: ++client.seqCounter, moveX, moveZ, rotY: 0 });
    await sleep(50);
  }
  client.send({ t: "input", seq: ++client.seqCounter, moveX: 0, moveZ: 0, rotY: 0 });
}

const a = await connect("SmokeAlice");
const b = await connect("SmokeBob");
a.seqCounter = 0;
b.seqCounter = 0;
await sleep(400);

check("welcome received", a.selfId > 0 && b.selfId > 0, `ids ${a.selfId}, ${b.selfId}`);
check("A sees B via streaming", a.entities.has(b.selfId));
check("B sees A via streaming", b.entities.has(a.selfId));
check(
  "A sees props in range",
  [...a.entities.values()].some((c) => c.propTag),
);

// Movement + prediction ack
const startAck = a.lastAck ? { ...a.lastAck } : null;
await move(a, 1, 0, 600);
await sleep(300);
check(
  "movement applied + acked",
  a.lastAck && startAck && a.lastAck.x > startAck.x + 1,
  `x ${startAck?.x?.toFixed(2)} -> ${a.lastAck?.x?.toFixed(2)}`,
);
const aOnB = b.entities.get(a.selfId);
check(
  "B sees A's new position (delta)",
  aOnB?.transform && aOnB.transform.pos.x > 1,
  `x=${aOnB?.transform?.pos.x?.toFixed(2)}`,
);

// Chat
a.send({ t: "chat", channel: "global", text: "hello world" });
a.send({ t: "chat", channel: "local", text: "psst" });
await sleep(300);
check(
  "global chat delivered",
  b.chat.some((c) => c.channel === "global" && c.text === "hello world" && c.from === "SmokeAlice"),
);
check("local chat delivered (in range)", b.chat.some((c) => c.channel === "local" && c.text === "psst"));

// Walk A toward the goblin spawner at (25, -20) and attack a goblin.
// A is near xâ‰ˆ3.6 now; head +x/-z for ~4s at 6 u/s.
await move(a, 0.75, -0.65, 4200);
await sleep(400);
const goblinEntry = [...a.entities.entries()].find(([, c]) => c.npcTag?.kind === "goblin");
check("goblin streamed in near spawner", !!goblinEntry, goblinEntry ? `entity ${goblinEntry[0]}` : "none visible");

if (goblinEntry) {
  const [gid, gc] = goblinEntry;
  const hpBefore = gc.health.hp;
  // Close remaining distance to the goblin.
  for (let i = 0; i < 120; i++) {
    const me = a.lastAck;
    const g = a.entities.get(gid);
    if (!me || !g) break;
    const dx = g.transform.pos.x - me.x;
    const dz = g.transform.pos.z - me.z;
    if (Math.hypot(dx, dz) < 2) break;
    const len = Math.hypot(dx, dz) || 1;
    a.send({ t: "input", seq: ++a.seqCounter, moveX: dx / len, moveZ: dz / len, rotY: 0 });
    await sleep(50);
  }
  a.send({ t: "input", seq: ++a.seqCounter, moveX: 0, moveZ: 0, rotY: 0 });
  a.send({ t: "attack", target: gid, ability: "strike" });
  await sleep(400);
  const hpAfter = a.entities.get(gid)?.health?.hp;
  check(
    "strike damaged goblin",
    a.combatEvents.some((ev) => ev.attacker === a.selfId && ev.target === gid) && hpAfter < hpBefore,
    `hp ${hpBefore} -> ${hpAfter}`,
  );

  // Immediate second strike must be rejected by the 1.5s cooldown.
  a.send({ t: "attack", target: gid, ability: "strike" });
  await sleep(300);
  check(
    "ability cooldown enforced",
    a.abilityFails.some((f) => f.ability === "strike"),
    a.abilityFails.map((f) => f.reason).join(", "),
  );

  // The goblin retaliates, so A should be damaged; heal restores hp.
  await sleep(1500);
  const myHpBefore = a.entities.get(a.selfId)?.health?.hp;
  a.send({ t: "attack", target: a.selfId, ability: "heal" });
  await sleep(400);
  const healEv = a.combatEvents.find((ev) => ev.ability === "heal");
  check(
    "heal ability applied",
    !!healEv && healEv.damage <= 0,
    `hp ${myHpBefore} -> ${a.entities.get(a.selfId)?.health?.hp}`,
  );
}

// AOI: B stays at spawn; walk A far away (+x for 8s â‰ˆ 48 units) and check despawn.
await move(a, 1, 0, 8000);
await sleep(500);
check("A despawned from B after leaving AOI", !b.entities.has(a.selfId));
check("B despawned from A after leaving AOI", !a.entities.has(b.selfId));

// Far from the goblin now: fireball (range 20) must fail out-of-range.
if (goblinEntry) {
  a.abilityFails.length = 0;
  a.send({ t: "attack", target: goblinEntry[0], ability: "fireball" });
  await sleep(300);
  check(
    "out-of-range ability rejected",
    a.abilityFails.some((f) => f.ability === "fireball"),
    a.abilityFails.map((f) => f.reason).join(", "),
  );
}

a.ws.close();
b.ws.close();
await sleep(200);

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
process.exit(failed ? 1 : 0);

