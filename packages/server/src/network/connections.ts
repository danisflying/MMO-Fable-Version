import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import {
  CHAT_LOCAL_RADIUS,
  Health,
  PLAYER_MAX_HP,
  Transform,
  decode,
  distSq,
  sanitizeQuestState,
  terrainToJSON,
  type ClientMessage,
} from "@mmo/shared";
import { playerSessions, Session, type GameCtx } from "../state";
import { spawnPlayer } from "../game/spawn";
import {
  handleAbandon,
  handleAccept,
  handleInteract,
  handleTurnIn,
  sendQuestState,
} from "../game/quests";
import { loadPlayer, savePlayer } from "../persistence/players";
import { handleEditorMessage } from "../editor/handlers";

export function setupNetwork(ctx: GameCtx, httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (socket) => {
    const session = new Session(socket);
    ctx.sessions.add(session);
    socket.on("message", (data) => handleMessage(ctx, session, data.toString()));
    socket.on("close", () => handleDisconnect(ctx, session));
    socket.on("error", () => socket.close());
  });
}

function handleMessage(ctx: GameCtx, session: Session, raw: string): void {
  const msg = decode<ClientMessage>(raw);
  if (!msg) return;

  if (msg.t.startsWith("editor:")) {
    handleEditorMessage(ctx, session, msg as Extract<ClientMessage, { t: `editor:${string}` }>);
    return;
  }

  switch (msg.t) {
    case "join":
      handleJoin(ctx, session, msg.name);
      break;
    case "input":
      if (session.entityId && typeof msg.seq === "number") {
        session.inputQueue.push({
          seq: msg.seq,
          moveX: Number(msg.moveX) || 0,
          moveZ: Number(msg.moveZ) || 0,
          rotY: Number(msg.rotY) || 0,
          jump: msg.jump === true,
        });
        // Hard cap against floods (a different job than inputSystem's
        // MAX_BACKLOG = 4, which is stall catch-up — see input.ts).
        if (session.inputQueue.length > 10) session.inputQueue.shift();
      }
      break;
    case "attack":
      if (session.entityId && typeof msg.target === "number") {
        ctx.pendingAttacks.push({
          attacker: session.entityId,
          target: msg.target,
          ability: typeof msg.ability === "string" ? msg.ability : "strike",
        });
      }
      break;
    case "chat":
      handleChat(ctx, session, msg.channel === "global" ? "global" : "local", String(msg.text));
      break;
    case "interact":
      if (session.entityId && typeof msg.npc === "number") {
        handleInteract(ctx, session, msg.npc);
      }
      break;
    case "questAccept":
      if (session.entityId && typeof msg.questId === "string" && typeof msg.npc === "number") {
        handleAccept(ctx, session, msg.questId, msg.npc);
      }
      break;
    case "questTurnIn":
      if (session.entityId && typeof msg.questId === "string" && typeof msg.npc === "number") {
        handleTurnIn(ctx, session, msg.questId, msg.npc);
      }
      break;
    case "questAbandon":
      if (session.entityId && typeof msg.questId === "string") {
        handleAbandon(session, msg.questId);
      }
      break;
  }
}

function handleJoin(ctx: GameCtx, session: Session, rawName: string): void {
  if (session.entityId) return;
  const name = String(rawName ?? "").trim().slice(0, 16);
  if (name.length < 2) {
    session.send({ t: "error", message: "Name must be at least 2 characters." });
    return;
  }
  for (const s of ctx.sessions) {
    if (s !== session && s.name.toLowerCase() === name.toLowerCase()) {
      session.send({ t: "error", message: `"${name}" is already online.` });
      return;
    }
  }

  const save = loadPlayer(name);
  const pos = save?.pos ?? { ...ctx.def.spawnPoint };
  const hp = save && save.hp > 0 ? Math.min(save.hp, PLAYER_MAX_HP) : PLAYER_MAX_HP;
  session.name = name;
  session.xp = typeof save?.xp === "number" && save.xp > 0 ? save.xp : 0;
  session.quests = sanitizeQuestState(save?.quests, ctx.questsById);
  session.entityId = spawnPlayer(ctx, name, pos, hp);
  session.send({
    t: "welcome",
    entityId: session.entityId,
    bounds: ctx.def.bounds,
    spawnPoint: ctx.def.spawnPoint,
    colliderRadii: ctx.colliderRadii,
    terrain: terrainToJSON(ctx.terrain),
  });
  session.send({ t: "questDefs", quests: ctx.def.quests });
  sendQuestState(session);
  console.log(`player joined: ${name} (entity ${session.entityId})`);
}

function handleChat(ctx: GameCtx, session: Session, channel: "global" | "local", text: string): void {
  if (!session.entityId) return;
  const trimmed = text.trim().slice(0, 240);
  if (!trimmed) return;

  if (channel === "global") {
    for (const s of playerSessions(ctx)) {
      s.send({ t: "chatMsg", channel, from: session.name, text: trimmed });
    }
    return;
  }

  const senderTr = ctx.world.get(session.entityId, Transform);
  if (!senderTr) return;
  for (const s of playerSessions(ctx)) {
    const tr = ctx.world.get(s.entityId, Transform);
    if (!tr) continue;
    if (
      distSq(tr.pos.x, tr.pos.z, senderTr.pos.x, senderTr.pos.z) <=
      CHAT_LOCAL_RADIUS * CHAT_LOCAL_RADIUS
    ) {
      s.send({ t: "chatMsg", channel, from: session.name, text: trimmed });
    }
  }
}

function handleDisconnect(ctx: GameCtx, session: Session): void {
  if (session.entityId && ctx.world.isAlive(session.entityId)) {
    // Don't persist a dead player's 0 hp; deathSystem would have respawned them.
    const health = ctx.world.get(session.entityId, Health);
    if (health && health.hp <= 0) health.hp = health.maxHp;
    savePlayer(ctx, session);
    ctx.world.destroy(session.entityId);
    console.log(`player left: ${session.name}`);
  }
  ctx.sessions.delete(session);
}
