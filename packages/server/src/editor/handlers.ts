import {
  ModelRef,
  NpcAi,
  NpcTag,
  PlayerTag,
  Transform,
  Velocity,
  applyTerrainPatch,
  heightAt,
  npcIndex,
  questIndex,
  sanitizeNpcDefs,
  sanitizeQuestDefs,
  sanitizeQuestState,
  terrainToJSON,
  type EditorMessage,
  type PropDef,
  type SpawnerDef,
  type Vec3,
} from "@mmo/shared";
import { playerSessions, rebuildPropColliders, type GameCtx, type Session } from "../state";
import { newId, spawnNpc, spawnProp } from "../game/spawn";
import { sendQuestState } from "../game/quests";
import { saveWorldDef } from "../persistence/worldLoader";

const EDITOR_TOKEN = process.env.EDITOR_TOKEN ?? "dev";

function broadcastWorldState(ctx: GameCtx): void {
  for (const s of ctx.sessions) {
    if (s.isEditor) s.send({ t: "editor:worldState", def: ctx.def });
  }
}

/** Editor positions arrive with arbitrary y; everything sits on the terrain. */
function grounded(ctx: GameCtx, pos: Vec3): Vec3 {
  return { x: pos.x, y: heightAt(ctx.terrain, pos.x, pos.z), z: pos.z };
}

/**
 * After a terrain edit, re-seat everything standing on it: prop defs and
 * entities, NPCs, and grounded players (mid-jump players land on the new
 * ground on their own; prediction re-converges via the next inputAck).
 */
function resnapToTerrain(ctx: GameCtx): void {
  const { world } = ctx;
  for (const def of ctx.def.props) {
    const y = heightAt(ctx.terrain, def.pos.x, def.pos.z);
    if (def.pos.y === y) continue;
    def.pos.y = y;
    const entity = ctx.propEntities.get(def.id);
    if (entity) {
      world.require(entity, Transform).pos.y = y;
      world.markDirty(entity, Transform);
    }
  }
  for (const def of ctx.def.spawners) {
    def.pos.y = heightAt(ctx.terrain, def.pos.x, def.pos.z);
  }
  ctx.def.spawnPoint = grounded(ctx, ctx.def.spawnPoint);
  for (const e of world.query(Transform)) {
    if (!world.has(e, NpcTag) && !world.has(e, PlayerTag)) continue;
    const vel = world.get(e, Velocity);
    if (vel && vel.y !== 0) continue; // airborne player: gravity will land them
    const tr = world.require(e, Transform);
    const y = heightAt(ctx.terrain, tr.pos.x, tr.pos.z);
    if (tr.pos.y !== y) {
      tr.pos.y = y;
      world.markDirty(e, Transform);
    }
  }
}

/** Destroy a spawner's live NPCs and cancel its pending respawns. */
function despawnSpawnerNpcs(ctx: GameCtx, spawnerId: string): void {
  const npcs = ctx.npcsBySpawner.get(spawnerId);
  if (npcs) {
    for (const e of npcs) ctx.world.destroy(e);
    ctx.npcsBySpawner.delete(spawnerId);
  }
  ctx.npcRespawns = ctx.npcRespawns.filter((r) => r.spawnerId !== spawnerId);
}

export function handleEditorMessage(ctx: GameCtx, session: Session, msg: EditorMessage): void {
  if (msg.t === "editor:auth") {
    if (msg.token === EDITOR_TOKEN) {
      session.isEditor = true;
      session.send({ t: "editor:authOk" });
      // Terrain rides along only here; later worldState broadcasts omit the
      // ~180KB blob and editors keep their patch-updated local copy.
      session.send({
        t: "editor:worldState",
        def: { ...ctx.def, terrain: terrainToJSON(ctx.terrain) },
      });
    } else {
      session.send({ t: "error", message: "Invalid editor token." });
    }
    return;
  }

  if (!session.isEditor) {
    session.send({ t: "error", message: "Not authenticated as editor." });
    return;
  }

  switch (msg.t) {
    case "editor:placeProp": {
      const def: PropDef = {
        id: newId("prop"),
        model: msg.model,
        pos: grounded(ctx, msg.pos),
        rotY: msg.rotY,
        scale: msg.scale || 1,
      };
      ctx.def.props.push(def);
      spawnProp(ctx, def);
      rebuildPropColliders(ctx);
      break;
    }
    case "editor:updateProp": {
      const def = ctx.def.props.find((p) => p.id === msg.propId);
      const entity = ctx.propEntities.get(msg.propId);
      if (!def || !entity) return;
      def.pos = grounded(ctx, msg.pos);
      def.rotY = msg.rotY;
      def.scale = msg.scale || 1;
      if (typeof msg.model === "string" && msg.model) def.model = msg.model;
      const tr = ctx.world.require(entity, Transform);
      tr.pos = { ...def.pos };
      tr.rotY = msg.rotY;
      const modelRef = ctx.world.require(entity, ModelRef);
      modelRef.scale = def.scale;
      modelRef.model = def.model;
      ctx.world.markDirty(entity, Transform);
      ctx.world.markDirty(entity, ModelRef);
      rebuildPropColliders(ctx);
      break;
    }
    case "editor:deleteProp": {
      const idx = ctx.def.props.findIndex((p) => p.id === msg.propId);
      if (idx === -1) return;
      ctx.def.props.splice(idx, 1);
      const entity = ctx.propEntities.get(msg.propId);
      if (entity) {
        ctx.world.destroy(entity);
        ctx.propEntities.delete(msg.propId);
      }
      rebuildPropColliders(ctx);
      break;
    }
    case "editor:placeSpawner": {
      const def: SpawnerDef = {
        id: newId("spawner"),
        kind: msg.kind || "goblin",
        model: msg.model || "goblin",
        pos: grounded(ctx, msg.pos),
        count: Math.max(1, Math.min(10, Math.floor(msg.count) || 1)),
        respawnMs: Math.max(1000, Math.floor(msg.respawnMs) || 10000),
        aggroRadius: Math.max(0, typeof msg.aggroRadius === "number" ? msg.aggroRadius : 10),
      };
      ctx.def.spawners.push(def);
      for (let i = 0; i < def.count; i++) spawnNpc(ctx, def);
      break;
    }
    case "editor:updateSpawner": {
      const def = ctx.def.spawners.find((s) => s.id === msg.spawnerId);
      if (!def) return;
      def.pos = grounded(ctx, msg.pos);
      if (typeof msg.respawnMs === "number") def.respawnMs = Math.max(1000, Math.floor(msg.respawnMs));
      if (typeof msg.aggroRadius === "number") def.aggroRadius = Math.max(0, msg.aggroRadius);
      const repopulate =
        (typeof msg.kind === "string" && msg.kind.trim() && msg.kind.trim() !== def.kind) ||
        (typeof msg.model === "string" && msg.model && msg.model !== def.model) ||
        (typeof msg.count === "number" && Math.floor(msg.count) !== def.count);
      if (typeof msg.kind === "string" && msg.kind.trim()) def.kind = msg.kind.trim();
      if (typeof msg.model === "string" && msg.model) def.model = msg.model;
      if (typeof msg.count === "number") def.count = Math.max(1, Math.min(10, Math.floor(msg.count) || 1));
      if (repopulate) {
        // Kind/model/count changes need fresh NPCs.
        despawnSpawnerNpcs(ctx, def.id);
        for (let i = 0; i < def.count; i++) spawnNpc(ctx, def);
      } else {
        // Re-home live NPCs; they'll walk over on their own.
        for (const e of ctx.npcsBySpawner.get(def.id) ?? []) {
          const ai = ctx.world.get(e, NpcAi);
          if (!ai) continue;
          ai.home = { ...msg.pos };
          ai.aggroRadius = def.aggroRadius;
          ai.leashRadius = Math.max(def.aggroRadius * 2.5, 15);
        }
      }
      break;
    }
    case "editor:deleteSpawner": {
      const idx = ctx.def.spawners.findIndex((s) => s.id === msg.spawnerId);
      if (idx === -1) return;
      ctx.def.spawners.splice(idx, 1);
      despawnSpawnerNpcs(ctx, msg.spawnerId);
      break;
    }
    case "editor:setSpawnPoint": {
      ctx.def.spawnPoint = grounded(ctx, msg.pos);
      break;
    }
    case "editor:terrain": {
      if (!applyTerrainPatch(ctx.terrain, msg.patch)) return;
      resnapToTerrain(ctx);
      // Rebroadcast the patch instead of the whole world; skip the sender,
      // whose local copy is already ahead of this patch.
      for (const s of ctx.sessions) {
        if (s !== session && (s.isEditor || s.entityId)) {
          s.send({ t: "terrainPatch", patch: msg.patch });
        }
      }
      return;
    }
    case "editor:setNpcs": {
      ctx.def.npcs = sanitizeNpcDefs(msg.npcs);
      ctx.npcsByKind = npcIndex(ctx.def.npcs);
      // Live NPCs carry stats baked in at spawn; repopulate every spawner so
      // hp/model/kit changes take effect immediately.
      for (const spawner of ctx.def.spawners) {
        despawnSpawnerNpcs(ctx, spawner.id);
        for (let i = 0; i < spawner.count; i++) spawnNpc(ctx, spawner);
      }
      break;
    }
    case "editor:setQuests": {
      ctx.def.quests = sanitizeQuestDefs(msg.quests);
      ctx.questsById = questIndex(ctx.def.quests);
      // Re-validate every online player's progress against the new content
      // and push the fresh definitions + state to them.
      for (const s of playerSessions(ctx)) {
        s.quests = sanitizeQuestState(s.quests, ctx.questsById);
        s.send({ t: "questDefs", quests: ctx.def.quests });
        sendQuestState(s);
      }
      break;
    }
    case "editor:save": {
      saveWorldDef({ ...ctx.def, terrain: terrainToJSON(ctx.terrain) });
      session.send({ t: "editor:saved" });
      console.log("world saved by editor");
      return;
    }
  }

  broadcastWorldState(ctx);
}
