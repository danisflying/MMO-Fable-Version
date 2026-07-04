import type { GameCtx } from "../../state";
import { spawnNpc } from "../spawn";

/** Respawn dead NPCs once their timer elapses (spawner must still exist). */
export function respawnSystem(ctx: GameCtx): void {
  if (ctx.npcRespawns.length === 0) return;
  ctx.npcRespawns = ctx.npcRespawns.filter((r) => {
    if (ctx.time < r.at) return true;
    const def = ctx.def.spawners.find((s) => s.id === r.spawnerId);
    if (def) spawnNpc(ctx, def);
    return false;
  });
}
