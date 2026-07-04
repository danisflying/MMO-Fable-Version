import { SERVER_PORT, SNAPSHOT_EVERY, TICK_MS } from "@mmo/shared";
import { createCtx, rebuildPropColliders } from "./state";
import { loadColliderRadii } from "./assets/glbBounds";
import { instantiateWorld, loadWorldDef } from "./persistence/worldLoader";
import { saveAllPlayers } from "./persistence/players";
import { createHttpServer } from "./network/http";
import { setupNetwork } from "./network/connections";
import { inputSystem } from "./game/systems/input";
import { npcAiSystem } from "./game/systems/npcAi";
import { movementSystem } from "./game/systems/movement";
import { combatSystem } from "./game/systems/combat";
import { deathSystem } from "./game/systems/death";
import { respawnSystem } from "./game/systems/respawn";
import { questSystem } from "./game/quests";
import { sendSnapshots } from "./streaming/interest";

const ctx = createCtx(loadWorldDef(), loadColliderRadii());
instantiateWorld(ctx);
rebuildPropColliders(ctx);

const httpServer = createHttpServer();
setupNetwork(ctx, httpServer);
httpServer.listen(SERVER_PORT, () => {
  console.log(`world server listening on :${SERVER_PORT} (ws + /assets)`);
  console.log(
    `world: ${ctx.def.props.length} props, ${ctx.def.spawners.length} spawners`,
  );
});

const dt = TICK_MS / 1000;
let tick = 0;

function runTick(): void {
  ctx.time += TICK_MS;
  inputSystem(ctx, dt);
  npcAiSystem(ctx);
  movementSystem(ctx, dt);
  combatSystem(ctx);
  deathSystem(ctx);
  respawnSystem(ctx);
  questSystem(ctx);
  if (++tick % SNAPSHOT_EVERY === 0) sendSnapshots(ctx);
}

// Drift-correcting loop: plain setInterval(50) fires at the OS timer quantum
// (~15.6ms steps on Windows => ~62ms/tick), which slow-ticks the sim and
// makes the server fall behind clients' 20Hz input streams until the input
// queue overflows. The accumulator runs catch-up ticks so the long-run rate
// is exactly TICK_RATE regardless of timer granularity.
let last = performance.now();
let acc = 0;
function loop(): void {
  const now = performance.now();
  acc += now - last;
  last = now;
  if (acc > 1000) acc = 1000; // cap catch-up after a process stall
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    runTick();
  }
  setTimeout(loop, Math.max(1, TICK_MS - acc));
}
loop();

// Periodic safety save so a crash loses at most ~30s of player progress.
setInterval(() => saveAllPlayers(ctx), 30_000);

process.on("SIGINT", () => {
  saveAllPlayers(ctx);
  process.exit(0);
});
