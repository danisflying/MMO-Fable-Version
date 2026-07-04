import {
  Health,
  INTERACT_RANGE,
  NpcTag,
  RANGE_SLACK,
  Transform,
  distSq,
  isObjectiveDone,
  isQuestComplete,
  levelForXp,
  objectiveTarget,
  type Entity,
  type QuestDef,
} from "@mmo/shared";
import { playerSessions, type GameCtx, type Session } from "../state";

/** XP granted per NPC kill, independent of quests. */
const KILL_XP: Record<string, number> = { goblin: 8 };

/** Reach objectives are polled at 4 Hz, not every tick. */
const REACH_CHECK_MS = 250;
let nextReachCheckAt = 0;

export function sendQuestState(session: Session): void {
  session.send({
    t: "questState",
    active: session.quests.active,
    completed: session.quests.completed,
    xp: session.xp,
    level: levelForXp(session.xp).level,
  });
}

export function grantXp(session: Session, amount: number): void {
  if (amount > 0) session.xp += amount;
}

/** Kill credit from deathSystem: per-kill XP + matching kill objectives. */
export function onNpcKilled(ctx: GameCtx, session: Session, kind: string): void {
  let changed = (KILL_XP[kind] ?? 0) > 0;
  grantXp(session, KILL_XP[kind] ?? 0);
  for (const qp of session.quests.active) {
    const def = ctx.questsById[qp.questId];
    if (!def) continue;
    def.objectives.forEach((obj, i) => {
      if (obj.type === "kill" && obj.npcKind === kind && !isObjectiveDone(obj, qp.progress[i] ?? 0)) {
        qp.progress[i] = (qp.progress[i] ?? 0) + 1;
        changed = true;
      }
    });
  }
  if (changed) sendQuestState(session);
}

/** Validate that `npc` is a live quest NPC within interact range; return its kind. */
function validateInteract(ctx: GameCtx, session: Session, npc: Entity): string | null {
  const { world } = ctx;
  if (!session.entityId || !world.isAlive(session.entityId) || !world.isAlive(npc)) return null;
  const tag = world.get(npc, NpcTag);
  const npcHealth = world.get(npc, Health);
  const npcTr = world.get(npc, Transform);
  const playerTr = world.get(session.entityId, Transform);
  if (!tag || !npcHealth || npcHealth.hp <= 0 || !npcTr || !playerTr) return null;
  const maxRange = INTERACT_RANGE + RANGE_SLACK;
  if (distSq(playerTr.pos.x, playerTr.pos.z, npcTr.pos.x, npcTr.pos.z) > maxRange * maxRange) {
    return null;
  }
  return tag.kind;
}

function isOfferable(session: Session, def: QuestDef, kind: string): boolean {
  return (
    def.giverKind === kind &&
    !session.quests.completed.includes(def.id) &&
    !session.quests.active.some((qp) => qp.questId === def.id) &&
    (!def.prereq || session.quests.completed.includes(def.prereq))
  );
}

/** Credit unfinished talk objectives targeting this NPC kind. Returns true if any changed. */
function creditTalk(ctx: GameCtx, session: Session, kind: string): boolean {
  let changed = false;
  for (const qp of session.quests.active) {
    const def = ctx.questsById[qp.questId];
    if (!def) continue;
    def.objectives.forEach((obj, i) => {
      if (obj.type === "talk" && obj.npcKind === kind && !isObjectiveDone(obj, qp.progress[i] ?? 0)) {
        qp.progress[i] = objectiveTarget(obj);
        changed = true;
      }
    });
  }
  return changed;
}

export function handleInteract(ctx: GameCtx, session: Session, npc: Entity): void {
  const kind = validateInteract(ctx, session, npc);
  if (kind === null) return;

  // Credit talk objectives first so a completed talk quest is immediately
  // offered for turn-in in the same dialog.
  if (creditTalk(ctx, session, kind)) sendQuestState(session);

  const offers: string[] = [];
  const turnIns: string[] = [];
  for (const def of ctx.def.quests) {
    if (isOfferable(session, def, kind)) offers.push(def.id);
  }
  for (const qp of session.quests.active) {
    const def = ctx.questsById[qp.questId];
    if (def && def.turnInKind === kind && isQuestComplete(def, qp)) turnIns.push(def.id);
  }
  // Always answer, even with nothing to offer — the client shows a flavor line.
  session.send({ t: "questDialog", npc, npcKind: kind, offers, turnIns });
}

export function handleAccept(ctx: GameCtx, session: Session, questId: string, npc: Entity): void {
  const kind = validateInteract(ctx, session, npc);
  const def = ctx.questsById[questId];
  if (kind === null || !def || !isOfferable(session, def, kind)) return;
  session.quests.active.push({ questId, progress: def.objectives.map(() => 0) });
  // A talk objective aimed at the giver itself is satisfied by this conversation.
  creditTalk(ctx, session, kind);
  sendQuestState(session);
}

export function handleTurnIn(ctx: GameCtx, session: Session, questId: string, npc: Entity): void {
  const kind = validateInteract(ctx, session, npc);
  const def = ctx.questsById[questId];
  if (kind === null || !def || def.turnInKind !== kind) return;
  const qp = session.quests.active.find((q) => q.questId === questId);
  if (!qp || !isQuestComplete(def, qp)) return;
  session.quests.active = session.quests.active.filter((q) => q.questId !== questId);
  session.quests.completed.push(questId);
  grantXp(session, def.xpReward);
  sendQuestState(session);
}

export function handleAbandon(session: Session, questId: string): void {
  const before = session.quests.active.length;
  session.quests.active = session.quests.active.filter((q) => q.questId !== questId);
  if (session.quests.active.length !== before) sendQuestState(session);
}

/** Poll unfinished reach objectives against player positions (throttled). */
export function questSystem(ctx: GameCtx): void {
  if (ctx.time < nextReachCheckAt) return;
  nextReachCheckAt = ctx.time + REACH_CHECK_MS;

  for (const session of playerSessions(ctx)) {
    if (session.quests.active.length === 0) continue;
    const tr = ctx.world.get(session.entityId, Transform);
    if (!tr) continue;
    let changed = false;
    for (const qp of session.quests.active) {
      const def = ctx.questsById[qp.questId];
      if (!def) continue;
      def.objectives.forEach((obj, i) => {
        if (obj.type !== "reach" || isObjectiveDone(obj, qp.progress[i] ?? 0)) return;
        if (distSq(tr.pos.x, tr.pos.z, obj.pos.x, obj.pos.z) <= obj.radius * obj.radius) {
          qp.progress[i] = objectiveTarget(obj);
          changed = true;
        }
      });
    }
    if (changed) sendQuestState(session);
  }
}
