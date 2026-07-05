import * as THREE from "three";
import {
  ABILITIES,
  ABILITY_BAR,
  INTERACT_RANGE,
  TICK_MS,
  distSq,
  isObjectiveDone,
  isQuestComplete,
  objectiveTarget,
  applyTerrainPatch,
  heightAt,
  questIndex,
  terrainFromJSON,
  type CircleCollider,
  type QuestDef,
  type ServerMessage,
} from "@mmo/shared";
import { WS_URL } from "./config";
import { Connection } from "./net/connection";
import { Replication, type NetEntity } from "./net/replication";
import { Prediction } from "./net/prediction";
import { createScene } from "./render/scene";
import { TerrainMesh } from "./render/terrain";
import { Effects } from "./render/effects";
import { EntityViews } from "./render/entityViews";
import { Input } from "./input/input";
import { UI, type CooldownState } from "./ui/ui";
import { AudioEngine } from "./audio/audio";

const TAB_TARGET_RANGE = 40;

const ui = new UI();
const { renderer, scene, camera } = createScene(document.getElementById("app")!);
const input = new Input(renderer.domElement);
const repl = new Replication();
const pred = new Prediction();
const terrainMesh = new TerrainMesh(scene); // flat until welcome delivers the real heightmap
const views = new EntityViews(scene);
views.groundHeight = (x, z) => heightAt(terrainMesh.terrain, x, z);
const effects = new Effects(scene);
effects.positionOf = (id) => views.positionOf(id);
const audio = new AudioEngine();
views.onFootstep = (id, x, z, running) => audio.playFootstep(x, z, running);
views.onJump = (id, x, z) => audio.playJump(x, z);
views.onLand = (id, x, z) => audio.playLand(x, z);
// Audio needs a real user gesture before browsers allow sound.
window.addEventListener("pointerdown", () => audio.unlock(), { once: true });
window.addEventListener("keydown", () => audio.unlock(), { once: true });
const raycaster = new THREE.Raycaster();

let conn: Connection | null = null;
let joined = false;
let target = 0;
const cooldowns = new Map<string, CooldownState>();
let colliderRadii: Record<string, number> = {};

type QuestStateMsg = Extract<ServerMessage, { t: "questState" }>;
let questState: QuestStateMsg | null = null;

/** Quest content arrives from the server (questDefs) — the world data owns it. */
let questsById: Record<string, QuestDef> = {};
/** NPC kinds worth an F-press: anyone who gives or takes a quest. */
let questNpcKinds = new Set<string>();

/** Mirror of the server's prop collider list, limited to streamed-in props. */
function rebuildColliders(): void {
  const colliders: CircleCollider[] = [];
  for (const e of repl.entities.values()) {
    if (!e.propTag || !e.transform || !e.modelRef) continue;
    const base = colliderRadii[e.modelRef.model];
    if (base === undefined) continue;
    colliders.push({
      id: e.id,
      x: e.transform.pos.x,
      z: e.transform.pos.z,
      r: base * e.modelRef.scale,
    });
  }
  colliders.sort((a, b) => a.id - b.id);
  pred.setColliders(colliders);
}

repl.onAdded = (e: NetEntity) => {
  views.add(e);
  if (e.propTag) rebuildColliders();
  if (e.id === repl.selfId) {
    if (e.transform) pred.reset(e.transform.pos.x, e.transform.pos.z);
    if (e.health) ui.setHp(e.health.hp, e.health.maxHp);
  }
};
repl.onRemoved = (id: number) => {
  views.remove(id);
  rebuildColliders();
  if (id === target) clearTarget();
  // Entity is gone (died, despawned, or left AOI) — nothing will ever send
  // the castEvent "done"/"interrupted" to stop a drone it was mid-cast on.
  audio.stopCastLoop(id, false);
};
repl.onChanged = (e: NetEntity, names: string[]) => {
  views.changed(e, names);
  if (e.propTag) rebuildColliders();
  if (e.id === repl.selfId && names.includes("health") && e.health) {
    ui.setHp(e.health.hp, e.health.maxHp);
  }
};

// ---------------------------------------------------------------------------
// Targeting

function clearTarget(): void {
  target = 0;
  ui.setTarget(null);
  views.setTarget(null);
}

function setTargetTo(e: NetEntity): void {
  target = e.id;
  ui.setTarget(e.playerTag?.name ?? e.npcTag?.kind ?? `#${e.id}`);
  views.setTarget(e.id);
}

/** Tab cycles living NPCs near the player, nearest first. */
function cycleTarget(): void {
  if (!joined) return;
  const rangeSq = TAB_TARGET_RANGE * TAB_TARGET_RANGE;
  const candidates = [...repl.entities.values()]
    .filter(
      (e) =>
        e.id !== repl.selfId &&
        e.npcTag &&
        e.health &&
        e.health.hp > 0 &&
        e.transform &&
        distSq(e.transform.pos.x, e.transform.pos.z, pred.x, pred.z) <= rangeSq,
    )
    .sort((a, b) => {
      const da = distSq(a.transform!.pos.x, a.transform!.pos.z, pred.x, pred.z);
      const db = distSq(b.transform!.pos.x, b.transform!.pos.z, pred.x, pred.z);
      return da - db;
    });
  if (candidates.length === 0) return;
  const idx = candidates.findIndex((e) => e.id === target);
  setTargetTo(candidates[(idx + 1) % candidates.length]);
}

input.onTab = cycleTarget;
input.onEscape = () => {
  if (ui.isQuestDialogOpen) {
    ui.hideQuestDialog();
  } else if (ui.isQuestLogOpen) {
    ui.hideQuestLog();
  } else {
    clearTarget();
  }
};
input.onClickAt = (x, y) => {
  if (!joined) return;
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const id = views.entityAt(raycaster, (id) => {
    const e = repl.entities.get(id);
    return !!e && e.id !== repl.selfId && !!e.health && !e.propTag;
  });
  const e = id ? repl.entities.get(id) : undefined;
  if (e) {
    setTargetTo(e);
    tryTalkTo(e);
  } else {
    clearTarget();
  }
};

/**
 * Dark Souls-style boss frame: shown for a nearby living boss that you're
 * targeting or that's already in a fight (hp below max).
 */
const BOSS_BAR_RANGE = 45;
function updateBossBar(): void {
  let boss: NetEntity | null = null;
  for (const e of repl.entities.values()) {
    if (!e.npcTag?.boss || !e.health || e.health.hp <= 0 || !e.transform) continue;
    if (e.id !== target && e.health.hp >= e.health.maxHp) continue;
    if (
      distSq(e.transform.pos.x, e.transform.pos.z, pred.x, pred.z) >
      BOSS_BAR_RANGE * BOSS_BAR_RANGE
    ) {
      continue;
    }
    boss = e;
    break;
  }
  if (boss) ui.setBossBar(boss.npcTag!.kind, boss.health!.hp, boss.health!.maxHp);
  else ui.setBossBar(null);
}

/** Clicking a quest NPC in range talks to them, same as pressing F. */
function tryTalkTo(e: NetEntity): void {
  if (!conn || !e.npcTag || !questNpcKinds.has(e.npcTag.kind) || !e.transform) return;
  const rangeSq = INTERACT_RANGE * INTERACT_RANGE;
  if (distSq(e.transform.pos.x, e.transform.pos.z, pred.x, pred.z) <= rangeSq) {
    conn.send({ t: "interact", npc: e.id });
  }
}

// ---------------------------------------------------------------------------
// Abilities

function useAbility(id: string): void {
  const def = ABILITIES[id];
  if (!def || !joined || !conn) return;
  const now = performance.now();
  if ((cooldowns.get(id)?.until ?? 0) > now) return;

  const tgt = def.targetSelf ? repl.selfId : target;
  if (!tgt || (!def.targetSelf && !repl.entities.has(tgt))) {
    ui.addSystem("No target — press Tab or click an enemy.");
    audio.playAbilityFail();
    return;
  }
  conn.send({ t: "attack", target: tgt, ability: id });
  // Optimistic; refunded if the server sends abilityFail.
  cooldowns.set(id, { until: now + def.cooldownMs, total: def.cooldownMs });
  views.playAttack(repl.selfId);
  audio.playAbilityUse(id);
}

input.onAbility = (slot) => {
  const id = ABILITY_BAR[slot];
  if (id) useAbility(id);
};
ui.setupAbilityBar(
  ABILITY_BAR.map((id) => ABILITIES[id]),
  useAbility,
);

ui.setupChat((channel, text) => conn?.send({ t: "chat", channel, text }));

// ---------------------------------------------------------------------------
// Quests

/** F interacts with the nearest quest NPC in range; the server re-validates. */
input.onInteract = () => {
  if (!joined || !conn) return;
  const rangeSq = INTERACT_RANGE * INTERACT_RANGE;
  let best: NetEntity | null = null;
  let bestD = Infinity;
  for (const e of repl.entities.values()) {
    if (!e.npcTag || !questNpcKinds.has(e.npcTag.kind)) continue;
    if (!e.health || e.health.hp <= 0 || !e.transform) continue;
    const d = distSq(e.transform.pos.x, e.transform.pos.z, pred.x, pred.z);
    if (d <= rangeSq && d < bestD) {
      best = e;
      bestD = d;
    }
  }
  if (best) conn.send({ t: "interact", npc: best.id });
};

input.onQuestLog = () => {
  if (questState) ui.renderQuestLog(questState);
  ui.toggleQuestLog();
};

ui.setupQuestLog((questId) => conn?.send({ t: "questAbandon", questId }));

/**
 * "!" over NPCs with a quest to offer; "?" over NPCs you need to talk to
 * (unfinished talk objectives) and NPCs ready for a turn-in.
 */
function computeQuestMarkers(state: QuestStateMsg): Map<string, string> {
  const markers = new Map<string, string>();
  for (const def of Object.values(questsById)) {
    const offered =
      !state.completed.includes(def.id) &&
      !state.active.some((q) => q.questId === def.id) &&
      (!def.prereq || state.completed.includes(def.prereq));
    if (offered) markers.set(def.giverKind, "!");
  }
  for (const qp of state.active) {
    const def = questsById[qp.questId];
    if (!def) continue;
    def.objectives.forEach((obj, i) => {
      if (obj.type === "talk" && !isObjectiveDone(obj, qp.progress[i] ?? 0)) {
        markers.set(obj.npcKind, "?");
      }
    });
    if (isQuestComplete(def, qp)) markers.set(def.turnInKind, "?");
  }
  return markers;
}

/** Chat notices from diffing the previous full quest state against the new one. */
function printQuestNotices(prev: QuestStateMsg | null, next: QuestStateMsg): void {
  if (!prev) return; // initial sync on join
  for (const qp of next.active) {
    const def = questsById[qp.questId];
    if (!def) continue;
    const old = prev.active.find((q) => q.questId === qp.questId);
    if (!old) {
      ui.addSystem(`Quest accepted: ${def.name}`);
      audio.playQuestAccept();
      continue;
    }
    def.objectives.forEach((obj, i) => {
      const was = old.progress[i] ?? 0;
      const now = qp.progress[i] ?? 0;
      if (now <= was) return;
      if (isObjectiveDone(obj, now)) {
        ui.addSystem(`Objective complete: ${obj.label}`);
        audio.playObjectiveTick();
      } else {
        ui.addSystem(`${obj.label}: ${now}/${objectiveTarget(obj)}`);
      }
    });
  }
  for (const id of next.completed) {
    if (prev.completed.includes(id)) continue;
    const def = questsById[id];
    if (def) {
      ui.addSystem(`Quest complete: ${def.name} (+${def.xpReward} XP)`);
      audio.playQuestComplete();
    }
  }
  if (next.level > prev.level) {
    ui.addSystem(`Level up! You are now level ${next.level}.`);
    audio.playLevelUp();
  }
}

// ---------------------------------------------------------------------------
// Connection

async function join(): Promise<void> {
  const name = await ui.askName();
  if (!conn) {
    conn = new Connection(WS_URL);
    try {
      await conn.ready;
    } catch {
      conn = null;
      ui.showJoinError("Cannot reach server — is it running on :8080?");
      return join();
    }
    wireHandlers(conn);
  }
  conn.send({ t: "join", name });
}

function wireHandlers(c: Connection): void {
  c.on("welcome", (m) => {
    repl.selfId = m.entityId;
    pred.setBounds(m.bounds);
    colliderRadii = m.colliderRadii ?? {};
    const terrain = terrainFromJSON(m.terrain);
    if (terrain) {
      terrainMesh.setData(terrain);
      pred.setTerrain(terrain);
    }
    joined = true;
    ui.hideJoin();
    ui.addSystem(
      "Connected. W/S move, A/D turn, Tab targets, 1-5 abilities, F interacts, L quest log, Enter chats.",
    );
  });
  c.on("error", (m) => {
    if (!joined) {
      ui.showJoinError(m.message);
      void join();
    } else {
      ui.addSystem(m.message);
    }
  });
  c.on("spawn", (m) => repl.applySpawn(m.entities));
  c.on("despawn", (m) => repl.applyDespawn(m.ids));
  c.on("delta", (m) => repl.applyDelta(m.entities));
  c.on("inputAck", (m) => pred.ack(m.seq, m.x, m.z, m.y, m.vy));
  c.on("chatMsg", (m) => ui.addChat(m.channel, m.from, m.text));
  c.on("combatEvent", (m) => {
    for (const ev of m.events) {
      if (ev.damage > 0) views.pulse(ev.target);
      if (ev.attacker !== repl.selfId) views.playAttack(ev.attacker);
      effects.onCombatEvent(ev, views.positionOf(ev.attacker), views.positionOf(ev.target));
      audio.onCombatEvent(
        ev,
        views.positionOf(ev.target),
        repl.selfId,
        !!repl.entities.get(ev.target)?.npcTag,
      );
      if (ev.died && ev.target === target) clearTarget();
    }
  });
  c.on("castEvent", (m) => {
    for (const ev of m.events) {
      const def = ABILITIES[ev.ability];
      if (ev.phase === "start") {
        views.startCast(ev.caster, ev.ability, ev.durationMs);
        effects.startChannel(ev.caster, def?.fx.color ?? 0xffffff, ev.durationMs);
        const pos = views.positionOf(ev.caster);
        if (pos) audio.startCastLoop(ev.caster, ev.ability, pos);
      } else {
        views.endCast(ev.caster, ev.phase === "interrupted");
        effects.stopChannel(ev.caster);
        audio.stopCastLoop(ev.caster, ev.phase === "interrupted");
        if (ev.phase === "interrupted" && ev.by === repl.selfId) {
          const caster = repl.entities.get(ev.caster);
          const who = caster?.npcTag?.kind ?? caster?.playerTag?.name ?? "the enemy";
          ui.addSystem(`You interrupted ${who}'s ${def?.name ?? ev.ability}!`);
        }
      }
    }
  });
  c.on("abilityFail", (m) => {
    cooldowns.delete(m.ability); // refund the optimistic cooldown
    ui.addSystem(`${ABILITIES[m.ability]?.name ?? m.ability}: ${m.reason}`);
    audio.playAbilityFail();
  });
  c.on("death", () => {
    ui.showDeath();
    audio.playPlayerDeathSelf();
    clearTarget();
  });
  c.on("terrainPatch", (m) => {
    // Live edit from the world editor: mutate the shared data (prediction
    // reads the same object), re-upload the mesh, re-seat grounded feet.
    if (applyTerrainPatch(terrainMesh.terrain, m.patch)) {
      terrainMesh.refresh();
      pred.resnapToGround();
    }
  });
  c.on("questDefs", (m) => {
    questsById = questIndex(m.quests);
    // Anyone you can meaningfully talk to: givers, turn-ins, and the targets
    // of talk objectives (which may be neither).
    questNpcKinds = new Set(
      m.quests.flatMap((q) => [
        q.giverKind,
        q.turnInKind,
        ...q.objectives.flatMap((o) => (o.type === "talk" ? [o.npcKind] : [])),
      ]),
    );
    ui.setQuestDefs(questsById);
    // Re-render anything content-dependent (defs can change mid-session).
    if (questState) {
      ui.renderQuestLog(questState);
      views.setQuestMarkers(computeQuestMarkers(questState), repl.entities.values());
    }
  });
  c.on("questState", (m) => {
    printQuestNotices(questState, m);
    questState = m;
    ui.setXp(m.xp);
    ui.renderQuestLog(m);
    views.setQuestMarkers(computeQuestMarkers(m), repl.entities.values());
  });
  c.on("questDialog", (m) => {
    ui.showQuestDialog(m, {
      onAccept: (questId) => conn?.send({ t: "questAccept", questId, npc: m.npc }),
      onTurnIn: (questId) => conn?.send({ t: "questTurnIn", questId, npc: m.npc }),
    });
  });
  c.onClose = () => {
    joined = false;
    ui.addSystem("Disconnected from server.");
    ui.showJoinError("Disconnected — refresh the page to reconnect.");
  };
}

// ---------------------------------------------------------------------------
// Game loop

let last = performance.now();
let acc = 0;
let moving = false;

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = now - last;
  last = now;
  if (dt > 250) dt = 250;

  if (joined && conn) {
    acc += dt;
    while (acc >= TICK_MS) {
      const s = input.sample();
      moving = s.moveX !== 0 || s.moveZ !== 0;
      conn.send(pred.applyInput(s.moveX, s.moveZ, s.facing, s.jump, TICK_MS));
      acc -= TICK_MS;
    }
  }

  // Render the local player partway through the current tick so movement is
  // per-frame smooth instead of stepping at the 20 Hz input rate.
  const self = pred.renderPos(acc / TICK_MS);
  views.update(repl, self, now);
  effects.update(dt);
  audio.setListener(self.x, self.z);

  // WoW camera: orbits the player opposite the look direction; drifts back
  // behind the character while moving unless a mouse button is held.
  input.updateCamera(dt, moving);
  const horiz = Math.cos(input.pitch) * input.dist;
  camera.position.set(
    self.x - Math.sin(input.camYaw) * horiz,
    self.y + Math.sin(input.pitch) * input.dist + 1.6,
    self.z - Math.cos(input.camYaw) * horiz,
  );
  camera.lookAt(self.x, self.y + 1.4, self.z);

  ui.renderCooldowns(now, cooldowns);
  updateBossBar();
  renderer.render(scene, camera);
}

frame();
void join();
