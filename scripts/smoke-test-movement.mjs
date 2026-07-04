// Movement smoothness test: mirrors the client's prediction math exactly,
// sends inputs with deliberate timing jitter, and checks that every server
// ack matches the local prediction for that seq. Divergence = rubber-banding
// the player would see. Also verifies the jump arc (rise + land).
// Requires the server to be running.
import { readFileSync, rmSync } from "node:fs";

rmSync(new URL("../data/players/smokejumper.json", import.meta.url), { force: true });

// Must match packages/shared/src/constants.ts.
const SPEED = 6;
const GRAVITY = 20;
const JUMP_SPEED = 7.5;
const TICK_MS = 50;
const BOUND = 100;
const PLAYER_RADIUS = 0.5;

// Mirror of packages/shared/src/collision.ts resolveCircleCollisions.
function resolveCollisions(x, z, radius, colliders) {
  for (let pass = 0; pass < 2; pass++) {
    for (const c of colliders) {
      const minDist = radius + c.r;
      const dx = x - c.x;
      const dz = z - c.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) {
        x = c.x + minDist;
      } else {
        const push = minDist / dist;
        x = c.x + dx * push;
        z = c.z + dz * push;
      }
    }
  }
  return { x, z };
}

const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const ws = new WebSocket("ws://localhost:8080");
let selfId = 0;
let welcome = null;
const acks = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === "welcome") {
    welcome = m;
    selfId = m.entityId;
  }
  if (m.t === "inputAck") acks.push(m);
};
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ t: "join", name: "SmokeJumper" }));
while (!selfId) await sleep(20);
await sleep(300);

// Build the prop collider list the same way server and client do:
// world.json props (instantiated first at boot => entity ids 1..N in order)
// with radii from the welcome message.
const worldDef = JSON.parse(
  readFileSync(new URL("../assets/world/world.json", import.meta.url), "utf8"),
);
const radii = welcome.colliderRadii ?? {};
const colliders = worldDef.props
  .map((p, i) => ({ id: i + 1, x: p.pos.x, z: p.pos.z, r: (radii[p.model] ?? 0) * p.scale }))
  .filter((c) => c.r > 0);

// Local replica of Prediction.step / server integration.
const sim = { x: 0, y: 0, z: 0, vy: 0 };
function step(moveX, moveZ, jump) {
  const dt = TICK_MS / 1000;
  if (jump && sim.y <= 0) sim.vy = JUMP_SPEED;
  const resolved = resolveCollisions(
    sim.x + moveX * SPEED * dt,
    sim.z + moveZ * SPEED * dt,
    PLAYER_RADIUS,
    colliders,
  );
  sim.x = clamp(resolved.x, -BOUND, BOUND);
  sim.z = clamp(resolved.z, -BOUND, BOUND);
  if (sim.y > 0 || sim.vy !== 0) {
    sim.vy -= GRAVITY * dt;
    sim.y += sim.vy * dt;
    if (sim.y <= 0) {
      sim.y = 0;
      sim.vy = 0;
    }
  }
}

let seq = 0;
const predictedAtSeq = new Map();
function sendInput(moveX, moveZ, jump) {
  step(moveX, moveZ, jump);
  seq++;
  predictedAtSeq.set(seq, { ...sim });
  ws.send(JSON.stringify({ t: "input", seq, moveX, moveZ, rotY: 0, jump: jump || undefined }));
}

// Phase 1: 4 seconds of movement with jittered send intervals (30-70ms),
// direction changes, and three jumps mid-run.
const jumpAtSeqs = new Set();
for (let i = 0; i < 80; i++) {
  const angle = i * 0.12;
  const jump = i === 15 || i === 40 || i === 65;
  if (jump) jumpAtSeqs.add(seq + 1);
  sendInput(Math.cos(angle), Math.sin(angle), jump);
  await sleep(30 + Math.random() * 40); // deliberate jitter around the 50ms tick
}
sendInput(0, 0, false);
await sleep(600);

// Compare every ack against the prediction for that seq.
let maxDiv = 0;
let compared = 0;
let maxAckY = 0;
for (const ack of acks) {
  maxAckY = Math.max(maxAckY, ack.y ?? 0);
  const p = predictedAtSeq.get(ack.seq);
  if (!p) continue;
  compared++;
  const div = Math.hypot(ack.x - p.x, ack.z - p.z, (ack.y ?? 0) - p.y);
  if (process.env.DEBUG_DIVERGENCE && div > 1e-9) {
    console.log(
      `seq ${ack.seq}: dx=${(ack.x - p.x).toFixed(4)} dy=${((ack.y ?? 0) - p.y).toFixed(4)} dz=${(ack.z - p.z).toFixed(4)}`,
    );
  }
  maxDiv = Math.max(maxDiv, div);
}
check("acks received and compared", compared > 20, `${compared} acks`);
check(
  "prediction matches server exactly under jitter (no rubber-banding)",
  maxDiv < 1e-6,
  `max divergence ${maxDiv.toExponential(2)} over ${compared} acks`,
);
check("jump arc visible in acks", maxAckY > 1.0, `apex ${maxAckY.toFixed(2)}`);

check(
  "welcome includes collider radii",
  typeof radii.tree === "number" && Math.abs(radii.tree - 0.8) < 0.01,
  `tree=${radii.tree}`,
);

// Phase 2: standing jump — verify rise and clean landing at y exactly 0.
acks.length = 0;
sendInput(0, 0, true);
for (let i = 0; i < 20; i++) {
  sendInput(0, 0, false);
  await sleep(50);
}
await sleep(400);
const ys = acks.map((a) => a.y ?? 0);
const apex = Math.max(...ys);
const final = ys[ys.length - 1];
check("standing jump rises", apex > 1.0 && apex < 1.6, `apex ${apex.toFixed(2)}`);
check("lands exactly on ground", final === 0, `final y ${final}`);
check("grounded with zero vertical velocity", acks[acks.length - 1].vy === 0);

// Phase 3: collision — run straight at the tree at (8, -6) for 3s.
// Without collision the player would blow ~12 units past it.
const tree = worldDef.props.find((p) => p.id === "prop-tree-1");
const treeBlock = (radii.tree ?? 0) * tree.scale + PLAYER_RADIUS;
acks.length = 0;
predictedAtSeq.clear();
for (let i = 0; i < 60; i++) {
  const dx = tree.pos.x - sim.x;
  const dz = tree.pos.z - sim.z;
  const len = Math.hypot(dx, dz) || 1;
  sendInput(dx / len, dz / len, false);
  await sleep(30 + Math.random() * 40);
}
sendInput(0, 0, false);
await sleep(500);

let wallMaxDiv = 0;
let wallCompared = 0;
let minAckDist = Infinity;
for (const ack of acks) {
  minAckDist = Math.min(minAckDist, Math.hypot(ack.x - tree.pos.x, ack.z - tree.pos.z));
  const p = predictedAtSeq.get(ack.seq);
  if (!p) continue;
  wallCompared++;
  wallMaxDiv = Math.max(wallMaxDiv, Math.hypot(ack.x - p.x, ack.z - p.z, (ack.y ?? 0) - p.y));
}
check(
  "tree blocks movement (no pass-through)",
  minAckDist >= treeBlock - 0.01,
  `min dist ${minAckDist.toFixed(3)}, blocked at ${treeBlock.toFixed(3)}`,
);
check(
  "prediction stays exact while pushing against the wall",
  wallCompared > 15 && wallMaxDiv < 1e-6,
  `max divergence ${wallMaxDiv.toExponential(2)} over ${wallCompared} acks`,
);

ws.close();
await sleep(200);
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
