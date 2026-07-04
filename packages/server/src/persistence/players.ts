import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Health, Transform, type PlayerQuestState, type Vec3 } from "@mmo/shared";
import { PLAYER_DATA_DIR } from "../paths";
import { playerSessions, type GameCtx, type Session } from "../state";

export interface PlayerSave {
  pos: Vec3;
  hp: number;
  /** Optional so pre-quest saves keep loading. */
  xp?: number;
  quests?: PlayerQuestState;
}

function fileFor(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return join(PLAYER_DATA_DIR, `${safe}.json`);
}

export function loadPlayer(name: string): PlayerSave | null {
  try {
    return JSON.parse(readFileSync(fileFor(name), "utf8")) as PlayerSave;
  } catch {
    return null;
  }
}

export function savePlayer(ctx: GameCtx, session: Session): void {
  if (!session.entityId || !ctx.world.isAlive(session.entityId)) return;
  const tr = ctx.world.get(session.entityId, Transform);
  const health = ctx.world.get(session.entityId, Health);
  if (!tr || !health) return;
  mkdirSync(PLAYER_DATA_DIR, { recursive: true });
  const save: PlayerSave = {
    pos: { ...tr.pos },
    hp: health.hp,
    xp: session.xp,
    quests: session.quests,
  };
  writeFileSync(fileFor(session.name), JSON.stringify(save, null, 2), "utf8");
}

export function saveAllPlayers(ctx: GameCtx): void {
  for (const s of playerSessions(ctx)) savePlayer(ctx, s);
}
