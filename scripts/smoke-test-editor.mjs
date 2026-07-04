// Editor protocol smoke test: auth, place a prop, verify it streams to a
// player and persists via save, then delete it and save again to restore.
import { readFileSync, rmSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Asset HTTP server
const idx = await fetch("http://localhost:8080/assets/models/index.json").then((r) => r.json());
check("model index served", Array.isArray(idx.models) && idx.models.includes("goblin"), idx.models.join(","));
const glb = await fetch("http://localhost:8080/assets/models/tree.glb");
check(
  "GLB served with content type",
  glb.ok && glb.headers.get("content-type") === "model/gltf-binary",
  `${glb.status} ${glb.headers.get("content-type")}`,
);

// Editor session
const ws = new WebSocket("ws://localhost:8080");
let worldDef = null;
let authOk = false;
let saved = false;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "editor:authOk") authOk = true;
  if (m.t === "editor:worldState") worldDef = m.def;
  if (m.t === "editor:saved") saved = true;
};
await new Promise((r) => (ws.onopen = r));
const send = (m) => ws.send(JSON.stringify(m));

send({ t: "editor:auth", token: "wrong" });
await sleep(200);
check("wrong token rejected", !authOk);

send({ t: "editor:auth", token: "dev" });
await sleep(200);
check("auth + worldState received", authOk && worldDef !== null, `${worldDef?.props.length} props`);

// A player to observe live edits near spawn
rmSync(new URL("../data/players/editwatcher.json", import.meta.url), { force: true });
const player = new WebSocket("ws://localhost:8080");
const playerEntities = new Map();
let playerAck = null;
let playerWelcome = null;
player.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "welcome") playerWelcome = m;
  if (m.t === "spawn") for (const e of m.entities) playerEntities.set(e.id, e.c);
  if (m.t === "despawn") for (const id of m.ids) playerEntities.delete(id);
  if (m.t === "inputAck") playerAck = m;
};
await new Promise((r) => (player.onopen = r));
player.send(JSON.stringify({ t: "join", name: "EditWatcher" }));
await sleep(400);

const propsBefore = worldDef.props.length;
send({ t: "editor:placeProp", model: "rock", pos: { x: 3, y: 0, z: 3 }, rotY: 1, scale: 2 });
await sleep(400);
check("placeProp updates worldState", worldDef.props.length === propsBefore + 1);
const newProp = worldDef.props[worldDef.props.length - 1];
check(
  "placed prop streams live to player",
  [...playerEntities.values()].some((c) => c.propTag?.propId === newProp.id),
);

// The freshly placed rock (radius 0.9 * scale 2) must block movement live:
// walk the player from spawn straight at (3,3) for 1.5s (9 units of travel).
let seq = 0;
for (let i = 0; i < 30; i++) {
  const x = playerAck?.x ?? 0;
  const z = playerAck?.z ?? 0;
  const dx = 3 - x;
  const dz = 3 - z;
  const len = Math.hypot(dx, dz) || 1;
  player.send(JSON.stringify({ t: "input", seq: ++seq, moveX: dx / len, moveZ: dz / len, rotY: 0 }));
  await sleep(50);
}
player.send(JSON.stringify({ t: "input", seq: ++seq, moveX: 0, moveZ: 0, rotY: 0 }));
await sleep(300);
const rockRadius = (playerWelcome.colliderRadii?.rock ?? 0) * 2 + 0.5;
const distToRock = Math.hypot(playerAck.x - 3, playerAck.z - 3);
check(
  "live-placed prop blocks movement",
  rockRadius > 1 && distToRock >= rockRadius - 0.05,
  `dist ${distToRock.toFixed(3)}, blocked at ${rockRadius.toFixed(3)}`,
);

send({ t: "editor:save" });
await sleep(400);
const onDisk = JSON.parse(readFileSync(new URL("../assets/world/world.json", import.meta.url), "utf8"));
check("save persists prop to world.json", saved && onDisk.props.some((p) => p.id === newProp.id));

// Clean up: delete the test prop and save again.
send({ t: "editor:deleteProp", propId: newProp.id });
await sleep(400);
check("deleteProp removes from worldState", worldDef.props.length === propsBefore);
check(
  "deleted prop despawns for player",
  ![...playerEntities.values()].some((c) => c.propTag?.propId === newProp.id),
);
send({ t: "editor:save" });
await sleep(400);
const onDisk2 = JSON.parse(readFileSync(new URL("../assets/world/world.json", import.meta.url), "utf8"));
check("cleanup save restores world.json", !onDisk2.props.some((p) => p.id === newProp.id));

ws.close();
player.close();
await sleep(200);
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
